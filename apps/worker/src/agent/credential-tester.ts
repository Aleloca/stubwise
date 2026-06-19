import { aiProviders, decrypt, type Db } from "@stubwise/db";
import { asc, eq, sql } from "drizzle-orm";
import type { ResolvedProvider } from "../providers/chain.js";
import { ClaudeCliRunner } from "./claude-cli.js";
import type { AgentRunner } from "./runner.js";

/**
 * Tester delle credenziali dei provider AI: il SERVER non può lanciare `claude`
 * (non è installato nella sua immagine), quindi la verifica "vera" di una
 * credenziale — sia `api_key` sia `account` — la esegue il WORKER, l'unico che
 * shella sul CLI. Il meccanismo è un piccolo job su DB:
 *
 *  1. l'admin clicca "Test" → il server marca la riga `test_status = 'pending'`
 *     e valorizza `test_requested_at` (vedi POST /:id/test);
 *  2. questo tester, in un task SEPARATO dal loop dei job (sul proprio
 *     intervallo, come l'usage-poller), raccoglie le richieste `pending`,
 *     decifra la secret, esegue un `claude -p` MINIMALE (nessun repo, 1 turno,
 *     timeout breve) iniettando la credenziale secondo il `kind` e scrive
 *     l'esito (`passed`/`failed` + `test_error`);
 *  3. il server espone lo stato via la proiezione pubblica; la UI fa polling.
 *
 * Vincoli (CRITICI):
 *  - NON deve MAI far crashare il worker: ogni richiesta è in un try/catch
 *    isolato; un fallimento marca QUELLA riga `failed` e prosegue con le altre.
 *  - È un task SEPARATO dal loop dei job: NON tocca il lock/heartbeat dei job
 *    né i loro timeout (nessun impatto sull'invariante WORKER_STALE_MINUTES).
 *  - Il segreto non viene MAI loggato né scritto in `test_error`.
 *  - Testa ANCHE le credenziali disabilitate: l'admin vuole sapere se una
 *    credenziale funziona prima di abilitarla nella catena. Per questo NON usa
 *    loadProviderChain (che filtra su enabled) ma legge le righe `pending`.
 *
 * Il test è una scrittura MINIMA: `claude -p` con un prompt che chiede solo
 * "reply with OK", 1 turno e timeout breve. Consuma una manciata di token
 * (api_key) o una frazione irrisoria della quota (account), ma è l'unico modo
 * di validare DAVVERO l'autenticazione con lo stesso percorso della pipeline.
 */

/** Prompt minimale: una sola risposta, nessuna azione. */
const TEST_PROMPT = "Reply with the single word OK and nothing else.";
/** Modello economico per il test (haiku): il test è una verifica di auth, non di capacità. */
const TEST_MODEL = "haiku";
const TEST_MAX_TURNS = 1;
const TEST_TIMEOUT_MS = 60_000;
/** Tetto del messaggio d'errore salvato (evita blob enormi in DB/UI). */
const MAX_ERROR_LEN = 2000;

export interface RunCredentialTestsDeps {
  db: Db;
  encryptionKey: Buffer;
  /** Runner del CLI claude (iniettabile per i test). Default: ClaudeCliRunner. */
  runner?: AgentRunner;
}

/**
 * Esegue UN giro di test: per ogni provider con `test_status = 'pending'`
 * (ordinato per `test_requested_at`) decifra la secret, lancia un `claude -p`
 * di prova e scrive l'esito. Non lancia mai: errori per-credenziale sono
 * catturati e marcano quella riga `failed`.
 */
export async function runCredentialTestsOnce(deps: RunCredentialTestsDeps): Promise<void> {
  const runner = deps.runner ?? new ClaudeCliRunner();

  let pending: {
    id: string;
    kind: "api_key" | "account";
    secretEncrypted: string;
  }[];
  try {
    pending = await deps.db
      .select({
        id: aiProviders.id,
        kind: aiProviders.kind,
        secretEncrypted: aiProviders.secretEncrypted,
      })
      .from(aiProviders)
      .where(eq(aiProviders.testStatus, "pending"))
      .orderBy(asc(aiProviders.testRequestedAt));
  } catch (err) {
    console.error(`[stubwise-worker] credential-test: impossibile leggere le richieste: ${errText(err)}`);
    return;
  }

  for (const provider of pending) {
    try {
      await testOne(deps, runner, provider);
    } catch (err) {
      // Difesa finale: una richiesta non deve mai bloccare le altre. L'errore
      // qui è già stato (provato a) registrare in testOne; logghiamo e basta.
      console.error(`[stubwise-worker] credential-test: ${provider.id} saltata: ${errText(err)}`);
    }
  }
}

