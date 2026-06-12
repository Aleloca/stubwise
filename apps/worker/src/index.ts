import { createDb } from "@stubwise/db";
import { ClaudeCliRunner } from "./agent/claude-cli.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { MirrorManager } from "./git/mirrors.js";
import { createHandler } from "./handler.js";
import { DEFAULT_FIX_PLAN_TIMEOUT_MS, DEFAULT_FIX_TIMEOUT_MS } from "./pipeline/fix.js";
import { DEFAULT_TRIAGE_TIMEOUT_MS } from "./pipeline/triage.js";
import { runWorker } from "./queue.js";

/**
 * Margine di sicurezza sopra triage+fix prima che un job sia dichiarato
 * orfano: copre il tempo non-agentico del job (clone/worktree, push, apertura
 * PR) e la latenza del poll di requeueStale.
 */
const STALE_MARGIN_MS = 5 * 60_000;

/**
 * INVARIANTE: la soglia di staleness deve superare il tempo MASSIMO che un job
 * legittimo può impiegare, altrimenti requeueStale lo riporterebbe in coda
 * mentre è ancora in corso → PR duplicata sullo stesso progetto. Il triage può
 * ritentare una volta (≈ 2× il suo timeout). Con il fix in DUE FASI il fix gira
 * pianificazione + esecuzione back-to-back: il caso peggiore è plan timeout +
 * fix timeout (con la fase singola basta il solo fix). L'heartbeat in runFix è
 * la difesa primaria; questa è la rete di sicurezza contro una config rotta.
 */
function assertStaleInvariant(staleAfterMinutes: number, twoPhase: boolean): void {
  const staleMs = staleAfterMinutes * 60_000;
  // Due fasi: plan (10') + execute (30'); fase singola: solo execute (30').
  const fixMaxMs = twoPhase
    ? DEFAULT_FIX_PLAN_TIMEOUT_MS + DEFAULT_FIX_TIMEOUT_MS
    : DEFAULT_FIX_TIMEOUT_MS;
  const minRequiredMs = fixMaxMs + 2 * DEFAULT_TRIAGE_TIMEOUT_MS + STALE_MARGIN_MS;
  if (staleMs <= minRequiredMs) {
    throw new Error(
      `WORKER_STALE_MINUTES=${staleAfterMinutes} è troppo basso: deve superare ` +
        `${Math.ceil(minRequiredMs / 60_000)} minuti (timeout fix${twoPhase ? " plan + execute" : ""} + 2× triage + margine), ` +
        `altrimenti un job lungo ma vivo verrebbe riaccodato e si aprirebbe una PR duplicata.`,
    );
  }
}

/**
 * Entry point del worker: config → DB → mirror manager → CLI claude →
 * handler (triage → fix, serializzato per progetto) → loop runWorker.
 * Le migrazioni NON si lanciano qui: le applica il server all'avvio, il
 * worker assume che lo schema esista già (vedi packages/db/src/client.ts).
 */

function loadConfigOrExit(): WorkerConfig {
  try {
    return loadWorkerConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const config = loadConfigOrExit();
try {
  assertStaleInvariant(config.staleAfterMinutes, config.fixTwoPhase);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
const { db, client } = createDb(config.databaseUrl);

const handler = createHandler({
  db,
  runner: new ClaudeCliRunner(),
  mirrors: new MirrorManager({ mirrorsDir: config.mirrorsDir }),
  encryptionKey: config.encryptionKey,
  fix: {
    twoPhase: config.fixTwoPhase,
    planModel: config.fixPlanModel,
    executeModel: config.fixExecuteModel,
    planTimeoutMs: config.fixPlanTimeoutMs,
  },
});

// Shutdown pulito: al primo segnale il loop smette di reclamare job e
// attende quelli in volo (runWorker si risolve solo a job conclusi).
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.error(`[stubwise-worker] ricevuto ${signal}: attendo i job in corso e mi fermo`);
    controller.abort();
  });
}

console.error(
  `[stubwise-worker] avviato (concurrency ${config.concurrency}, mirrors in ${config.mirrorsDir})`,
);
await runWorker({
  db,
  handler,
  concurrency: config.concurrency,
  staleAfterMinutes: config.staleAfterMinutes,
  signal: controller.signal,
});
await client.end();
console.error("[stubwise-worker] fermato");
