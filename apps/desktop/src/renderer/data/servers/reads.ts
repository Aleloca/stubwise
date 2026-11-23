import { serverCommandsOf, type ServerCommandRow } from "../../domain/servers/commands";
import { personMasker } from "../access/hidden";
import { planDigest, prunes } from "../../domain/servers/fixPlan";
import { canStopServerFix } from "./fixPermissions";
import {
  fixSteps,
  serverFixStatus,
  serverTaskState,
  type FixStartBlock,
  type FixStep,
  type ServerFixStatus,
  type ServerTaskState,
} from "../../domain/servers/fixGate";
import { serverHealth, type ServerHealth } from "../../domain/servers/health";
import { downsample, downsampleByTime, downsampleSamples } from "../../domain/servers/metrics";
import { removalScript, type ScriptLang } from "../../domain/servers/installScript";
import { serverInProject } from "../../domain/servers/projects";
import { accessState } from "../../domain/servers/sshAccess";
import { fold } from "../../domain/textSearch";
import {
  canSeeConversation,
  conversationPermissions,
  copy,
  eventsOf,
  gate,
  now,
  state,
  visibleProjectIds,
} from "../store";
import type {
  CheckSample,
  Conversation,
  MetricPoint,
  ServerAnalysis,
  ServerEpisode,
  Task,
} from "../types";
import { forbidden, invalid, notFound } from "../writer";
import {
  canManageSsh,
  canMonitor,
  codeNumber,
  serverFixStartBlock,
  homeProjectCode,
  inArchivedOnlyOf,
  installCommandOf,
  metricsSince,
  projectServerCodes,
  sees,
  serverDetail,
  serverFor,
  serverRow,
  serversVisibleTo,
  pruneWarningOf,
  type PruneWarning,
  type ServerDetail,
  type ServerRow,
} from "./visibility";

// Le letture dei Server (area 8b). La lista di un progetto che chi guarda
// non vede è vuota; un server invisibile risponde `not_found`, come uno che
// non esiste (R-G5). I grafici non portano mai più di `METRIC_POINTS_MAX`
// punti (RF 5): i giorni lunghi si riducono a media.

/** I server degli ambienti del progetto (R-L2), in ordine di numero. */
export async function listProjectServers(projectId: string): Promise<ServerRow[]> {
  const me = await gate("servers.listProjectServers");
  if (!sees(me, projectId)) return [];
  return projectServerCodes(projectId).flatMap((code) => {
    const s = state.servers.find((x) => x.code === code);
    return s ? [serverRow(me, s)] : [];
  });
}

/** Una riga di «Tutti i server» (area 9b): la riga di sempre, coi progetti che chi guarda vede. */
export type InstanceServerRow = ServerRow & {
  /** I progetti dei cui ambienti il server fa parte, solo quelli che chi guarda vede (R-G5), per codice. */
  projects: { code: string; name: string }[];
  /** Nessun ambiente lo usa (R-L7). Un server di soli progetti invisibili NON è orfano. */
  orphan: boolean;
  /**
   * Area 9c (Task 5): lo usano solo ambienti di progetti archiviati. La riga
   * lo dice senza nomi («Only in archived projects»), a chiunque la legga:
   * nessun progetto nella colonna, nemmeno per gli ex membri.
   */
  inArchivedOnly: boolean;
};

/**
 * Tutti i server dell'istanza (Amministrazione → Servers, area 9b), per chi
 * ha `monitor.manage` (altrimenti `forbidden`), in ordine di numero. I
 * progetti solo se chi guarda li vede: un server che sta solo in progetti
 * invisibili ha `projects: []` e non è orfano.
 */
