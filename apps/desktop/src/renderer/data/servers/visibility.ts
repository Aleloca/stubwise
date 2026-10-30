import { serverHealth, serverWork, type ServerWork } from "../../domain/servers/health";
import { downsample } from "../../domain/servers/metrics";
import { fixStartBlock, type FixStartBlock } from "../../domain/servers/fixGate";
import { alertProjectsOf, analysisProjectOf, serverInProject } from "../../domain/servers/projects";
import { installScript, type ScriptLang } from "../../domain/servers/installScript";
import { accessState, accessUsable, type AccessState } from "../../domain/servers/sshAccess";
import { holds, sees } from "../access";
import { latestRunOf, now, state, visibleProjectIds } from "../store";
import type {
  AiBlock,
  ServerSshAccess,
  SshAccessKind,
  SshPublicKey,
  SshUse,
  MonitoredServer,
  ProjectEnvironment,
  ServerAnalysis,
  ServerCheck,
  ServerDisk,
  ServerEpisode,
  ServerService,
  ServerThresholds,
  Task,
} from "../types";
import { can, viewerFor } from "../viewer";
import { invalid, notFound } from "../writer";

// Chi vede che cosa nei Server (area 8b) — l'unica regola, per letture e
// scritture. Un server è un oggetto d'istanza che entra nei progetti
// attraverso gli ambienti (R-L2: una riga di `servers` per repository o per
// tutto il progetto): lo vede chi vede un progetto con un ambiente
// qualunque che lo usa. Un server invisibile risponde come uno che non
// esiste (R-G5). Salute, lavoro di Claude e stato dell'accesso si DERIVANO
// qui, con le regole pure di `domain/servers`. La chiave dell'agente
// (`sk_…`) non sta nello stato: nessuna lettura la può restituire.

export { holds, sees };

/**
 * Perché `me` non può avviare adesso la correzione della task (`null` se
 * può): la regola pura `fixStartBlock` coi fatti di adesso — il server di
 * `serverRef` ancora in un ambiente del progetto della task (R-L2: chi vede
 * la task lo vede, R-G5), una sessione viva sulla task, un'altra
 * correzione viva sullo stesso server. Una sola regola per l'avvio e per
 * il blocco «Server» della task.
 */
export function serverFixStartBlock(me: string, task: Task): FixStartBlock | null {
  const code = task.serverRef?.serverCode;
  const live = latestRunOf(task.id);
  return fixStartBlock({
    hasOperate: can(viewerFor(me), "servers.operate", task.projectId),
    task,
    serverInProject:
      code !== undefined &&
      state.servers.some((s) => s.code === code) &&
      serverInProject(code, task.projectId, state.environments),
    access: code ? state.serverAccess.get(code) : undefined,
    liveRun: live !== undefined && live.state !== "finished",
    serverBusy: state.conversations.some(
      (c) => c.serverFix !== undefined && c.serverFix.serverCode === code && c.state !== "finished",
    ),
  });
}

/** `monitor.manage` (d'istanza): server, chiave dell'agente, soglie, controlli e principale. */
export const canMonitor = (me: string): boolean => can(viewerFor(me), "monitor.manage");

/** Gli ambienti che usano `code`, nell'ordine dello stato. */
const environmentsOf = (code: string): ProjectEnvironment[] =>
  state.environments.filter((e) => e.servers.some((s) => s.serverCode === code));

/**
 * I codici dei server (esistenti) che `personId` vede: quelli di un ambiente
 * qualunque di un progetto che vede e, con `monitor.manage`, anche quelli
 * che non compaiono in nessun ambiente (R-L7): un server orfano resta
 * raggiungibile da chi gestisce il monitor, che lo può ricollegare o togliere.
 */
