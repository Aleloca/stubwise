import { serverHealth, serverWork, type ServerWork } from "../../domain/servers/health";
import { downsample } from "../../domain/servers/metrics";
import { alertProjectsOf } from "../../domain/servers/projects";
import { accessState, type AccessState } from "../../domain/servers/sshAccess";
import { holds, sees } from "../access";
import { now, state, visibleProjectIds } from "../store";
import type {
  MonitoredServer,
  ProjectEnvironment,
  ServerAnalysis,
  ServerCheck,
  ServerDisk,
  ServerEpisode,
  ServerService,
  ServerThresholds,
} from "../types";
import { can, viewerFor } from "../viewer";
import { notFound } from "../writer";

// Chi vede che cosa nei Server (area 8b) — l'unica regola, per letture e
// scritture. Un server è un oggetto d'istanza che entra nei progetti
// attraverso gli ambienti (R-L2: una riga di `servers` per repository o per
// tutto il progetto): lo vede chi vede un progetto con un ambiente
// qualunque che lo usa. Un server invisibile risponde come uno che non
// esiste (R-G5). Salute, lavoro di Claude e stato dell'accesso si DERIVANO
// qui, con le regole pure di `domain/servers`. La chiave dell'agente
// (`sk_…`) non sta nello stato: nessuna lettura la può restituire.

export { holds, sees };

/** `monitor.manage` (d'istanza): server, chiave dell'agente, soglie, controlli e principale. */
export const canMonitor = (me: string): boolean => can(viewerFor(me), "monitor.manage");

/** Gli ambienti che usano `code`, nell'ordine dello stato. */
const environmentsOf = (code: string): ProjectEnvironment[] =>
  state.environments.filter((e) => e.servers.some((s) => s.serverCode === code));

/** I codici dei server di un ambiente qualunque di un progetto che `personId` vede. */
export function serversVisibleTo(personId: string): Set<string> {
  const visible = visibleProjectIds(personId);
  const out = new Set<string>();
  for (const env of state.environments) {
    if (!visible.has(env.projectId)) continue;
    for (const s of env.servers) out.add(s.serverCode);
  }
  return out;
}

export function serverFor(me: string, code: string): MonitoredServer {
  const server = state.servers.find((s) => s.code === code);
  if (!server || !serversVisibleTo(me).has(code)) throw notFound();
  return server;
}

/** Un controllo, attraverso il suo server (R-G5 come il server). */
export function checkFor(me: string, checkId: string): ServerCheck {
  const check = state.serverChecks.find((c) => c.id === checkId);
  if (!check) throw notFound();
  serverFor(me, check.serverCode);
  return check;
}

/** I server di un progetto: quelli dei suoi ambienti, in ordine di numero. */
export function projectServerCodes(projectId: string): string[] {
  const codes = new Set<string>();
  for (const env of state.environments) {
    if (env.projectId !== projectId) continue;
    for (const s of env.servers) codes.add(s.serverCode);
  }
  return [...codes].sort((a, b) => codeNumber(a) - codeNumber(b));
}

const codeNumber = (code: string): number => Number(code.slice("SRV-".length));

const projectCodeOf = (projectId: string): string => state.projectsById.get(projectId)!.code;

// --- la riga ----------------------------------------------------------------

/** Quanti punti ha la CPU recente della riga (l'ultima ora, ridotta). */
export const RECENT_CPU_POINTS = 30;
const HOUR_MS = 3_600_000;

export interface ServerRow {
  code: string;
  name: string;
  hostname: string | null;
  status: MonitoredServer["status"];
  health: ReturnType<typeof serverHealth>;
  work: ServerWork;
  access: AccessState;
  /** Gli ambienti che lo usano, solo nei progetti che chi guarda vede. */
  environments: { projectCode: string; name: string; kind: ProjectEnvironment["kind"] }[];
  /** Il progetto principale, se chi guarda lo vede. */
  primaryProjectCode: string | null;
  /** La CPU dell'ultima ora, al più `RECENT_CPU_POINTS` valori, dal più vecchio. */
  recentCpu: number[];
}

/** I punti di `code` dopo `fromMs` (escluso), in ordine. */
export function metricsSince(code: string, fromMs: number) {
  return (state.serverMetrics.get(code) ?? []).filter((p) => Date.parse(p.ts) > fromMs);
}