export async function listAllServers(): Promise<InstanceServerRow[]> {
  const me = await gate("servers.listAllServers");
  if (!canMonitor(me)) throw forbidden();
  const visible = visibleProjectIds(me);
  return [...state.servers]
    .sort((a, b) => codeNumber(a.code) - codeNumber(b.code))
    .map((s) => {
      const used = new Set(
        state.environments.filter((e) => e.servers.some((x) => x.serverCode === s.code)).map((e) => e.projectId),
      );
      const projects = [...used]
        .filter((id) => visible.has(id))
        .map((id) => state.projectsById.get(id)!)
        .map((p) => ({ code: p.code, name: p.name }))
        .sort((a, b) => a.code.localeCompare(b.code));
      return {
        ...serverRow(me, s),
        projects,
        orphan: used.size === 0,
        inArchivedOnly: inArchivedOnlyOf(s.code),
      };
    });
}

/**
 * I server che chi guarda può collegare a un ambiente (area 8, F4a, S3): quelli
 * che vede, in ordine di numero. Un collegamento non allarga la visibilità
 * oltre ciò che vede chi scrive; il form degli ambienti li suggerisce.
 */
export async function listLinkableServers(): Promise<{ code: string; name: string }[]> {
  const me = await gate("servers.listLinkableServers");
  const visible = serversVisibleTo(me);
  return state.servers
    .filter((s) => visible.has(s.code))
    .sort((a, b) => codeNumber(a.code) - codeNumber(b.code))
    .map((s) => ({ code: s.code, name: s.name }));
}

/** Il dettaglio di un server (`SRV-1`); `not_found` se invisibile o inesistente. */
export async function getServer(code: string): Promise<ServerDetail> {
  const me = await gate("servers.getServer");
  return serverDetail(me, serverFor(me, code));
}

/** Dal 9b anche 30 e 90 giorni (il seme li copre: 30 s per gli ultimi 7, poi a passo largo). */
export type MetricRange = "1h" | "24h" | "7d" | "30d" | "90d";

const RANGE_MS: Record<MetricRange, number> = {
  "1h": 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
  "90d": 90 * 24 * 3_600_000,
};

export interface ServerMetrics {
  points: MetricPoint[];
  truncated: boolean;
  /** Quanti campioni c'erano nell'intervallo prima della riduzione (la nota sotto i grafici). */
  sampleCount: number;
  /**
   * A 30 e 90 giorni (area 9b): di quanti secondi ogni punto è la media (la
   * frase «Each point averages about 2 hours.»); `null` negli altri
   * intervalli o se la serie non si è ridotta.
   */
  averagedSeconds: number | null;
  /**
   * Con un controllo (R-L1): i suoi campioni nello stesso intervallo, per il
   * grafico «Response time» e le fasce dei momenti giù; `null` senza.
   */
  check: { samples: CheckSample[]; truncated: boolean; sampleCount: number } | null;
}

/** Le metriche di un server nell'intervallo (ultimi 1h / 24h / 7d / 30d / 90d), ridotte per il grafico. */
export async function getServerMetrics(
  code: string,
  range: MetricRange,
  checkId?: string,
): Promise<ServerMetrics> {
  const me = await gate("servers.getServerMetrics");
  const server = serverFor(me, code);
  const fromMs = Date.parse(now()) - RANGE_MS[range];
  let check: ServerMetrics["check"] = null;
  if (checkId !== undefined) {
    const own = state.serverChecks.find((c) => c.id === checkId && c.serverCode === server.code);
    if (!own) throw notFound();
    const samples = (state.serverCheckSamples.get(checkId) ?? []).filter(
      (s) => Date.parse(s.ts) > fromMs,
    );
    check = { ...downsampleSamples(samples), sampleCount: samples.length };
  }
  // La rete in byte al SECONDO (review F4a, M2): ogni punto porta i byte del
  // suo intervallo (30 s di recente, un passo largo più indietro); divisi per
  // la sua durata, la scala non cambia con l'intervallo scelto.
  const all = metricsSince(server.code, fromMs).map((p, i, list) => {
    const prev = list[i - 1];
    const seconds = Math.max(
      server.sampleIntervalSeconds,
      prev ? (Date.parse(p.ts) - Date.parse(prev.ts)) / 1000 : server.sampleIntervalSeconds,
    );
    return { ...p, netRxBytes: p.netRxBytes / seconds, netTxBytes: p.netTxBytes / seconds };
  });
  // Copie: i punti del seme sono condivisi (congelati), mai riferimenti allo stato.
  // Oltre i 7 giorni la serie ha due passi: si ricampiona per durata, non per indice.
  if (range === "30d" || range === "90d") {
    const { windowMs, ...reduced } = downsampleByTime(all, fromMs, Date.parse(now()));
    return copy({
      ...reduced,
      sampleCount: all.length,
      averagedSeconds: windowMs === null ? null : Math.round(windowMs / 1000),
      check,
    });
  }
  // Fino a 7 giorni la nota è quella dei punti ridotti («Showing 300 averaged
  // points of N samples», da `sampleCount`), non la finestra.
  return copy({ ...downsample(all), sampleCount: all.length, averagedSeconds: null, check });
}