async function testOne(
  deps: RunCredentialTestsDeps,
  runner: AgentRunner,
  provider: { id: string; kind: "api_key" | "account"; secretEncrypted: string },
): Promise<void> {
  // Secret non decifrabile (ENCRYPTION_KEY errata o payload manomesso): è un
  // fallimento legittimo del test, non un errore del runner. Mai loggare il payload.
  let secret: string;
  try {
    secret = decrypt(provider.secretEncrypted, deps.encryptionKey);
  } catch {
    await writeResult(deps.db, provider.id, false, "Secret could not be decrypted (encryption_key mismatch or corrupted payload).");
    return;
  }

  const resolved: ResolvedProvider = { id: provider.id, kind: provider.kind, secret };

  let passed: boolean;
  let error: string | null;
  try {
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: TEST_PROMPT,
      model: TEST_MODEL,
      permissionMode: "default",
      maxTurns: TEST_MAX_TURNS,
      timeoutMs: TEST_TIMEOUT_MS,
      provider: resolved,
    });
    // Exit 0 = autenticazione riuscita e risposta prodotta. Exit non-zero =
    // credenziale rifiutata (o altro errore del CLI): l'output del CLI è il
    // messaggio diagnostico, troncato e sanitizzato dal segreto.
    passed = result.exitCode === 0;
    error = passed ? null : sanitize(result.output, secret);
  } catch (err) {
    // Spawn fallito / timeout / opzioni invalide: il test non è andato a buon
    // fine. Mai il segreto nel messaggio.
    passed = false;
    error = sanitize(errText(err), secret);
  }

  await writeResult(deps.db, provider.id, passed, error);
}

/**
 * Scrive l'esito sul provider (UPDATE per-id). Se la riga è stata eliminata nel
 * frattempo, l'UPDATE non tocca nulla. NON è status-guarded: se l'admin rilancia
 * il test mentre un giro è in corso, l'esito appena calcolato può sovrascrivere
 * il nuovo `pending` — race benigna e auto-recuperabile (è la STESSA credenziale,
 * quindi l'esito è identico; un nuovo click ripristina comunque il pending).
 * Best-effort: un errore di scrittura non deve propagare.
 */
async function writeResult(
  db: Db,
  id: string,
  passed: boolean,
  error: string | null,
): Promise<void> {
  try {
    await db
      .update(aiProviders)
      .set({
        testStatus: passed ? "passed" : "failed",
        testCheckedAt: sql`now()`,
        testError: passed ? null : error,
      })
      .where(eq(aiProviders.id, id));
  } catch (err) {
    console.error(`[stubwise-worker] credential-test: impossibile scrivere l'esito di ${id}: ${errText(err)}`);
  }
}

/**
 * Sanitizza un messaggio destinato a `test_error` / UI: tronca a MAX_ERROR_LEN
 * e rimuove ogni occorrenza del segreto (difesa in profondità: il CLII non
 * dovrebbe stampare la chiave, ma non ci fidiamo dell'output non controllato).
 */
function sanitize(message: string, secret: string): string {
  let out = message;
  if (secret.length > 0) out = out.split(secret).join("***");
  out = out.trim();
  if (out.length === 0) out = "Credential test failed (no diagnostic output).";
  return out.length > MAX_ERROR_LEN ? `${out.slice(0, MAX_ERROR_LEN)}…` : out;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface StartCredentialTesterOptions {
  db: Db;
  encryptionKey: Buffer;
  /** Intervallo di poll in millisecondi. ≤ 0 = disabilitato (non avvia nulla). */
  intervalMs: number;
  signal: AbortSignal;
}

/**
 * Avvia il tester su un proprio setInterval, separato dal loop dei job (come
 * l'usage-poller). Ad ogni tick raccoglie ed esegue le richieste `pending`. Lo
 * stop avviene sull'AbortSignal (lo stesso del worker). Ritorna una funzione di
 * stop idempotente. intervalMs ≤ 0 = disabilitato.
 */
export function startCredentialTester(opts: StartCredentialTesterOptions): () => void {
  if (opts.intervalMs <= 0) {
    return () => {};
  }
  let running = false;

  const tick = async (): Promise<void> => {
    // Evita sovrapposizioni se un giro è più lento dell'intervallo.
    if (running) return;
    running = true;
    try {
      await runCredentialTestsOnce({ db: opts.db, encryptionKey: opts.encryptionKey });
    } catch (err) {
      // Difesa finale: un tick non deve mai propagare.
      console.error(`[stubwise-worker] credential-test: tick fallito: ${errText(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, opts.intervalMs);
  // Non tenere vivo il processo solo per il tester.
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