function workOf(code: string): ServerWork {
  const serverTasks = state.tasks
    .filter((t) => t.serverRef?.serverCode === code)
    .map((task) => ({
      task,
      liveFix: state.conversations.some(
        (c) => c.taskId === task.id && c.serverFix?.serverCode === code && c.state !== "finished",
      ),
    }));
  return serverWork({
    analyses: state.serverAnalyses.filter((a) => a.serverCode === code),
    serverTasks,
  });
}

export function serverRow(me: string, s: MonitoredServer): ServerRow {
  const visible = visibleProjectIds(me);
  const recent = downsample(metricsSince(s.code, Date.parse(now()) - HOUR_MS), RECENT_CPU_POINTS);
  return {
    code: s.code,
    name: s.name,
    hostname: s.hostname,
    status: s.status,
    health: serverHealth(s, state.serverEpisodes, now()),
    work: workOf(s.code),
    access: accessState(state.serverAccess.get(s.code)),
    environments: environmentsOf(s.code)
      .filter((e) => visible.has(e.projectId))
      .map((e) => ({ projectCode: projectCodeOf(e.projectId), name: e.name, kind: e.kind })),
    primaryProjectCode:
      s.primaryProjectId && visible.has(s.primaryProjectId)
        ? projectCodeOf(s.primaryProjectId)
        : null,
    recentCpu: recent.points.map((p) => p.cpuPct),
  };
}

// --- il dettaglio -----------------------------------------------------------

export interface ServerEpisodeView extends ServerEpisode {
  /** L'analisi automatica, se il suo progetto si vede. */
  analysis: ServerAnalysis | null;
  /** La task nata dall'analisi, se chi guarda la vede. */
  taskCode: string | null;
}

export interface ServerDetail extends ServerRow {
  agentVersion: string | null;
  lastSeenAt: string | null;
  sampleIntervalSeconds: number;
  createdAt: string;
  thresholds: ServerThresholds;
  services: ServerService[];
  disks: ServerDisk[];
  checks: ServerCheck[];
  /** Dal più recente. */
  episodes: ServerEpisodeView[];
  /** Le produzioni che lo usano (avvisi e analisi; il principale si sceglie fra queste), visibili. */
  productionProjects: { id: string; code: string; name: string }[];
  /** `monitor.manage`: modificare, togliere, soglie, controlli, chiave dell'agente. */
  canManage: boolean;
}

function episodeView(me: string, e: ServerEpisode): ServerEpisodeView {
  const analysis = e.analysisId
    ? state.serverAnalyses.find((a) => a.id === e.analysisId)
    : undefined;
  const shown = analysis && sees(me, analysis.projectId) ? analysis : undefined;
  const task = shown?.taskId ? state.tasksById.get(shown.taskId) : undefined;
  return {
    ...structuredClone(e),
    analysis: shown ? structuredClone(shown) : null,
    taskCode: task && sees(me, task.projectId) ? task.code : null,
  };
}

export function serverDetail(me: string, s: MonitoredServer): ServerDetail {
  return {
    ...serverRow(me, s),
    agentVersion: s.agentVersion,
    lastSeenAt: s.lastSeenAt,
    sampleIntervalSeconds: s.sampleIntervalSeconds,
    createdAt: s.createdAt,
    thresholds: structuredClone(s.thresholds),
    services: structuredClone(s.services),
    disks: structuredClone(s.disks),
    checks: state.serverChecks
      .filter((c) => c.serverCode === s.code)
      .map((c) => structuredClone(c)),
    episodes: state.serverEpisodes
      .filter((e) => e.serverCode === s.code)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((e) => episodeView(me, e)),
    productionProjects: alertProjectsOf(s.code, state.environments)
      .filter((id) => sees(me, id))
      .map((id) => {
        const p = state.projectsById.get(id)!;
        return { id, code: p.code, name: p.name };
      }),
    canManage: canMonitor(me),
  };
}

/** L'indirizzo del dettaglio di un server (avvisi, ⌘K): `#/p/STW/servers/SRV-2`. */
export const serverHref = (projectCode: string, code: string): string =>
  `#/p/${projectCode}/servers/${code}`;

/**
 * Il progetto da cui si apre un server per chi guarda: il principale se lo
 * vede, altrimenti il primo progetto visibile fra i suoi ambienti.
 */
export function homeProjectCode(me: string, s: MonitoredServer): string | null {
  const visible = visibleProjectIds(me);
  if (s.primaryProjectId && visible.has(s.primaryProjectId))
    return projectCodeOf(s.primaryProjectId);
  const env = environmentsOf(s.code).find((e) => visible.has(e.projectId));
  return env ? projectCodeOf(env.projectId) : null;
}