export interface ServerSearchResult {
  code: string;
  name: string;
  /** Il progetto da cui si apre (`serverHref`): il principale, o il primo visibile. */
  projectCode: string;
}

/** La chiave pubblica d'istanza del prototipo: finta, stabile (il server la genera una volta). */
const PROTOTYPE_COMMAND_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPr0t0typeC0mmandKeyN0tReal0000000000000 stubwise-commands";

/**
 * La chiave pubblica d'istanza che verifica i comandi dell'agente (area 8,
 * F4b, R3; `GET /api/servers/command-key`): va nel comando d'installazione
 * con le operazioni accese, e l'agente la fissa. `monitor.manage`.
 */
export async function getCommandKey(): Promise<{ publicKey: string }> {
  const me = await gate("servers.getCommandKey");
  if (!canMonitor(me)) throw forbidden();
  return { publicKey: PROTOTYPE_COMMAND_KEY };
}

/**
 * Il comando dell'accesso SSH, da rivedere (contiene solo chiavi pubbliche):
 * quello delle chiavi in attesa se ce ne sono, altrimenti di quelle in uso.
 * `servers.ssh.manage`; `invalid: state` senza chiavi. Come ogni lettura non
 * raggiunge le private (`secrets.ts`).
 */
export async function getInstallCommand(
  code: string,
  lang: ScriptLang = "en",
): Promise<{ command: string }> {
  const me = await gate("servers.getInstallCommand");
  const server = serverFor(me, code);
  if (!canManageSsh(me)) throw forbidden();
  const command = installCommandOf(server.code, lang);
  if (command === null) throw invalid("state");
  return { command };
}

/**
 * Il comando che toglie l'utente di lettura dal server, da rivedere dopo una
 * revoca (il «⋯» della parte, Task 8): la stessa fonte del risultato di
 * `revokeSshAccess`. `servers.ssh.manage`; `invalid: state` se l'accesso
 * non è revocato.
 */
export async function getRemovalCommand(
  code: string,
  lang: ScriptLang = "en",
): Promise<{ command: string }> {
  const me = await gate("servers.getRemovalCommand");
  const server = serverFor(me, code);
  if (!canManageSsh(me)) throw forbidden();
  if (accessState(state.serverAccess.get(server.code)) !== "revoked") throw invalid("state");
  return { command: removalScript(server.code, lang) };
}

