import { aiUsageSnapshots, type Db } from "@stubwise/db";
import { loadProviderChain, type ResolvedProvider } from "../providers/chain.js";
import { ClaudeCliRunner } from "./claude-cli.js";
import { captureUsageOutput } from "./usage-pty.js";
import { parseUsage, type RunLlm } from "./usage-parser.js";

/**
 * Scheduler BEST-EFFORT che, periodicamente, legge l'utilizzo residuo
 * dell'abbonamento di ogni credenziale `account` della catena via il comando
 * `/usage` (PTY, vedi usage-pty.ts), ne parsa l'output (deterministico →
 * fallback LLM, vedi usage-parser.ts) e salva uno snapshot in
 * `ai_usage_snapshots`.
 *
 * Vincoli (CRITICI):
 *  - NON deve MAI far crashare il worker: ogni credenziale è in un try/catch
 *    isolato; un fallimento (PTY, parse, insert) salta quella credenziale e
 *    prosegue con le altre. L'intero giro è a sua volta in try/catch.
 *  - È un task SEPARATO dal loop dei job: gira su un proprio setInterval, NON
 *    tocca il lock/heartbeat dei job né i loro timeout (nessun impatto
 *    sull'invariante WORKER_STALE_MINUTES).
 *  - `/usage` è una lettura GRATUITA (non consuma token dell'abbonamento).
 *  - Il fallback LLM usa un modello economico (haiku) preferendo una
 *    credenziale `api_key` della catena, per NON intaccare la quota
 *    dell'abbonamento di cui stiamo misurando il residuo.
 *  - I segreti non vengono MAI loggati.
 */

/** Modello economico per il fallback LLM. */
const LLM_FALLBACK_MODEL = "haiku";
/** Tetto di turni/tempo per la chiamata LLM di parsing (è una mini-estrazione). */
const LLM_MAX_TURNS = 1;
const LLM_TIMEOUT_MS = 60_000;

export interface PollUsageDeps {
  db: Db;
  encryptionKey: Buffer;
  /** Cattura l'output `/usage` di una credenziale (iniettabile per i test). */
  capture: (provider: ResolvedProvider) => Promise<string>;
  /** Esegue la chiamata LLM di parsing di fallback (iniettabile per i test). */
  runLlm: RunLlm;
}

/**
 * Esegue UN giro di polling: per ogni credenziale `account` abilitata della
 * catena cattura `/usage`, parsa e salva uno snapshot. `rawText` è conservato
 * SOLO quando parseOk=false (per diagnosticare il parser da aggiornare). Un
 * parse che non produce snapshot (né deterministico né LLM) NON salva nulla.
 * Non lancia mai: errori per-credenziale sono loggati (senza segreti) e saltati.
 */
export async function pollUsageOnce(deps: PollUsageDeps): Promise<void> {
  let chain: ResolvedProvider[];
  try {
    chain = await loadProviderChain(deps.db, deps.encryptionKey);
  } catch (err) {
    console.error(
      `[stubwise-worker] usage-poll: impossibile caricare la catena provider: ${errText(err)}`,
    );
    return;
  }

  const accounts = chain.filter((p) => p.kind === "account");
  for (const provider of accounts) {
    try {
      await pollOneAccount(deps, provider);
    } catch (err) {
      // Best-effort: un fallimento non blocca le altre credenziali.
      console.error(
        `[stubwise-worker] usage-poll: credenziale ${provider.id} saltata: ${errText(err)}`,
      );
    }
  }
}

