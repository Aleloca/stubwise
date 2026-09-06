import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@stubwise/db";
import { createEmbeddingClient } from "@stubwise/embeddings";
import { createPushRelayClient } from "@stubwise/notifications";
import { ClaudeCliRunner } from "./agent/claude-cli.js";
import { startBacklogPoller } from "./backlog/poller.js";
import { startChatTurnPoller } from "./backlog/chat-turn-poller.js";
import { createCodeSessionRegistry, startCodeSessionSweeper } from "./backlog/code-session.js";
import { startCredentialTester } from "./agent/credential-tester.js";
import { startUsagePoller } from "./agent/usage-poller.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { startAutoUpdatePoller } from "./docs/auto-update-poller.js";
import { startPrReviewPoller } from "./review/poller.js";
import { createDocHandler, failDocJobOnError } from "./docs/handler.js";
import { dispatchNode } from "./docs/recursive/node-dispatch.js";
import { createGenerationWorktreeRegistry } from "./docs/recursive/registry.js";
import { MirrorManager } from "./git/mirrors.js";
import { createGraphifyRunner } from "./graph/graphify-cli.js";
import { startGraphPoller } from "./graph/poller.js";
import { createHandler, createProjectSerializer } from "./handler.js";
import { startMonitorAlertPoller } from "./monitor/alerts.js";
import { PUSH_RELAY_TIMEOUT_MS, startDeliveriesPoller } from "./notify/deliveries-poller.js";
import { startPluginPoller } from "./plugins/poller.js";
import { startMonitorRollupPoller } from "./monitor/rollup.js";
import { startLimitResumePoller } from "./providers/limit-resume-poller.js";
import { startPulsePoller } from "./pulse/poller.js";
import { startDailyReportPoller } from "./reports/daily-report-poller.js";
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
 * pianificazione + esecuzione back-to-back, e la PIANIFICAZIONE può girare DUE
 * volte nello stesso job: la ripresa da una risposta umana (`plan_continue`)
 * lancia il run con `--resume` e, se quello muore con exit non-zero — sessione
 * scaduta o di un altro host — ricade su un run di pianificazione pieno (vedi
 * runPlanResume in pipeline/fix.ts). Ognuno dei due è limitato dal plan
 * timeout, quindi il caso peggiore è 2× plan timeout + fix timeout (con la fase
 * singola basta il solo fix). In più il loop di self-repair (Task 5) può
 * aggiungere, dopo l'esecuzione iniziale, fino a SELF_REPAIR_MAX_ATTEMPTS
 * esecuzioni extra dell'agente (ciascuna fino al timeout di fix) e altrettante
 * esecuzioni del comando di test (ciascuna fino a
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
  // Due fasi: plan × 2 (resume fallito + fallback, 10' ciascuno) + execute
  // (30'); fase singola: solo execute (30'), che non ha fase di piano e quindi
  // non può nemmeno riprenderla.
  const fixMaxMs = twoPhase
    ? 2 * DEFAULT_FIX_PLAN_TIMEOUT_MS + DEFAULT_FIX_TIMEOUT_MS
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
        `${Math.ceil(minRequiredMs / 60_000)} minuti (timeout fix${twoPhase ? " 2× plan (ripresa + fallback) + execute" : ""}` +
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
    graphsDir: config.graphsDir,
    // Volume dei plugin del registro d'istanza (fase 3): i run del fix caricano
    // i plugin abilitati sul progetto (copia filtrata per-run).
    pluginsDir: config.pluginsDir,
    // URL pubblico per i link nelle notifiche webhook (vuoto = solo path).
    publicUrl: config.publicUrl,
    fix: {
      twoPhase: config.fixTwoPhase,
      planModel: config.fixPlanModel,
      executeModel: config.fixExecuteModel,
      planTimeoutMs: config.fixPlanTimeoutMs,
      // Tetto di domande `ask_user` per job: arriva fin dentro l'env del server
      // MCP del run di pianificazione (ASK_USER_MAX_ROUNDS).
      questionMaxRounds: config.agentQuestionMaxRounds,
      selfRepairMaxAttempts: config.selfRepairMaxAttempts,
      testTimeoutMs: config.selfRepairTestTimeoutMs,
      installTimeoutMs: config.installTimeoutMs,
      // Riassunto "in breve" del piano (fase 5): un run di solo testo subito
      // prima del parcheggio, sullo stesso profilo di modello della PR review.
      summariesEnabled: config.summariesEnabled,
      summaryModel: config.summaryModel,
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
    // Volume dei knowledge graph (fase 2c): col grafo del repository l'orientamento
    // semina i prompt con la mappa delle aree; senza, tutto identico a prima.
    graphsDir: config.graphsDir,
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
      maxProductPages: config.docProductMaxPages,
      encryptionKey: config.encryptionKey,
      // Volume dei knowledge graph (fase 2c): i run di esplorazione dei nodi possono
      // interrogare il grafo sulla propria area; senza grafo nulla cambia.
      graphsDir: config.graphsDir,
      publicUrl: config.publicUrl,
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
  // Fase 3: creazione incrementale di pagine per le aree non documentate (mini-orient +
  // explore nello stesso worktree effimero; il cap limita costo/tempo, 0 = disattivata).
  maxNewPages: config.docsAutoUpdateMaxNewPages,
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
  graphsDir: config.graphsDir,
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

// Poller dell'OUTBOX delle notifiche (`notification_deliveries`): task SEPARATO
// dal loop dei job, sul proprio intervallo breve (default 5"). `publishNotification`
// scrive inbox e outbox ma non invia nulla: è QUESTO poller a spedire le consegne
// dovute sul loro canale: il webhook d'istanza (il gating dei toggle è già stato
// applicato al publish) e i DM Slack per-destinatario, coi bottoni Block Kit
// delle azioni che quell'utente può compiere (più i loro aggiornamenti quando
// una notifica viene gestita). Il claim pre-schedula il ritentativo (backoff
// 30s×2^n, 5 tentativi) quindi un crash a metà invio non perde la consegna. È BEST-EFFORT
// (non fa mai crashare il worker) e NON tocca il lock/heartbeat dei job. Si ferma
// sullo stesso AbortSignal.
const notifyLogger = {
  warn: (obj: unknown, msg?: string) =>
    console.error(`[stubwise-worker] ${msg ?? "notify: warning"}`, obj),
  error: (obj: unknown, msg?: string) =>
    console.error(`[stubwise-worker] ${msg ?? "notify: error"}`, obj),
};
startDeliveriesPoller({
  db,
  logger: notifyLogger,
  // Serve ai canali Slack: il bot token è cifrato nelle instance settings con
  // la stessa chiave del server.
  encryptionKey: config.encryptionKey,
  // Client del relay push, o `null` se le push sono spente (`PUSH_RELAY_URL=`).
  // Il timeout è quello STRETTO del poller, non il default del client: vedi
  // PUSH_RELAY_TIMEOUT_MS.
  pushRelay: config.push
    ? createPushRelayClient({ url: config.push.relayUrl, timeoutMs: PUSH_RELAY_TIMEOUT_MS })
    : null,
  intervalSeconds: config.notifyPollSeconds,
  signal: controller.signal,
});

// Poller del DAILY ACTIVITY REPORT (standup automatico): task SEPARATO dal loop
// dei job, sul proprio intervallo, con GATE a mezzanotte UTC (un report per
// progetto per giorno, idempotente sull'unique (project_id, date)). Per ogni
// progetto con dailyReportEnabled legge i commit del giorno precedente da ogni
// repo, li aggrega per autore, registra gli autori osservati e genera un
// riassunto AI per autore, nella CATENA PER-PROGETTO (serializer condiviso col
// fix/doc-generation/review: niente sovrapposizione col fetch --prune del mirror).
// Riusa il model/timeout della review per l'agente. È BEST-EFFORT (non fa mai
// crashare il worker) e NON tocca il lock/heartbeat dei job. Si ferma sullo
// stesso AbortSignal.
startDailyReportPoller({
  db,
  mirrors,
  runner,
  encryptionKey: config.encryptionKey,
  serializer,
  maxAuthorsPerProject: config.dailyReportMaxAuthorsPerProject,
  retentionDays: config.dailyReportRetentionDays,
  model: config.prReviewModel,
  agentTimeoutMs: config.prReviewTimeoutMs,
  intervalMinutes: config.dailyReportPollMinutes,
  signal: controller.signal,
});

// Poller del BACKLOG DI DISCOVERY: task SEPARATO dal loop dei job, sul proprio
// intervallo. Reclama i job `backlog_jobs` queued (intake e deep dive) e li
// esegue nella CATENA PER-PROGETTO (serializer condiviso col fix/doc-generation/
// review/daily-report: niente sovrapposizione col fetch --prune del mirror).
// L'intake gira su una dir vuota (ragiona sul testo del prompt); il deep dive
// monta un worktree read-only del mirror (pattern PR review, plan mode). Il
// provider AI è pinned del progetto o chain[0]. Riusa i turni max della review
// per il deep dive. È BEST-EFFORT (non fa mai crashare il worker) e NON tocca il
// lock/heartbeat dei job. Si ferma sullo stesso AbortSignal.
//
// workDir: una dir temporanea vuota e innocua (cwd dei run dell'intake, senza
// worktree), creata all'avvio sotto os.tmpdir() come le parent dei worktree.
const backlogWorkDir = mkdtempSync(join(tmpdir(), "stubwise-backlog-"));
// Logger del backlog: minimale (warn/error), soddisfa anche il RetrievalLogger
// del retrieval RAG dell'intake. Il worker non usa pino: si appoggia a console.
const backlogLogger = {
  warn: (obj: unknown, msg?: string) =>
    console.error(`[stubwise-worker] ${msg ?? "backlog: warning"}`, obj),
  error: (obj: unknown, msg?: string) =>
    console.error(`[stubwise-worker] ${msg ?? "backlog: error"}`, obj),
};
startBacklogPoller({
  db,
  embeddingClient,
  runner,
  mirrors,
  serializer,
  logger: backlogLogger,
  encryptionKey: config.encryptionKey,
  graphsDir: config.graphsDir,
  // Volume dei plugin (fase 3): il deep dive è nel perimetro dei run con plugin.
  pluginsDir: config.pluginsDir,
  mergeThreshold: config.backlogMergeThreshold,
  similarThreshold: config.backlogSimilarThreshold,
  model: config.backlogModel,
  agentTimeoutMs: config.backlogAgentTimeoutMs,
  // Il deep dive esplora il codice: riusa i turni max della review (analisi
  // read-only sullo stesso ordine di grandezza).
  deepDiveMaxTurns: config.prReviewMaxTurns,
  workDir: backlogWorkDir,
  intervalSeconds: config.backlogPollSeconds,
  signal: controller.signal,
});

// SESSIONE DI ANALISI SUL CODICE nella chat del backlog: poller VELOCE dei turni
// (chat_turn) + sweep TTL delle sessioni inattive. Task SEPARATI dal loop dei
// job. Il poller reclama i turni e li esegue nel serializer PER-ITEM (turni di
// voci diverse in parallelo, stessa voce sequenziali); ogni turno gira su un
// WORKTREE READ-ONLY persistente (plan mode) con sessione CLI ripresa via
// --resume. Il registro in-memoria tiene i worktree aperti; lo sweep li chiude
// (sessioni scadute/chiuse) e allo shutdown li chiude tutti (best-effort).
// Riusa il MirrorManager e il serializer condivisi (l'apertura del worktree passa
// dal serializer per non correre col fetch --prune). Si fermano sull'AbortSignal.
const codeSessionRegistry = createCodeSessionRegistry();
startChatTurnPoller({
  db,
  runner,
  mirrors,
  serializer,
  registry: codeSessionRegistry,
  logger: backlogLogger,
  encryptionKey: config.encryptionKey,
  graphsDir: config.graphsDir,
  // Volume dei plugin (fase 3): la sessione di analisi è nel perimetro.
  pluginsDir: config.pluginsDir,
  model: config.backlogModel,
  maxTurns: config.backlogChatTurnMaxTurns,
  timeoutMs: config.backlogChatTurnTimeoutMs,
  intervalSeconds: config.backlogChatTurnPollSeconds,
  signal: controller.signal,
});
// Sweep TTL su un intervallo fisso (60s): scala robusta rispetto al TTL (30' di
// default) e latenza bassa nel liberare i worktree delle sessioni chiuse via
// DELETE/convert. Se i turni sono disabilitati (poll = 0) non ci sono worktree da
// gestire: si spegne anche lo sweep (il close-all allo shutdown resta comunque).
startCodeSessionSweeper({
  db,
  registry: codeSessionRegistry,
  ttlMinutes: config.backlogChatSessionTtlMinutes,
  logger: backlogLogger,
  intervalMs: config.backlogChatTurnPollSeconds > 0 ? 60_000 : 0,
  signal: controller.signal,
});

// Poller della coda del KNOWLEDGE GRAPH (graphify): task SEPARATO dal loop dei
// job, sul proprio intervallo. Reclama i `graph_jobs` queued claimabili (il
// webhook push fa debounce spostando notBefore) ed esegue la build nella CATENA
// PER-PROGETTO (serializer condiviso col fix/doc-generation/review/backlog: la
// build apre un worktree sul mirror e il labeling usa il claude CLI, quindi non
// deve sovrapporsi agli altri job dello stesso progetto). Riusa il MirrorManager
// condiviso; il CLI graphify è invocato da un runner dedicato (nessun agente).
// È BEST-EFFORT (non fa mai crashare il worker) e NON tocca il lock/heartbeat né
// i timeout dei job. Si ferma sullo stesso AbortSignal.
const graphLogger = {
  warn: (obj: unknown, msg?: string) =>
    console.error(`[stubwise-worker] ${msg ?? "graph: warning"}`, obj),
  error: (obj: unknown, msg?: string) =>
    console.error(`[stubwise-worker] ${msg ?? "graph: error"}`, obj),
};
startGraphPoller({
  db,
  mirrors,
  graphify: createGraphifyRunner(config.graphifyBin),
  logger: graphLogger,
  encryptionKey: config.encryptionKey,
  graphsDir: config.graphsDir,
  labelEnabled: config.graphLabelEnabled,
  timeoutMs: config.graphBuildTimeoutMs,
  serializer,
  intervalSeconds: config.graphPollSeconds,
  signal: controller.signal,
});

// Poller del REGISTRO PLUGIN: task SEPARATO dal loop dei job, sul proprio
// intervallo. Reclama i `plugin_jobs` e fa due cose: materializza un plugin
// registrato dall'admin in <PLUGINS_DIR>/<slug>/<sha> (fetch senza auth, guard
// sui symlink, `claude plugin validate --strict`, inventario, potatura degli sha
// vecchi e degli spegnimenti orfani) ed esegue lo smoke run che verifica che le
// sue skill siano davvero visibili al CLI. NON usa il serializer per-progetto:
// il registro è d'istanza e non tocca mirror né worktree; la mutua esclusione
// sulla stessa dir la dà l'indice unico parziale della coda. È BEST-EFFORT (non
// fa mai crashare il worker) e NON tocca il lock/heartbeat né i timeout dei job.
// Si ferma sullo stesso AbortSignal.
const pluginLogger = {
  info: (obj: unknown, msg?: string) =>
    console.error(`[stubwise-worker] ${msg ?? "plugins: info"}`, obj),
  warn: (obj: unknown, msg?: string) =>
    console.error(`[stubwise-worker] ${msg ?? "plugins: warning"}`, obj),
  error: (obj: unknown, msg?: string) =>
    console.error(`[stubwise-worker] ${msg ?? "plugins: error"}`, obj),
};
startPluginPoller({
  db,
  pluginsDir: config.pluginsDir,
  encryptionKey: config.encryptionKey,
  logger: pluginLogger,
  intervalSeconds: config.pluginPollSeconds,
  signal: controller.signal,
});

// Poller di ROLLUP + retention delle metriche di monitoraggio: task SEPARATO
// dal loop dei job, sul proprio intervallo. Aggrega i campioni fini oltre le
// 48h in bucket da 5' e applica la retention (tutto in una transazione con
// rollback su errore). È BEST-EFFORT (non fa mai crashare il worker) e NON tocca
// il lock/heartbeat né i timeout dei job. Si ferma sullo stesso AbortSignal.
startMonitorRollupPoller({
  db,
  intervalMinutes: config.monitorRollupIntervalMinutes,
  signal: controller.signal,
});

// Poller di VALUTAZIONE ALERT del monitoraggio: task SEPARATO dal loop dei job,
// sul proprio intervallo (più frequente del rollup: allarmi reattivi). Per ogni
// server valuta offline/soglie sostenute/check down con isteresi ed emette
// monitor.alert/recovered via il dispatch di default. publicUrl dalla config (i
// link nei payload). È BEST-EFFORT (non lancia mai) e NON tocca il
// lock/heartbeat né i timeout dei job. Si ferma sullo stesso AbortSignal.
startMonitorAlertPoller({
  db,
  publicUrl: config.publicUrl,
  intervalMinutes: config.monitorAlertIntervalMinutes,
  signal: controller.signal,
});

// Poller del PULSE PROATTIVO: task SEPARATO dal loop dei job, sul proprio
// intervallo. Solo dentro la finestra oraria d'istanza (ora locale in
// PULSE_TIMEZONE, weekend escluso di default) cerca i progetti con
// pulseEnabled+backlogEnabled che sono FERMI — nessun job AI in volo, nessuna
// decisione umana pendente — e con voci proponibili nel backlog, e pubblica una
// `project.pulse` con le prime 3 proposte del ranking deterministico. Nessun
// agente, nessun mirror: è tutto SQL, quindi NON usa il serializer per-progetto.
// È BEST-EFFORT (non fa mai crashare il worker) e NON tocca il lock/heartbeat
// dei job. Si ferma sullo stesso AbortSignal.
startPulsePoller({
  db,
  publicUrl: config.publicUrl,
  sendWindow: {
    timezone: config.pulseTimezone,
    hour: config.pulseSendHour,
    weekdaysOnly: config.pulseWeekdaysOnly,
  },
  intervalMinutes: config.pulsePollMinutes,
  signal: controller.signal,
});

console.error(
  `[stubwise-worker] avviato (concurrency ${config.concurrency}, db-pool ${config.databasePoolMax}, mirrors in ${config.mirrorsDir}` +
    `, usage-poll ${config.usagePollMinutes > 0 ? `ogni ${config.usagePollMinutes}'` : "disabilitato"}` +
    `, credential-test ${config.credentialTestPollSeconds > 0 ? `ogni ${config.credentialTestPollSeconds}"` : "disabilitato"}` +
    `, docs-auto-update ${config.docsAutoUpdatePollSeconds > 0 ? `ogni ${config.docsAutoUpdatePollSeconds}"` : "disabilitato"}` +
    `, pr-review ${config.prReviewPollSeconds > 0 ? `ogni ${config.prReviewPollSeconds}"` : "disabilitato"}` +
    `, limit-resume ${config.limitResumePollMinutes > 0 ? `ogni ${config.limitResumePollMinutes}'` : "disabilitato"}` +
    `, daily-report ${config.dailyReportPollMinutes > 0 ? `ogni ${config.dailyReportPollMinutes}'` : "disabilitato"}` +
    `, backlog ${config.backlogPollSeconds > 0 ? `ogni ${config.backlogPollSeconds}"` : "disabilitato"}` +
    `, backlog-chat-turn ${config.backlogChatTurnPollSeconds > 0 ? `ogni ${config.backlogChatTurnPollSeconds}" (ttl ${config.backlogChatSessionTtlMinutes}')` : "disabilitato"}` +
    `, graph ${config.graphPollSeconds > 0 ? `ogni ${config.graphPollSeconds}"` : "disabilitato"}` +
    `, plugins ${config.pluginPollSeconds > 0 ? `ogni ${config.pluginPollSeconds}" (in ${config.pluginsDir})` : "disabilitato"}` +
    `, monitor-rollup ${config.monitorRollupIntervalMinutes > 0 ? `ogni ${config.monitorRollupIntervalMinutes}'` : "disabilitato"}` +
    `, monitor-alert ${config.monitorAlertIntervalMinutes > 0 ? `ogni ${config.monitorAlertIntervalMinutes}'` : "disabilitato"}` +
    `, pulse ${config.pulsePollMinutes > 0 ? `ogni ${config.pulsePollMinutes}' (finestra ${config.pulseSendHour}:00 ${config.pulseTimezone}${config.pulseWeekdaysOnly ? ", feriali" : ""})` : "disabilitato"}` +
    `, push ${config.push ? `relay ${config.push.relayUrl}` : "spente (PUSH_RELAY_URL vuota)"})`,
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