/** Il blocco «Server» di una task di server (area 8b, Task 9). */
export interface ServerTaskInfo {
  /**
   * Il server della task; `null` se chi guarda non lo vede più (R-G5) o non
   * esiste più. `projectCode`: dove si apre il suo dettaglio («Open →»): il
   * progetto della task se il server ci sta ancora, altrimenti un altro
   * progetto che chi guarda vede e che lo usa.
   */
  server: { code: string; name: string; projectCode: string | null } | null;
  /**
   * Il server non esiste più («SRV-n · deleted»). Lo riceve solo chi, alla
   * cancellazione, vedeva uno dei progetti che lo usavano (la lapide di
   * `deleteServer`): per lui dirlo non rivela niente. Agli altri, e per un
   * server che esiste ma non si vede, `false` (R-G5: «A server you can't see»).
   */
  serverGone: boolean;
  episode: ServerEpisode | null;
  state: ServerTaskState;
  /** Perché chi guarda non può avviare la correzione adesso; `null` se può. */
  startBlock: FixStartBlock | null;
  /**
   * La correzione come la dice `serverFixViewSchema` (area 8, F4b): il
   * piano coi passi, l'approvazione, cosa può fare chi guarda, il registro
   * dei comandi. `null` con `server` nullo (R-G5).
   */
  fix: ServerFixInfo | null;
  /** L'ultima sessione di correzione della task (la scheda del piano, i comandi). */
  fixConversationId: string | null;
  /** La salute del server adesso (la riga del server); `null` con `server` nullo. */
  health: ServerHealth | null;
  /**
   * L'analisi che ha aperto la task: com'è finita, la sua proposta e la
   * sessione («Read the analysis →», `null` se chi guarda non la vede).
   * `null` se la task non viene da un'analisi visibile.
   */
  analysis: {
    outcome: ServerAnalysis["outcome"];
    proposal: string | null;
    conversationId: string | null;
  } | null;
  /** I nomi dei controlli nominati dai motivi dell'episodio (id → nome). */
  checkNames: Record<string, string>;
  /**
   * Build app: il codice del server sparito (o tolto dal progetto), per
   * «SRV-n · deleted» quando la task non lo porta.
   */
  goneCode?: string;
  /** Quando la correzione è arrivata allo stato di adesso (l'ultimo cambio della sessione). */
  stateAt: string | null;
  /**
   * Solo `stopped`: perché. `byId` SOLO per lo Stop di una persona («Fix
   * stopped by …»); altrimenti il motivo (`reason`: revoca, accesso non più
   * usabile, server tolto; `outcome`: errore, tempo scaduto).
   */
  stop: {
    byId: string | null;
    reason: "operations_off" | "server_gone" | null;
    outcome: "stopped" | "failed" | "timed_out" | "ok";
  } | null;
}

/**
 * La correzione di una task di server per chi guarda (area 8, F4b): i
 * concetti di `serverFixViewSchema` e, per il registro, di
 * `serverCommandViewSchema`, così l'adattatore dell'app li mappa.
 */
export interface ServerFixInfo {
  status: ServerFixStatus;
  /**
   * Perché non c'è un piano, o perché si è fermata: un CODICE come quello
   * del server (`no_plan`, `schema`, `container_of_other_project`,
   * `operations_off`, `step_failed:<n>`), mai testo del modello.
   */
  planError: string | null;
  /** I passi dell'ultimo piano (azioni dell'insieme chiuso), con lo stato. */
  steps: FixStep[];
  approval: { byId: string; at: string } | null;
  rejection: { byId: string; at: string; note: string } | null;
  /** L'agente ha le operazioni accese: senza, nessun piano si esegue. */
  operationsOn: boolean;
  canRequestPlan: boolean;
  canApprove: boolean;
  /** Rifiutare: anche con l'approvazione spenta (operazioni dell'agente spente). */
  canReject: boolean;
  canStop: boolean;
  /** L'ha chiesta chi guarda (la scheda dice che approvando partono i comandi). */
  startedByViewer: boolean;
  /** I comandi della correzione, in ordine (letture e azioni; uscite NON fidate). */
  commands: ServerCommandRow[];
  /** Con un piano che libera spazio, gli altri progetti del server: l'avviso prima di approvare. */
  pruneWarning: PruneWarning | null;
  /**
   * L'impronta del piano che aspetta l'approvazione (decisione 3): Approva
   * la rimanda così com'è (`approveServerFix`); `null` senza un piano che aspetta.
   */
  planDigest: string | null;
  /** La sessione di Claude della correzione, da leggere (come ha ragionato). */
  sessionId: string | null;
}

