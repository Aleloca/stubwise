import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiProviders, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { loadProviderChain, type ResolvedProvider } from "../providers/chain.js";
import { latestSnapshots, parseWindow, type LatestSnapshot } from "../providers/usage-window.js";
import { createModelResolver } from "./model-settings.js";
import type { AgentRunner } from "./runner.js";
import { StreamingClaudeRunner } from "./streaming-cli.js";
import { TrackingAgentRunner } from "./tracking-runner.js";

/**
 * Sonda d'uso degli account FERMI (design 2026-11-19-utilizzo-account-da-
 * rate-limit-event §3). Lo snapshot d'uso nasce dal `rate_limit_event` che ogni
 * run dell'account emette (lo scrive il `TrackingAgentRunner`, vedi
 * tracking-runner.ts): un account che lavora è quindi già fresco. Questo
 * scheduler serve SOLO agli account che non lavorano — inattivi, o «al limite»
 * e in attesa del reset — e lancia per loro un run minimo (haiku, 1 turno) il
 * cui evento rinfresca lo snapshot. Il poller NON scrive MAI snapshot e NON
 * sblocca niente: lo fa il decoratore, dallo stesso evento.
 *
 * Vincoli (CRITICI):
 *  - NON deve MAI far crashare il worker: ogni account è in un try/catch
 *    isolato, e l'intero giro a sua volta.
 *  - È un task SEPARATO dal loop dei job: proprio setInterval, nessun impatto
 *    su lock/heartbeat dei job né su WORKER_STALE_MINUTES.
 *  - Un run di sonda COSTA un po' di quota dell'abbonamento: per questo si
 *    lancia solo se lo snapshot è vecchio, e un account al limite con una
 *    finestra a 100% e reset futuro non si sonda affatto (non c'è niente da
 *    imparare prima del reset).
 *  - I segreti non vengono MAI loggati.
 *  - NON passa dalla scelta dell'account (providers/select.ts): deve poter
 *    sondare ANCHE gli account «al limite», perché è la sonda a sbloccarli.
 */

const PROBE_MODEL = "haiku";
const PROBE_MAX_TURNS = 1;
const PROBE_TIMEOUT_MS = 60_000;
const PROBE_PROMPT = "Rispondi solo con: ok";

/**
 * Serve una sonda per questo account? Pura.
 *  - nessuno snapshot leggibile (assente o `parseOk` false): sì;
 *  - account al limite: sì se lo snapshot è più vecchio di un tick (si
 *    rilegge a ogni giro per cogliere il reset anticipato) — salvo che una
 *    finestra sia a 100% con reset ancora nel futuro: allora no;
 *  - altrimenti sì solo se lo snapshot ha più di `idleMs`.
 */
export function shouldProbe(
  account: { limitedUntil: Date | null },
  snap: LatestSnapshot | undefined,
  now: Date,
  idleMs: number,
  tickMs: number,
): boolean {
  if (snap === undefined || !snap.parseOk) return true;
  const age = now.getTime() - snap.capturedAt.getTime();
  const limited = account.limitedUntil !== null && account.limitedUntil.getTime() > now.getTime();
  if (!limited) return age > idleMs;
  if (windowBlocked(snap.sessionRemaining, snap.sessionResetAt, now)) return false;
  if (windowBlocked(snap.weeklyRemaining, snap.weeklyResetAt, now)) return false;
  return age > tickMs;
}

/** Finestra a 100% il cui reset non è ancora arrivato: sondare non cambierebbe nulla. */
function windowBlocked(value: unknown, resetAt: Date | null, now: Date): boolean {
  const w = parseWindow(value);
  return w !== null && w.percentUsed >= 100 && resetAt !== null && resetAt.getTime() > now.getTime();
}

export interface ProbeDeps {
  db: Db;
  encryptionKey: Buffer;
  /** Il runner che avvolge lo snapshot (TrackingAgentRunner in produzione). */
  runner: AgentRunner;
  idleMs: number;
  tickMs: number;
  now?: () => Date;
}

/**
 * UN giro: sonda, in sequenza, gli account `account` abilitati che ne hanno
 * bisogno. `limitedUntil` si legge da `ai_providers` (la catena non lo porta).
 * Non lancia mai: un errore su un account si logga e si passa al successivo.
 */
export async function probeIdleAccountsOnce(deps: ProbeDeps): Promise<void> {
  try {
    const now = (deps.now ?? (() => new Date()))();
    const chain = (await loadProviderChain(deps.db, deps.encryptionKey)).filter((p) => p.kind === "account");
    if (chain.length === 0) return;
    const snaps = await latestSnapshots(deps.db);
    for (const provider of chain) {
      try {
        const [row] = await deps.db
          .select({ limitedUntil: aiProviders.limitedUntil })
          .from(aiProviders)
          .where(eq(aiProviders.id, provider.id));
        if (!row) continue;
        if (!shouldProbe(row, snaps.get(provider.id), now, deps.idleMs, deps.tickMs)) continue;
        await probeOne(deps.runner, provider);
      } catch (err) {
        console.error(`[stubwise-worker] usage-probe: account ${provider.id} saltato: ${errText(err)}`);
      }
    }
  } catch (err) {
    console.error(`[stubwise-worker] usage-probe: giro fallito: ${errText(err)}`);
  }
}

/** Il run minimo, in una cwd vuota e usa-e-getta. */
async function probeOne(runner: AgentRunner, provider: ResolvedProvider): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "stubwise-usage-probe-"));
  try {
    await runner.run({
      cwd,
      prompt: PROBE_PROMPT,
      model: PROBE_MODEL,
      usage: { operation: "usage_probe", projectId: null },
      permissionMode: "default",
      maxTurns: PROBE_MAX_TURNS,
      timeoutMs: PROBE_TIMEOUT_MS,
      provider,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface StartUsagePollerOptions {
  db: Db;
  encryptionKey: Buffer;
  /** Intervallo del giro in minuti. 0 = disabilitato (non avvia nulla). */
  intervalMinutes: number;
  /** Inattività oltre la quale un account si sonda (USAGE_PROBE_IDLE_MINUTES). */
  idleMinutes: number;
  signal: AbortSignal;
}

/**
 * Avvia la sonda su un proprio setInterval. Il runner è SEMPRE quello in
 * streaming (anche con AGENT_STREAMING=false): è lui a consegnare il
 * `rate_limit_event`. Niente sovrapposizione fra giri; il timer è `unref` e si
 * ferma sull'AbortSignal. Ritorna una funzione di stop idempotente.
 */
export function startUsagePoller(opts: StartUsagePollerOptions): () => void {
  if (opts.intervalMinutes <= 0) return () => {};
  const tickMs = opts.intervalMinutes * 60_000;
  const runner = new TrackingAgentRunner({
    inner: new StreamingClaudeRunner(),
    db: opts.db,
    models: createModelResolver(opts.db, console),
  });
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await probeIdleAccountsOnce({
        db: opts.db,
        encryptionKey: opts.encryptionKey,
        runner,
        idleMs: opts.idleMinutes * 60_000,
        tickMs,
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, tickMs);
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
