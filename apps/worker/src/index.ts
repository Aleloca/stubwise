import { createDb } from "@stubwise/db";
import { createEmbeddingClient } from "@stubwise/embeddings";
import { ClaudeCliRunner } from "./agent/claude-cli.js";
import { startCredentialTester } from "./agent/credential-tester.js";
import { startUsagePoller } from "./agent/usage-poller.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { startAutoUpdatePoller } from "./docs/auto-update-poller.js";
import { startPrReviewPoller } from "./review/poller.js";
import { createDocHandler, failDocJobOnError } from "./docs/handler.js";
import { dispatchNode } from "./docs/recursive/node-dispatch.js";
import { createGenerationWorktreeRegistry } from "./docs/recursive/registry.js";
import { MirrorManager } from "./git/mirrors.js";
import { createHandler, createProjectSerializer } from "./handler.js";
import { startLimitResumePoller } from "./providers/limit-resume-poller.js";
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
 * fix timeout (con la fase singola basta il solo fix). In più il loop di
 * self-repair (Task 5) può aggiungere, dopo l'esecuzione iniziale, fino a
 * SELF_REPAIR_MAX_ATTEMPTS esecuzioni extra dell'agente (ciascuna fino al
 * timeout di fix) e altrettante esecuzioni del comando di test (ciascuna fino a
 * SELF_REPAIR_TEST_TIMEOUT_MS). Inoltre l'install delle dipendenze nel worktree
 * gira UNA SOLA VOLTA prima dell'agente (fino a installTimeoutMs), quindi entra
 * come addendo unico (non per tentativo). L'heartbeat in runFix è la difesa
 * primaria; questa è la rete di sicurezza contro una config rotta.
 */