type PlanEvent = Extract<ReturnType<typeof eventsOf>[number], { type: "plan" }>;

/** La correzione di `task` per chi guarda, dall'ultima sessione (`run`). */
function fixInfo(
  me: string,
  task: Task,
  code: string,
  run: Conversation | null,
  // R.1414 (lotto 3): il masker della risposta (chi ha approvato, rifiutato, fermato).
  mask: ReturnType<typeof personMasker> = personMasker(me),
): ServerFixInfo {
  const events = run ? eventsOf(run.id) : [];
  const fixRun = run ? { c: run, events } : null;
  const plan = events.filter((e): e is PlanEvent => e.type === "plan").at(-1);
  // Quando: dal registro decisioni (stessa scrittura della decisione).
  const decidedAt = (outcome: "approved" | "rejected") =>
    state.decisionLog
      .filter(
        (d) =>
          d.taskId === task.id &&
          d.source === "plan_review" &&
          d.planOutcome === outcome &&
          d.decidedById === plan?.decidedById,
      )
      .at(-1)?.decidedAt ?? run?.updatedAt ?? now();
  const perms = run ? conversationPermissions(me, run) : null;
  const live = run !== null && run.state !== "finished";
  const steps = fixSteps(fixRun);
  const lastPhase = events.filter((e) => e.type === "phase").at(-1);
  const failedStep = steps.find((x) => x.status === "failed");
  const planError =
    lastPhase?.type === "phase" && lastPhase.planError
      ? lastPhase.planError
      : lastPhase?.type === "phase" && lastPhase.reason === "operations_off"
        ? "operations_off"
        : failedStep
          ? `step_failed:${failedStep.index}`
          : null;
  return {
    status: serverFixStatus(task, fixRun),
    planError,
    steps,
    approval:
      plan?.status === "approved" && plan.decidedById
        ? { byId: mask(plan.decidedById), at: decidedAt("approved") }
        : null,
    rejection:
      plan?.status === "rejected" && plan.decidedById
        ? { byId: mask(plan.decidedById), at: decidedAt("rejected"), note: plan.instructions ?? "" }
        : null,
    operationsOn: state.servers.find((x) => x.code === code)?.agentOperations ?? false,
    canRequestPlan: serverFixStartBlock(me, task) === null,
    canApprove: perms?.canDecidePlan ?? false,
    canReject: perms?.canRejectPlan ?? false,
    startedByViewer: run?.ownerId === me,
    canStop: live && canStopServerFix(me, task.projectId),
    commands: run ? serverCommandsOf(events, run.ownerId) : [],
    planDigest: plan?.status === "pending" && plan.serverPlan ? planDigest(plan.serverPlan) : null,
    sessionId: run?.id ?? null,
    pruneWarning:
      plan?.serverPlan &&
      prunes(plan.serverPlan) &&
      serverInProject(code, task.projectId, state.environments)
        ? pruneWarningOf(me, code, task.projectId)
        : null,
  };
}

/**
 * Il blocco «Server» della task: server, episodio, a che punto è la
 * correzione (`serverTaskState`, dall'ultima sessione con `serverFix`),
 * perché chi guarda non può avviarla e lo stato dell'accesso di correzione.
 * `null` per una task senza `serverRef`; `not_found` per una task invisibile.
 */
