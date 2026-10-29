import {
  fixStartBlock,
  serverTaskState,
  type FixStartBlock,
  type ServerTaskState,
} from "../../domain/servers/fixGate";
import { downsample, downsampleSamples } from "../../domain/servers/metrics";
import { accessState, type AccessState } from "../../domain/servers/sshAccess";
import { fold } from "../../domain/textSearch";
import { copy, eventsOf, gate, latestRunOf, now, state, visibleProjectIds } from "../store";
import type { CheckSample, MetricPoint, ServerEpisode } from "../types";
import { can, viewerFor } from "../viewer";
import { forbidden, invalid, notFound } from "../writer";
import {
  canManageSsh,
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

/** Il dettaglio di un server (`SRV-1`); `not_found` se invisibile o inesistente. */
export async function getServer(code: string): Promise<ServerDetail> {
  const me = await gate("servers.getServer");
  return serverDetail(me, serverFor(me, code));
}

export type MetricRange = "1h" | "24h" | "7d";

const RANGE_MS: Record<MetricRange, number> = {
  "1h": 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
};

export interface ServerMetrics {
  points: MetricPoint[];
  truncated: boolean;
  /**
   * Con un controllo (R-L1): i suoi campioni nello stesso intervallo, per il
   * grafico «Response time» e le fasce dei momenti giù; `null` senza.
   */
  check: { samples: CheckSample[]; truncated: boolean } | null;
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
    check = downsampleSamples(samples);
  }
  // Copie: i punti del seme sono condivisi (congelati), mai riferimenti allo stato.
  return copy({ ...downsample(metricsSince(server.code, fromMs)), check });
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
export async function getInstallCommand(code: string): Promise<{ command: string }> {
  const me = await gate("servers.getInstallCommand");
  const server = serverFor(me, code);
  if (!canManageSsh(me)) throw forbidden();
  const command = installCommandOf(server.code);
  if (command === null) throw invalid("state");
  return { command };
}

/** Il blocco «Server» di una task di server (area 8b, Task 9). */
export interface ServerTaskInfo {
  /** Il server della task; `null` se chi guarda non lo vede più (R-G5) o non esiste più. */
  server: { code: string; name: string } | null;
  episode: ServerEpisode | null;
  state: ServerTaskState;
  /** Perché chi guarda non può avviare la correzione adesso; `null` se può. */
  startBlock: FixStartBlock | null;
  fixAccess: AccessState;
  /** L'ultima sessione di correzione della task (la scheda del piano, i comandi). */
  fixConversationId: string | null;
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
  const live = latestRunOf(task.id);
  const access = state.serverAccess.get(code);
  return copy({
    server: s ? { code: s.code, name: s.name } : null,
    episode,
    state: serverTaskState(task, run ? { c: run, events: eventsOf(run.id) } : null),
    startBlock: fixStartBlock({
      hasOperate: can(viewerFor(me), "servers.operate", task.projectId),
      task,
      access,
      liveRun: live !== undefined && live.state !== "finished",
    }),
    fixAccess: accessState(access),
    fixConversationId: run?.id ?? null,
  });
}

/** ⌘K: i server per codice, nome o hostname, solo fra quelli che chi cerca vede. */
export async function searchServers(q: string): Promise<ServerSearchResult[]> {
  const me = await gate("servers.searchServers");
  const needle = fold(q.trim());
  if (!needle) return [];
  const visible = serversVisibleTo(me);
  return state.servers
    .filter((s) => visible.has(s.code))
    .filter((s) => [s.code, s.name, s.hostname ?? ""].some((x) => fold(x).includes(needle)))
    .flatMap((s) => {
      const projectCode = homeProjectCode(me, s);
      return projectCode ? [{ code: s.code, name: s.name, projectCode }] : [];
    });
}