async function pollOneAccount(deps: PollUsageDeps, provider: ResolvedProvider): Promise<void> {
  const rawText = await deps.capture(provider);

  // Cattura PTY vuota (nessun output): non c'è nulla da estrarre NÉ da
  // diagnosticare. Logghiamo e basta, senza inquinare la tabella con righe vuote.
  if (rawText.trim() === "") {
    console.error(
      `[stubwise-worker] usage-poll: cattura /usage vuota per ${provider.id} (niente da salvare)`,
    );
    return;
  }

  const { snapshot, source, parseOk } = await parseUsage(rawText, deps.runLlm);

  if (snapshot === null) {
    // Nessun parser ha estratto dati, MA c'è del testo grezzo: lo salviamo con
    // parseOk=false così il banner di diagnosi (UI) può mostrarlo e si può
    // capire perché il parser fallisce e aggiornarlo. Usage null.
    console.error(
      `[stubwise-worker] usage-poll: nessun usage estraibile per ${provider.id} (source ${source}); salvo rawText per diagnosi`,
    );
    await deps.db.insert(aiUsageSnapshots).values({
      providerId: provider.id,
      sessionRemaining: null,
      weeklyRemaining: null,
      sessionResetAt: null,
      weeklyResetAt: null,
      source,
      parseOk: false,
      rawText,
    });
    return;
  }

  await deps.db.insert(aiUsageSnapshots).values({
    providerId: provider.id,
    sessionRemaining: snapshot.sessionRemaining,
    weeklyRemaining: snapshot.weeklyRemaining,
    sessionResetAt: toDate(snapshot.sessionResetAt),
    weeklyResetAt: toDate(snapshot.weeklyResetAt),
    source,
    parseOk,
    // rawText SOLO quando il deterministico ha fallito (parseOk=false): serve a
    // capire perché e ad aggiornare il parser. Se parseOk, non lo conserviamo.
    rawText: parseOk ? null : rawText,
  });
}

function toDate(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Costruisce il `runLlm` di fallback dalla catena: esegue `claude -p` con un
 * modello economico (haiku) preferendo una credenziale `api_key` per non
 * intaccare la quota dell'abbonamento; se non c'è api_key usa il primo account.
 * Se la catena è vuota, ritorna un runLlm che fallisce (→ parse LLM = null).
 */
export function buildRunLlmFromChain(chain: ResolvedProvider[]): RunLlm {
  const preferred = chain.find((p) => p.kind === "api_key") ?? chain[0];
  const runner = new ClaudeCliRunner();
  return async (prompt: string): Promise<string> => {
    if (!preferred) throw new Error("nessuna credenziale per il fallback LLM");
    const res = await runner.run({
      cwd: process.cwd(),
      prompt,
      model: LLM_FALLBACK_MODEL,
      permissionMode: "default",
      maxTurns: LLM_MAX_TURNS,
      timeoutMs: LLM_TIMEOUT_MS,
      provider: preferred,
    });
    return res.output;
  };
}

export interface StartUsagePollerOptions {
  db: Db;
  encryptionKey: Buffer;
  /** Intervallo in minuti. 0 = disabilitato (non avvia nulla). */
  intervalMinutes: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller su un proprio setInterval, separato dal loop dei job. Ad ogni
 * tick ricarica la catena (per cogliere i cambi di credenziali) e costruisce
 * capture reale (PTY) + runLlm reale (haiku via catena). Lo stop avviene
 * sull'AbortSignal (lo stesso del worker). 0 minuti = poller disabilitato.
 *
 * Ritorna una funzione di stop idempotente (utile anche fuori dal segnale).
 */
export function startUsagePoller(opts: StartUsagePollerOptions): () => void {
  if (opts.intervalMinutes <= 0) {
    return () => {};
  }
  const intervalMs = opts.intervalMinutes * 60_000;
  let running = false;

  const tick = async (): Promise<void> => {
    // Evita sovrapposizioni se un giro è più lento dell'intervallo.
    if (running) return;
    running = true;
    try {
      const chain = await loadProviderChain(opts.db, opts.encryptionKey);
      const runLlm = buildRunLlmFromChain(chain);
      await pollUsageOnce({
        db: opts.db,
        encryptionKey: opts.encryptionKey,
        capture: (provider) => captureUsageOutput(provider),
        runLlm,
      });
    } catch (err) {
      // Difesa finale: un tick non deve mai propagare.
      console.error(`[stubwise-worker] usage-poll: tick fallito: ${errText(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Non tenere vivo il processo solo per il poller.
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