export async function getServerTaskInfo(taskId: string): Promise<ServerTaskInfo | null> {
  const me = await gate("servers.getServerTaskInfo");
  const mask = personMasker(me);
  const task = state.tasksById.get(taskId);
  if (!task || !visibleProjectIds(me).has(task.projectId)) throw notFound();
  if (!task.serverRef) return null;
  const code = task.serverRef.serverCode;
  const s = serversVisibleTo(me).has(code) ? state.servers.find((x) => x.code === code) : undefined;
  const episode = s
    ? (state.serverEpisodes.find((e) => e.id === task.serverRef!.episodeId) ?? null)
    : null;
  const run = state.conversations
    .filter((c) => c.kind === "task_run" && c.taskId === task.id && c.serverFix)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  // Solo col server visibile: l'analisi e i controlli dicono del server.
  const analysis = s ? state.serverAnalyses.find((a) => a.taskId === task.id) : undefined;
  const session = analysis
    ? state.conversations.find((c) => c.id === analysis.conversationId)
    : undefined;
  const checkNames: Record<string, string> = {};
  for (const r of episode?.reasons ?? []) {
    if (r.kind !== "check") continue;
    const check = state.serverChecks.find((c) => c.id === r.checkId);
    if (check) checkNames[check.id] = check.name;
  }
  const taskState = serverTaskState(task, run ? { c: run, events: eventsOf(run.id) } : null);
  const lastPhase = run
    ? eventsOf(run.id)
        .filter((e) => e.type === "phase")
        .at(-1)
    : undefined;
  const stop =
    taskState === "stopped" && run
      ? {
          byId: lastPhase?.type === "phase" ? mask(lastPhase.stoppedById ?? null) : null,
          reason:
            lastPhase?.type !== "phase"
              ? null
              : lastPhase.reason === "operations_off" || lastPhase.reason === "server_gone"
                ? lastPhase.reason
                : null,
          outcome: run.outcome ?? "stopped",
        }
      : null;
  const taskProject = state.projectsById.get(task.projectId)!.code;
  return copy({
    server: s
      ? {
          code: s.code,
          name: s.name,
          projectCode: serverInProject(s.code, task.projectId, state.environments)
            ? taskProject
            : homeProjectCode(me, s),
        }
      : null,
    // Solo a chi, alla cancellazione, vedeva il server: vede uno dei progetti
    // che lo usavano allora (la lapide). Un server già spostato altrove o
    // orfano resta «A server you can't see» (R-G5).
    serverGone:
      !state.servers.some((x) => x.code === code) &&
      (state.serverTombstones.get(code) ?? []).some((id) => visibleProjectIds(me).has(id)),
    episode,
    state: taskState,
    startBlock: serverFixStartBlock(me, task),
    fix: s ? fixInfo(me, task, s.code, run ?? null, mask) : null,
    fixConversationId: run?.id ?? null,
    health: s ? serverHealth(s, state.serverEpisodes, now()) : null,
    analysis: analysis
      ? {
          outcome: analysis.outcome,
          proposal: analysis.proposal ?? null,
          conversationId: session && canSeeConversation(me, session) ? session.id : null,
        }
      : null,
    checkNames,
    stateAt: run?.updatedAt ?? null,
    stop,
  });
}

/**
 * ⌘K: i server per codice, nome o hostname, solo fra quelli che chi cerca
 * vede. Un server orfano (R-L7, solo per chi ha `monitor.manage`) non ha un
 * progetto suo: si apre nel primo progetto che chi cerca vede, per codice
 * (la vista d'istanza dei server è dell'area 9).
 */
export async function searchServers(q: string): Promise<ServerSearchResult[]> {
  const me = await gate("servers.searchServers");
  const needle = fold(q.trim());
  if (!needle) return [];
  const visible = serversVisibleTo(me);
  const projects = visibleProjectIds(me);
  const firstProject = state.projects
    .filter((p) => projects.has(p.id))
    .map((p) => p.code)
    .sort()[0];
  return state.servers
    .filter((s) => visible.has(s.code))
    .filter((s) => [s.code, s.name, s.hostname ?? ""].some((x) => fold(x).includes(needle)))
    .flatMap((s) => {
      const projectCode = homeProjectCode(me, s) ?? firstProject;
      return projectCode ? [{ code: s.code, name: s.name, projectCode }] : [];
    });
}
