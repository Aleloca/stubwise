import {
  serverTaskState,
  type FixStartBlock,
  type ServerTaskState,
} from "../../domain/servers/fixGate";
import { serverHealth, type ServerHealth } from "../../domain/servers/health";
import { downsample, downsampleByTime, downsampleSamples } from "../../domain/servers/metrics";
import { removalScript, type ScriptLang } from "../../domain/servers/installScript";
import { serverInProject } from "../../domain/servers/projects";
import { accessState, type AccessState } from "../../domain/servers/sshAccess";
import { fold } from "../../domain/textSearch";
import { canSeeConversation, copy, eventsOf, gate, now, state, visibleProjectIds } from "../store";
import type { CheckSample, MetricPoint, ServerAnalysis, ServerEpisode } from "../types";
import { forbidden, invalid, notFound } from "../writer";
import {
  canManageSsh,
  canMonitor,
  codeNumber,
  serverFixStartBlock,
  homeProjectCode,
  installCommandOf,
  metricsSince,
  projectServerCodes,
  sees,
  serverDetail,
  serverFor,
  serverRow,
  serversVisibleTo,
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
      return { ...serverRow(me, s), projects, orphan: used.size === 0 };
    });
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
   * Con un controllo (R-L1): i suoi campioni nello stesso intervallo, per il
   * grafico «Response time» e le fasce dei momenti giù; `null` senza.
   */
  check: { samples: CheckSample[]; truncated: boolean; sampleCount: number } | null;
}

/** Le metriche di un server nell'intervallo (ultimi 1h / 24h / 7d), ridotte per il grafico. */
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
  const all = metricsSince(server.code, fromMs);
  // Copie: i punti del seme sono condivisi (congelati), mai riferimenti allo stato.
  // Oltre i 7 giorni la serie ha due passi: si ricampiona per durata, non per indice.
  const reduced =
    range === "30d" || range === "90d"
      ? downsampleByTime(all, fromMs, Date.parse(now()))
      : downsample(all);
  return copy({ ...reduced, sampleCount: all.length, check });
}

export interface ServerSearchResult {
  code: string;
  name: string;
  /** Il progetto da cui si apre (`serverHref`): il principale, o il primo visibile. */
  projectCode: string;
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
 * Il comando che toglie i due utenti dal server, da rivedere dopo una
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
  /** Lo stato dell'accesso di correzione; `null` con `server` nullo (R-G5). */
  fixAccess: AccessState | null;
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
  /** Quando la correzione è arrivata allo stato di adesso (l'ultimo cambio della sessione). */
  stateAt: string | null;
  /**
   * Solo `stopped`: perché. `byId` SOLO per lo Stop di una persona («Fix
   * stopped by …»); altrimenti il motivo (`reason`: revoca, accesso non più
   * usabile, server tolto; `outcome`: errore, tempo scaduto).
   */
  stop: {
    byId: string | null;
    reason: "fix_access_revoked" | "fix_access_unusable" | "server_gone" | null;
    outcome: "stopped" | "failed" | "timed_out" | "ok";
  } | null;
}

/**
 * Il blocco «Server» della task: server, episodio, a che punto è la
 * correzione (`serverTaskState`, dall'ultima sessione con `serverFix`),
 * perché chi guarda non può avviarla e lo stato dell'accesso di correzione.
 * `null` per una task senza `serverRef`; `not_found` per una task invisibile.
 */
export async function getServerTaskInfo(taskId: string): Promise<ServerTaskInfo | null> {
  const me = await gate("servers.getServerTaskInfo");
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
  const access = state.serverAccess.get(code);
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
          byId: lastPhase?.type === "phase" ? (lastPhase.stoppedById ?? null) : null,
          reason:
            lastPhase?.type === "phase" && lastPhase.reason && lastPhase.reason !== "item_closed"
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
    fixAccess: s ? accessState(access) : null,
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