export function serversVisibleTo(personId: string): Set<string> {
  const visible = visibleProjectIds(personId);
  const linked = new Set<string>();
  const out = new Set<string>();
  for (const env of state.environments) {
    for (const s of env.servers) {
      linked.add(s.serverCode);
      if (visible.has(env.projectId)) out.add(s.serverCode);
    }
  }
  const monitor = canMonitor(personId);
  const existing = new Set<string>();
  for (const s of state.servers) {
    existing.add(s.code);
    if (monitor && !linked.has(s.code)) out.add(s.code);
  }
  for (const code of out) if (!existing.has(code)) out.delete(code);
  return out;
}

/**
 * Le righe `servers[]` di un ambiente decidono chi vede un server (R-L2):
 * chi scrive un ambiente può nominare solo un server che esiste e che vede.
 * Uno nascosto risponde come uno inesistente (`invalid: serverCode`, R-G5),
 * altrimenti scriverne il codice basterebbe a «adottarlo».
 */
export function assertServerCodesVisible(me: string, codes: string[]): void {
  const visible = serversVisibleTo(me);
  if (codes.some((c) => !visible.has(c))) throw invalid("serverCode");
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
  /**
   * La task del lavoro (la correzione viva, o la task di server aperta più
   * recente), se chi guarda la vede; `null` senza lavoro o se è nascosta.
   */
  workTaskCode: string | null;
  access: AccessState;
  /** Gli ambienti che lo usano, solo nei progetti che chi guarda vede. */
  environments: { projectCode: string; name: string; kind: ProjectEnvironment["kind"] }[];
  /** Il progetto principale, se chi guarda lo vede. */
  primaryProjectCode: string | null;
  /**
   * Dove si apre la diagnosi (`analysisProjectOf`): il codice, o `null` se
   * chi guarda non vede quel progetto; `null` (tutto) senza produzioni, cioè
   * niente avvisi né analisi.
   */
  analysisProject: { code: string | null } | null;
  /** La CPU dell'ultima ora, al più `RECENT_CPU_POINTS` valori, dal più vecchio. */
  recentCpu: number[];
}

/** I punti di `code` dopo `fromMs` (escluso), in ordine. */
export function metricsSince(code: string, fromMs: number) {
  return (state.serverMetrics.get(code) ?? []).filter((p) => Date.parse(p.ts) > fromMs);
}

function workOf(me: string, code: string): { work: ServerWork; taskCode: string | null } {
  const serverTasks = state.tasks
    .filter((t) => t.serverRef?.serverCode === code)
    .map((task) => ({
      task,
      liveFix: state.conversations.some(
        (c) => c.taskId === task.id && c.serverFix?.serverCode === code && c.state !== "finished",
      ),
    }));
  const work = serverWork({
    analyses: state.serverAnalyses.filter((a) => a.serverCode === code),
    serverTasks,
  });
  // La task del lavoro: quella della correzione viva, o la task aperta più recente.
  const task =
    work === "fixing"
      ? serverTasks.find((t) => t.liveFix)?.task
      : work === "diagnosis_ready"
        ? serverTasks
            .filter((t) => t.task.closedAt === null)
            .map((t) => t.task)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
        : undefined;
  return { work, taskCode: task && sees(me, task.projectId) ? task.code : null };
}

export function serverRow(me: string, s: MonitoredServer): ServerRow {
  const visible = visibleProjectIds(me);
  const recent = downsample(metricsSince(s.code, Date.parse(now()) - HOUR_MS), RECENT_CPU_POINTS);
  const { work, taskCode } = workOf(me, s.code);
  const analysisId = analysisProjectOf(s.code, state.environments, s.primaryProjectId);
  return {
    code: s.code,
    name: s.name,
    hostname: s.hostname,
    status: s.status,
    health: serverHealth(s, state.serverEpisodes, now()),
    work,
    workTaskCode: taskCode,
    access: accessState(state.serverAccess.get(s.code)),
    environments: environmentsOf(s.code)
      .filter((e) => visible.has(e.projectId))
      .map((e) => ({ projectCode: projectCodeOf(e.projectId), name: e.name, kind: e.kind })),
    primaryProjectCode:
      s.primaryProjectId && visible.has(s.primaryProjectId)
        ? projectCodeOf(s.primaryProjectId)
        : null,
    analysisProject:
      analysisId === null
        ? null
        : { code: visible.has(analysisId) ? projectCodeOf(analysisId) : null },
    recentCpu: recent.points.map((p) => p.cpuPct),
  };
}