function assertStaleInvariant(
  staleAfterMinutes: number,
  twoPhase: boolean,
  selfRepairMaxAttempts: number,
  selfRepairTestTimeoutMs: number,
  installTimeoutMs: number,
): void {
  const staleMs = staleAfterMinutes * 60_000;
  // Due fasi: plan (10') + execute (30'); fase singola: solo execute (30').
  const fixMaxMs = twoPhase
    ? DEFAULT_FIX_PLAN_TIMEOUT_MS + DEFAULT_FIX_TIMEOUT_MS
    : DEFAULT_FIX_TIMEOUT_MS;
  // Install: gira una volta, prima dell'agente → addendo unico (non per tentativo).
  const installMs = installTimeoutMs;
  // Self-repair: ogni RE-tentativo è una ri-esecuzione dell'agente (fino al
  // timeout di fix) + un'esecuzione del comando di test (fino al suo timeout).
  // Stima prudente: N × (timeout esecuzione + timeout test).
  const selfRepairMs =
    selfRepairMaxAttempts * (DEFAULT_FIX_TIMEOUT_MS + selfRepairTestTimeoutMs);
  const minRequiredMs =
    fixMaxMs + installMs + selfRepairMs + 2 * DEFAULT_TRIAGE_TIMEOUT_MS + STALE_MARGIN_MS;
  if (staleMs <= minRequiredMs) {
    throw new Error(
      `WORKER_STALE_MINUTES=${staleAfterMinutes} è troppo basso: deve superare ` +
        `${Math.ceil(minRequiredMs / 60_000)} minuti (timeout fix${twoPhase ? " plan + execute" : ""}` +
        `${selfRepairMaxAttempts > 0 ? ` + ${selfRepairMaxAttempts}× self-repair (esecuzione + test)` : ""} + install + 2× triage + margine), ` +
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
  assertStaleInvariant(
    config.staleAfterMinutes,
    config.fixTwoPhase,
    config.selfRepairMaxAttempts,
    config.selfRepairTestTimeoutMs,
    config.installTimeoutMs,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
const { db, client } = createDb(config.databaseUrl, { poolMax: config.databasePoolMax });

// Dipendenze costruite UNA VOLTA all'avvio e condivise da entrambi gli handler
// (fix e doc-generation): stesso runner CLI e stesso MirrorManager (i mirror sono
// condivisi per repository), così la serializzazione per-progetto vale anche fra
// i due tipi di job (vedi più sotto).
const runner = new ClaudeCliRunner();
const mirrors = new MirrorManager({ mirrorsDir: config.mirrorsDir });

// Serializzatore per-progetto CONDIVISO fra fix e doc-generation: un doc-job e
// un fix-job dello stesso progetto si accodano alla STESSA catena e non si
// sovrappongono mai (un fix di progetto tiene worktree su tutti i suoi repo; il
// fetch --prune di MirrorManager cancellerebbe il branch stubwise/* non ancora
// pushato dell'altro). Vedi handler.ts.
const serializer = createProjectSerializer();

const handler = createHandler(
  {
    db,
    runner,
    mirrors,
    encryptionKey: config.encryptionKey,
    // URL pubblico per i link nelle notifiche webhook (vuoto = solo path).
    publicUrl: config.publicUrl,
    fix: {
      twoPhase: config.fixTwoPhase,
      planModel: config.fixPlanModel,
      executeModel: config.fixExecuteModel,
      planTimeoutMs: config.fixPlanTimeoutMs,
      selfRepairMaxAttempts: config.selfRepairMaxAttempts,
      testTimeoutMs: config.selfRepairTestTimeoutMs,
      installTimeoutMs: config.installTimeoutMs,
    },
  },
  serializer,
);

// Client di embedding (OpenAI-compatibile) costruito una volta: la pipeline di
// doc-generation chunk+embed le pagine generate. Config via env (vedi config.ts).
const embeddingClient = createEmbeddingClient({
  baseUrl: config.embeddingBaseUrl,
  model: config.embeddingModel,
  ...(config.embeddingApiKey !== undefined ? { apiKey: config.embeddingApiKey } : {}),
});

// Registro IN-PROCESSO dei worktree di generazione del DAG (M7): l'orientamento vi
// registra il worktree aperto, i job-nodo ne ricavano la `dir`, la finalizzazione lo
// chiude. Espone activeRepositoryIds per la mutua esclusione col fix (un fix farebbe
// fetch --prune cancellando il ref checked-out del worktree). È un contenitore
// in-memoria: a un riavvio del worker gli handle sono persi e il dispatch fa fallire
// pulitamente le generazioni interrotte (fail-on-restart, vedi node-dispatch.ts).
const generationRegistry = createGenerationWorktreeRegistry();

// Handler del TRIGGER doc-generation (M7): avvia l'ORIENTAMENTO (apre+registra il
// worktree, semina il DAG), serializzato per-progetto col fix (serializer condiviso)
// SOLO per la durata dell'orientamento; il resto della generazione è retto dal
// registro (activeRepositoryIds) e dal dispatch dei nodi. Il timeout di ogni run
// dell'agente è DOC_AGENT_TIMEOUT_MS (default 8', più corto del fix).
const docHandler = createDocHandler(
  {
    db,
    runner,
    mirrors,
    registry: generationRegistry,
    encryptionKey: config.encryptionKey,
    model: config.docGenerationModel,
    agentTimeoutMs: config.docAgentTimeoutMs,
    maxTurns: config.docModuleMaxTurns,
  },
  serializer,
);

// Dispatch dei JOB-NODO del DAG (M7): il loop lo chiama quando non ci sono fix da
// fare e c'è capacità; reclama un nodo (explore/synthesize), risolve il worktree dal
// registro (o lo riapre on-demand), esegue la fase e — a DAG completo — finalizza la
// generazione. I job-nodo parallelizzano fino alla concorrenza del worker.
const dispatchNodeFn = (track: (work: Promise<void>) => void): Promise<boolean> =>
  dispatchNode(
    {
      db,
      runner,
      registry: generationRegistry,
      finalize: { embeddingClient },
      model: config.docGenerationModel,
      agentTimeoutMs: config.docAgentTimeoutMs,
      maxTurns: config.docModuleMaxTurns,
      maxDepth: config.docMaxDepth,
      maxNodes: config.docMaxNodes,
      encryptionKey: config.encryptionKey,
    },
    track,
  );

// Shutdown pulito: al primo segnale il loop smette di reclamare job e
// attende quelli in volo (runWorker si risolve solo a job conclusi).
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.error(`[stubwise-worker] ricevuto ${signal}: attendo i job in corso e mi fermo`);
    controller.abort();
  });
}

// Poller dell'usage residuo dell'abbonamento (Task 6): task SEPARATO dal loop
// dei job, su un proprio intervallo. È BEST-EFFORT (non fa mai crashare il
// worker) e NON tocca il lock/heartbeat né i timeout dei job (nessun impatto
// sull'invariante WORKER_STALE_MINUTES). Si ferma sullo stesso AbortSignal.
startUsagePoller({
  db,
  encryptionKey: config.encryptionKey,
  intervalMinutes: config.usagePollMinutes,
  signal: controller.signal,
});

// Tester delle credenziali AI (Polish-A): task SEPARATO dal loop dei job, sul
// proprio intervallo. Raccoglie le richieste di test marcate `pending` dal
// server ed esegue un `claude -p` di prova con quella credenziale. È
// BEST-EFFORT (non fa mai crashare il worker) e NON tocca il lock/heartbeat né
// i timeout dei job (nessun impatto sull'invariante WORKER_STALE_MINUTES). Si
// ferma sullo stesso AbortSignal.
startCredentialTester({
  db,
  encryptionKey: config.encryptionKey,
  intervalMs: config.credentialTestPollSeconds * 1000,
  signal: controller.signal,
});

// Poller di auto-aggiornamento Docs (Fase 1): task SEPARATO dal loop dei job, sul
// proprio intervallo. Reclama i pending di doc_auto_update_jobs scaduti (debounce) ed
// esegue l'agente che produce la entry release, nella CATENA PER-REPOSITORY (serializer
// condiviso col fix e la doc-generation: niente sovrapposizione col fetch --prune dello
// stesso progetto). È BEST-EFFORT (non fa mai crashare il worker) e NON tocca il
// lock/heartbeat né i timeout dei job. Si ferma sullo stesso AbortSignal.
startAutoUpdatePoller({
  db,
  mirrors,
  runner,
  encryptionKey: config.encryptionKey,
  model: config.docGenerationModel,
  agentTimeoutMs: config.docAgentTimeoutMs,
  maxTurns: config.docModuleMaxTurns,
  // Fase 2: rigenerazione mirata delle pagine toccate + re-embed (riusa lo stesso
  // embeddingClient della finalize; il cap limita costo/tempo per push, 0 = solo entry).
  embeddingClient,
  maxRefreshPages: config.docsAutoUpdateMaxPages,
  serializer,
  intervalSeconds: config.docsAutoUpdatePollSeconds,
  signal: controller.signal,
});

// Poller dell'automazione PR Review: task SEPARATO dal loop dei job, sul
// proprio intervallo. Reclama i pending di pr_review_jobs scaduti (debounce)
// ed esegue la review (agente read-only in plan mode) nella CATENA
// PER-PROGETTO (serializer condiviso: niente sovrapposizione col fetch
// --prune dello stesso progetto). È BEST-EFFORT e non tocca il lock/heartbeat
// dei job. Si ferma sullo stesso AbortSignal.
startPrReviewPoller({
  db,
  mirrors,
  runner,
  encryptionKey: config.encryptionKey,
  model: config.prReviewModel,
  maxTurns: config.prReviewMaxTurns,
  agentTimeoutMs: config.prReviewTimeoutMs,
  publicUrl: config.publicUrl,
  staleMinutes: config.staleAfterMinutes,
  serializer,
  intervalSeconds: config.prReviewPollSeconds,
  signal: controller.signal,
});

// Resume poller dei limiti provider: task SEPARATO dal loop dei job, sul
// proprio intervallo. Riprende le generazioni Docs `paused` e riaccoda i job
// `held` con held_reason "limit" quando il provider ha di nuovo headroom
// (snapshot /usage fresco per gli account) o dopo il cooldown a tempo (api_key
// o snapshot stantio). È BEST-EFFORT (non fa mai crashare il worker) e NON
// tocca il lock/heartbeat né i timeout dei job in lavorazione (agisce solo su
// stati fermi: paused/held). Si ferma sullo stesso AbortSignal.
startLimitResumePoller({
  db,
  encryptionKey: config.encryptionKey,
  headroomPercent: config.limitResumeHeadroomPercent,
  cooldownMs: config.limitResumeCooldownMs,
  intervalMinutes: config.limitResumePollMinutes,
  signal: controller.signal,
});

console.error(
  `[stubwise-worker] avviato (concurrency ${config.concurrency}, db-pool ${config.databasePoolMax}, mirrors in ${config.mirrorsDir}` +
    `, usage-poll ${config.usagePollMinutes > 0 ? `ogni ${config.usagePollMinutes}'` : "disabilitato"}` +
    `, credential-test ${config.credentialTestPollSeconds > 0 ? `ogni ${config.credentialTestPollSeconds}"` : "disabilitato"}` +
    `, docs-auto-update ${config.docsAutoUpdatePollSeconds > 0 ? `ogni ${config.docsAutoUpdatePollSeconds}"` : "disabilitato"}` +
    `, pr-review ${config.prReviewPollSeconds > 0 ? `ogni ${config.prReviewPollSeconds}"` : "disabilitato"}` +
    `, limit-resume ${config.limitResumePollMinutes > 0 ? `ogni ${config.limitResumePollMinutes}'` : "disabilitato"})`,
);
// POLITICA DI PRIORITÀ doc vs fix (Task 5.4): i fix hanno la precedenza. Il
// loop satura la concorrenza con i fix in coda; reclama UN doc-job per tick solo
// quando NON c'è alcun fix da fare e resta capacità. Le generazioni di
// documentazione (lunghe/costose) non affamano mai i fix dei bug. Single-process:
// nessuno slot dedicato, si condivide il budget di concorrenza.
console.error(
  "[stubwise-worker] doc-generation a DAG ATTIVA: priorità ai fix; job-nodo e trigger di generazione solo con capacità libera e nessun fix in coda. " +
    "Mutua esclusione fix↔generazione: i fix dei progetti con un worktree di generazione aperto sono esclusi dal claim (invariante del mirror).",
);
await runWorker({
  db,
  handler,
  docHandler,
  docHandlerOnError: failDocJobOnError,
  dispatchNode: dispatchNodeFn,
  activeGenerationProjectIds: () => generationRegistry.activeProjectIds(),
  concurrency: config.concurrency,
  staleAfterMinutes: config.staleAfterMinutes,
  signal: controller.signal,
});
await client.end();
console.error("[stubwise-worker] fermato");