// --- il dettaglio -----------------------------------------------------------

export interface ServerEpisodeView extends ServerEpisode {
  /** L'analisi automatica, se il suo progetto si vede. */
  analysis: ServerAnalysis | null;
  /** La task nata dall'analisi, se chi guarda la vede. */
  taskCode: string | null;
  /**
   * Area 9b: l'analisi è nata ma aspetta (la coda del suo progetto in pausa):
   * il riquadro dice «Waiting: …» al posto di «Claude is looking into it».
   */
  analysisWaiting?: AiBlock | null;
}

export interface ServerDetail extends Omit<ServerRow, "access"> {
  /** Il pannello «Accesso SSH»: lo stato lo vede chiunque veda il server, le azioni chi ha `servers.ssh.manage`. */
  access: SshAccessView;
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
  /** Solo prototipo: se l'SSH risponde (il «Simula server irraggiungibile»). */
  sshReachable: boolean;
}

function episodeView(me: string, e: ServerEpisode): ServerEpisodeView {
  const analysis = e.analysisId
    ? state.serverAnalyses.find((a) => a.id === e.analysisId)
    : undefined;
  const shown = analysis && sees(me, analysis.projectId) ? analysis : undefined;
  const task = shown?.taskId ? state.tasksById.get(shown.taskId) : undefined;
  const waiting = shown
    ? state.conversations.find((c) => c.id === shown.conversationId)?.waiting
    : null;
  return {
    ...structuredClone(e),
    analysis: shown ? structuredClone(shown) : null,
    taskCode: task && sees(me, task.projectId) ? task.code : null,
    ...(waiting ? { analysisWaiting: structuredClone(waiting) } : {}),
  };
}

export function serverDetail(me: string, s: MonitoredServer): ServerDetail {
  return {
    ...serverRow(me, s),
    access: sshAccessView(me, s.code),
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
    sshReachable: s.sshReachable,
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
  const envs = environmentsOf(s.code);
  // Il principale solo se lo usa ancora: il dettaglio esiste solo lì.
  const primary = s.primaryProjectId;
  if (primary && visible.has(primary) && envs.some((e) => e.projectId === primary))
    return projectCodeOf(primary);
  const env = envs.find((e) => visible.has(e.projectId));
  return env ? projectCodeOf(env.projectId) : null;
}

// --- l'accesso SSH ----------------------------------------------------------
// Qui solo ciò che si può mostrare: lo stato e le chiavi PUBBLICHE. Le
// private stanno in `secrets.ts`, che da qui (e da ogni lettura) non si
// raggiunge (anti-obiettivo 3, test architetturale).

/** `servers.ssh.manage` (d'istanza): collegare, verificare, rigenerare, revocare. */
export const canManageSsh = (me: string): boolean => can(viewerFor(me), "servers.ssh.manage");

/** L'ultimo uso di un accesso: quando, e da quale analisi o task (il codice della task solo se chi guarda la vede). */
export interface SshUseView {
  at: string;
  label: { kind: "analysis" | "task"; code: string | null };
  /** La sessione dell'analisi («Open session», Task 8), solo se chi guarda ne vede il progetto. */
  sessionId: string | null;
}

export interface SshAccessView {
  state: AccessState;
  /** Le chiavi pubbliche in uso. */
  read: SshPublicKey | null;
  fix: SshPublicKey | null;
  /** Le chiavi generate e non ancora verificate (collegamento o rigenerazione). */
  pending: { read: SshPublicKey; fix: SshPublicKey } | null;
  verification: ServerSshAccess["verification"];
  /**
   * Se ciascun accesso si può usare adesso (`accessUsable`): durante una
   * rigenerazione dipende anche dall'esito delle vecchie chiavi, che la
   * vista non porta, quindi la UI non lo può ricavare da sé.
   */
  usable: Record<SshAccessKind, boolean>;
  lastUse: { read: SshUseView | null; fix: SshUseView | null };
  /** Quando è stato revocato («Revoked Oct 29», il comando di rimozione); `null` se non lo è. */
  revokedAt: string | null;
  canManage: boolean;
}

function useView(me: string, use: SshUse | undefined): SshUseView | null {
  if (!use) return null;
  const ref = use.ref;
  const analysis =
    ref.kind === "analysis" ? state.serverAnalyses.find((a) => a.id === ref.analysisId) : undefined;
  const taskId = ref.kind === "task" ? ref.taskId : (analysis?.taskId ?? null);
  const task = taskId ? state.tasksById.get(taskId) : undefined;
  return {
    at: use.at,
    label: { kind: ref.kind, code: task && sees(me, task.projectId) ? task.code : null },
    sessionId: analysis && sees(me, analysis.projectId) ? analysis.conversationId : null,
  };
}

/** Il pannello «Accesso SSH» di `code` per chi guarda (che lo vede già: passa da `serverFor`). */
export function sshAccessView(me: string, code: string): SshAccessView {
  const a = state.serverAccess.get(code);
  return structuredClone({
    state: accessState(a),
    read: a?.keys?.read ?? null,
    fix: a?.keys?.fix ?? null,
    pending: a?.pending ?? null,
    verification: a?.verification ?? null,
    usable: { read: accessUsable(a, "read"), fix: accessUsable(a, "fix") },
    lastUse: { read: useView(me, a?.lastUse.read), fix: useView(me, a?.lastUse.fix) },
    revokedAt: a?.revokedAt ?? null,
    canManage: canManageSsh(me),
  });
}

/**
 * Il comando da incollare sul server: lo script coi due accessi e le sole
 * chiavi PUBBLICHE — quelle in attesa se ce ne sono (collegamento o
 * rigenerazione), altrimenti quelle in uso. In rigenerazione (R-L8) ogni
 * utente riceve anche la chiave in uso, che resta valida finché la verifica
 * delle nuove non riesce. `null` senza chiavi. L'indirizzo dell'istanza nel
 * prototipo non è noto: niente `from=`.
 */
export function installCommandOf(code: string, lang: ScriptLang = "en"): string | null {
  const a = state.serverAccess.get(code);
  const keys = a?.pending ?? a?.keys;
  if (!a || !keys) return null;
  return installScript({
    serverCode: code,
    read: keys.read,
    fix: keys.fix,
    previous: a.pending ? a.keys : null,
    instanceAddress: null,
    lang,
  });
}

/**
 * «Link SSH access» sulla voce di un avviso di un server in difficoltà
 * (shape server-task, «Sorgente e avvisi»): derivato a LETTURA, per chi
 * guarda adesso. C'è solo per `server.trouble`/`server.down` di un server
 * che chi guarda vede, il cui accesso di lettura non è usabile adesso, e
 * solo con `servers.ssh.manage`; porta alla parte SSH del dettaglio. Un
 * accesso collegato dopo l'avviso la toglie anche dalle voci vecchie.
 */
export function linkAccessHrefOf(
  me: string,
  n: { kind: string; objectCode: string; projectId: string | null },
): string | null {
  if (n.kind !== "server.trouble" && n.kind !== "server.down") return null;
  if (!canManageSsh(me) || !serversVisibleTo(me).has(n.objectCode)) return null;
  if (accessUsable(state.serverAccess.get(n.objectCode), "read")) return null;
  const server = state.servers.find((s) => s.code === n.objectCode);
  if (!server) return null;
  // Il progetto dell'avviso solo se il server ci sta ancora: altrimenti il
  // dettaglio lì direbbe «non trovato» anche a chi il server lo vede altrove.
  const own =
    n.projectId &&
    visibleProjectIds(me).has(n.projectId) &&
    serverInProject(n.objectCode, n.projectId, state.environments)
      ? projectCodeOf(n.projectId)
      : null;
  const home = own ?? homeProjectCode(me, server);
  return home ? `${serverHref(home, n.objectCode)}?section=access` : null;
}
