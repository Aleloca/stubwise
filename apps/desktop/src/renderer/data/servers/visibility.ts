import { serverHealth, serverWork, type ServerWork } from "../../domain/servers/health";
import { personMasker } from "../access/hidden";
import { downsample } from "../../domain/servers/metrics";
import { fixStartBlock, type FixStartBlock } from "../../domain/servers/fixGate";
import { alertProjectsOf, serverInProject } from "../../domain/servers/projects";
import { installScript, type ScriptLang } from "../../domain/servers/installScript";
import {
  accessState,
  accessUsable,
  journalReadable,
  SSH_READ_USER,
  type AccessState,
} from "../../domain/servers/sshAccess";
import { holds, sees } from "../access";
import { PEOPLE } from "../seed/people";
import { latestRunOf, now, state, visibleProjectIds } from "../store";
import type {
  SshPublicKey,
  SshUse,
  SshVerification,
  MonitoredServer,
  ProjectEnvironment,
  ServerAnalysis,
  ServerAttribution,
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
 * correzione viva sullo stesso server, le operazioni dell'agente (F4b: la
 * correzione passa dall'agente, mai dall'SSH). Una sola regola per l'avvio
 * e per il blocco «Server» della task.
 */
export function serverFixStartBlock(me: string, task: Task): FixStartBlock | null {
  const code = task.serverRef?.serverCode;
  const live = latestRunOf(task.id);
  const server = state.servers.find((s) => s.code === code);
  return fixStartBlock({
    hasOperate: can(viewerFor(me), "servers.operate", task.projectId),
    task,
    serverInProject:
      code !== undefined &&
      server !== undefined &&
      serverInProject(code, task.projectId, state.environments),
    operationsOn: server?.agentOperations ?? false,
    liveRun: live !== undefined && live.state !== "finished",
    serverBusy: state.conversations.some(
      (c) => c.serverFix !== undefined && c.serverFix.serverCode === code && c.state !== "finished",
    ),
  });
}

/** `monitor.manage` (d'istanza): server, chiave dell'agente, soglie, controlli; le diagnosi senza progetto. */
export const canMonitor = (me: string): boolean => can(viewerFor(me), "monitor.manage");

/** Gli ambienti che usano `code`, nell'ordine dello stato. */
const environmentsOf = (code: string): ProjectEnvironment[] =>
  state.environments.filter((e) => e.servers.some((s) => s.serverCode === code));

/**
 * Area 9c (Task 5): lo usano solo ambienti di progetti archiviati. Si dice
 * senza nomi («Only in archived projects»), a chiunque legga il server.
 */
export const inArchivedOnlyOf = (code: string): boolean => {
  const envs = environmentsOf(code);
  return envs.length > 0 && envs.every((e) => !!state.projectsById.get(e.projectId)?.archived);
};

/**
 * I codici dei server (esistenti) che `personId` vede: quelli di un ambiente
 * qualunque di un progetto che vede e, con `monitor.manage`, TUTTI (dal 9b:
 * orfani, R-L7, e server di progetti invisibili): chi gestisce il monitor li
 * può aprire, modificare e togliere.
 */
export function serversVisibleTo(personId: string): Set<string> {
  // Area 9b (ruling T7 I2): con `monitor.manage` il server è un oggetto
  // d'istanza e si vede TUTTO — l'elenco di Amministrazione li mostra, e uno
  // elencato deve potersi aprire (R-G5 vieta «elencato e inesistente»).
  // Ambienti, progetti attribuiti e task dei progetti invisibili restano
  // filtrati dalle righe e dal dettaglio.
  if (canMonitor(personId)) return new Set(state.servers.map((s) => s.code));
  const visible = visibleProjectIds(personId);
  const out = new Set<string>();
  for (const env of state.environments) {
    for (const s of env.servers) {
      if (visible.has(env.projectId)) out.add(s.serverCode);
    }
  }
  const existing = new Set<string>();
  for (const s of state.servers) existing.add(s.code);
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

export const codeNumber = (code: string): number => Number(code.slice("SRV-".length));

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
  /**
   * Una produzione (di un progetto non archiviato) lo usa: un allarme avvisa
   * e fa partire l'analisi del server. `false`: solo staging, nessun avviso
   * né analisi. Non c'è un progetto «dell'analisi» prima dell'analisi
   * (F4b-4): il progetto lo dice l'attribuzione, a fine analisi.
   */
  alerting: boolean;
  /** La CPU dell'ultima ora, al più `RECENT_CPU_POINTS` valori, dal più vecchio. */
  recentCpu: number[];
}

/**
 * Gli ambienti dei progetti non archiviati (area 9c): un archiviato non
 * riceve avvisi né analisi, perché non ci nasce lavoro nuovo. Riaperto, il
 * prossimo allarme lo raggiunge di nuovo.
 */
export const liveEnvironments = () =>
  state.environments.filter((e) => !state.projectsById.get(e.projectId)?.archived);

/**
 * L'avviso prima di approvare «libera spazio» (area 8, F4b-8 = c; la forma
 * di `pruneWarning` del server): gli ALTRI progetti che usano il server,
 * oltre a `projectId` — per nome solo quelli che chi guarda vede (R-G5),
 * gli altri contati. `null` se nessun altro progetto lo usa.
 */
export interface PruneWarning {
  projects: string[];
  hiddenCount: number;
}

export function pruneWarningOf(me: string, code: string, projectId: string): PruneWarning | null {
  const others = [
    ...new Set(
      liveEnvironments()
        .filter((e) => e.projectId !== projectId && e.servers.some((x) => x.serverCode === code))
        .map((e) => e.projectId),
    ),
  ];
  if (others.length === 0) return null;
  const seen = others.filter((id) => sees(me, id));
  return {
    projects: seen.map((id) => state.projectsById.get(id)!.name).sort((a, b) => a.localeCompare(b)),
    hiddenCount: others.length - seen.length,
  };
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
    alerting: alertProjectsOf(s.code, liveEnvironments()).length > 0,
    recentCpu: recent.points.map((p) => p.cpuPct),
  };
}

// --- il dettaglio -----------------------------------------------------------

/**
 * L'attribuzione come la legge chi guarda: il codice del progetto solo se
 * lo vede (R-G5). La forma di `serverAnalysisViewSchema.attribution` di
 * `@stubwise/shared` (kind, projectCode, reason).
 */
export type ServerAttributionView =
  | { kind: "attributed"; projectCode: string | null }
  | {
      kind: "undetermined";
      reason: Extract<ServerAttribution, { kind: "undetermined" }>["reason"];
    };

/**
 * L'analisi automatica di un episodio, come la legge chi vede il server: è
 * del server (F4b-4), quindi la vede chiunque veda il server; la sessione,
 * il progetto attribuito e la diagnosi senza task solo a chi può. I concetti
 * di `serverAnalysisViewSchema` (`status` = `outcome`, `attribution`,
 * `diagnosis`, `taskCode` sull'episodio, `blockedBy` = l'`analysisBlocked`
 * dell'episodio, che col budget raggiunto non ha un'analisi).
 */
export interface ServerAnalysisView {
  id: string;
  serverCode: string;
  /** `null` per un'analisi a mano (R0-A2). */
  episodeId: string | null;
  outcome: ServerAnalysis["outcome"];
  /** Chi l'ha chiesta a mano; `null` = all'allarme. Lo vede chiunque veda il server. */
  startedBy: { id: string; name: string } | null;
  startedAt: string;
  endedAt: string | null;
  /**
   * Diagnosi e sessione per chi guarda (regola del server, `canViewDiagnosis`
   * della vista): chi gestisce il monitor sempre; dopo l'attribuzione anche
   * chi legge il progetto attribuito. Prima, o non determinata, solo il monitor.
   */
  canViewDiagnosis: boolean;
  /** La sessione, con `canViewDiagnosis` (e se la sessione c'è ancora). */
  sessionId: string | null;
  /** Quale progetto è la causa; `null` mentre gira (o fermata prima di concludere). */
  attribution: ServerAttributionView | null;
  /** La diagnosi rimasta senza task (causa non determinata), con `canViewDiagnosis`. */
  diagnosis: string | null;
  /** La task nata nel progetto attribuito, se chi guarda la vede. */
  taskCode: string | null;
  /**
   * Bloccata prima di partire (build app: il cancello del worker): il
   * budget del mese, l'analisi spenta, o `cap` (il budget che resta è sotto
   * il tetto di costo di UNA analisi). Il prototipo rifiuta prima, quindi
   * non lo scrive mai.
   */
  blockedBy?: "monthly_budget" | "disabled" | "cap";
}

export interface ServerEpisodeView extends ServerEpisode {
  /** L'analisi automatica, se c'è. */
  analysis: ServerAnalysisView | null;
  /** La task nata dall'analisi, se chi guarda la vede. */
  taskCode: string | null;
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
  /** Le produzioni che lo usano (ricevono gli avvisi), visibili. */
  productionProjects: { id: string; code: string; name: string }[];
  /** `monitor.manage`: modificare, togliere, soglie, controlli, chiave dell'agente. */
  canManage: boolean;
  /** Solo prototipo: se l'SSH risponde (il «Simula server irraggiungibile»). */
  sshReachable: boolean;
  /**
   * L'agente ha le operazioni accese (area 8, F4b, `agentOperations` della
   * vista): senza, nessun piano di correzione si esegue.
   */
  agentOperations: boolean;
  /**
   * Nessun ambiente di nessun progetto lo usa (R-L7, area 9b): un server nato
   * da Amministrazione. Vale anche per chi non vede i progetti che lo usano:
   * un server di soli progetti invisibili NON è orfano.
   */
  orphan: boolean;
  /** Lo usano solo ambienti di progetti archiviati (Task 5): «Only in archived projects», senza nomi. */
  inArchivedOnly: boolean;
  /**
   * «Ask Claude to look into it» (R0-A2): `servers.operate` in un progetto il
   * cui ambiente usa il server (staging compreso) e nessuna analisi in corso.
   * L'accesso di lettura non serve (senza, niente letture SSH).
   */
  canStartAnalysis: boolean;
  /** L'ultima analisi chiesta a mano, se c'è. */
  manualAnalysis: ServerAnalysisView | null;
}

/**
 * La sessione di un'analisi per chi guarda: chi gestisce il monitor sempre;
 * gli altri solo se vedono il progetto attribuito (prima dell'attribuzione,
 * o non determinata, la sessione non è di un progetto: F4b-4). La stessa
 * regola di prima con il progetto attribuito al posto di quello scelto.
 */
function canViewDiagnosisOf(me: string, a: ServerAnalysis): boolean {
  const at = a.attribution;
  return canMonitor(me) || (at?.kind === "attributed" && sees(me, at.projectId));
}

function analysisSessionOf(me: string, a: ServerAnalysis): string | null {
  return canViewDiagnosisOf(me, a) && state.conversations.some((c) => c.id === a.conversationId)
    ? a.conversationId
    : null;
}

export function analysisView(
  me: string,
  a: ServerAnalysis,
  mask: ReturnType<typeof personMasker> = personMasker(me),
): ServerAnalysisView {
  const at = a.attribution;
  const who = a.startedBy ? PEOPLE.find((p) => p.id === a.startedBy) : undefined;
  // R.1414 (lotto 3): chi l'ha avviata, se chi guarda non lo conosce: segnaposto, senza nome.
  const hiddenWho = who && mask(who.id) !== who.id ? mask(who.id) : null;
  return {
    id: a.id,
    serverCode: a.serverCode,
    episodeId: a.episodeId,
    outcome: a.outcome,
    startedBy: hiddenWho ? { id: hiddenWho, name: "" } : who ? { id: who.id, name: who.name } : null,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    canViewDiagnosis: canViewDiagnosisOf(me, a),
    sessionId: analysisSessionOf(me, a),
    attribution:
      at === null
        ? null
        : at.kind === "attributed"
          ? { kind: "attributed", projectCode: sees(me, at.projectId) ? at.projectCode : null }
          : { kind: "undetermined", reason: at.reason },
    diagnosis: canViewDiagnosisOf(me, a) ? (a.diagnosis ?? null) : null,
    taskCode: (() => {
      const task = a.taskId ? state.tasksById.get(a.taskId) : undefined;
      return task && sees(me, task.projectId) ? task.code : null;
    })(),
  };
}

function episodeView(me: string, e: ServerEpisode): ServerEpisodeView {
  const analysis = e.analysisId
    ? state.serverAnalyses.find((a) => a.id === e.analysisId)
    : undefined;
  const task = analysis?.taskId ? state.tasksById.get(analysis.taskId) : undefined;
  return {
    ...structuredClone(e),
    analysis: analysis ? analysisView(me, analysis) : null,
    taskCode: task && sees(me, task.projectId) ? task.code : null,
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
    agentOperations: s.agentOperations,
    orphan: environmentsOf(s.code).length === 0,
    inArchivedOnly: inArchivedOnlyOf(s.code),
    canStartAnalysis:
      canOperateServer(me, s.code) &&
      !state.serverAnalyses.some((a) => a.serverCode === s.code && a.outcome === "running"),
    manualAnalysis: (() => {
      const last = state.serverAnalyses
        .filter((a) => a.serverCode === s.code && a.startedBy)
        .sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0];
      return last ? analysisView(me, last) : null;
    })(),
  };
}

/**
 * `servers.operate` in un progetto (visibile, non archiviato) il cui
 * ambiente usa il server, di qualunque tipo (R0-A2: staging compreso).
 */
export function canOperateServer(me: string, code: string): boolean {
  const viewer = viewerFor(me);
  return liveEnvironments().some(
    (e) =>
      e.servers.some((x) => x.serverCode === code) &&
      sees(me, e.projectId) &&
      can(viewer, "servers.operate", e.projectId),
  );
}

/** L'indirizzo del dettaglio di un server (avvisi, ⌘K): `#/p/STW/servers/SRV-2`. */
export const serverHref = (projectCode: string, code: string): string =>
  `#/p/${projectCode}/servers/${code}`;

/** Il progetto da cui si apre un server per chi guarda: il primo visibile fra i suoi ambienti. */
export function homeProjectCode(me: string, s: MonitoredServer): string | null {
  const visible = visibleProjectIds(me);
  const env = environmentsOf(s.code).find((e) => visible.has(e.projectId));
  return env ? projectCodeOf(env.projectId) : null;
}

// --- l'accesso SSH ----------------------------------------------------------
// Qui solo ciò che si può mostrare: lo stato e le chiavi PUBBLICHE. Le
// private stanno in `secrets.ts`, che da qui (e da ogni lettura) non si
// raggiunge (anti-obiettivo 3, test architetturale).

/** `servers.ssh.manage` (d'istanza): collegare, verificare, rigenerare, revocare. */
export const canManageSsh = (me: string): boolean => can(viewerFor(me), "servers.ssh.manage");

/** L'ultimo uso dell'accesso: quando, e da quale analisi o task (il codice della task solo se chi guarda la vede). */
export interface SshUseView {
  at: string;
  /** Da quale analisi o task; `null` nella build app (il server dice solo quando). */
  label: { kind: "analysis" | "task"; code: string | null } | null;
  /** La sessione dell'analisi («Open session», Task 8), con la regola di `analysisSessionOf`. */
  sessionId: string | null;
}

/**
 * L'accesso SSH di un server per chi guarda (area 8, F4b; i concetti di
 * `serverSshAccessViewSchema`): UNO, di sola lettura. Mai la privata.
 */
export interface SshAccessView {
  state: AccessState;
  /** L'utente sul server: sempre `stubwise-read`. */
  username: string;
  /** La chiave pubblica in uso. */
  key: SshPublicKey | null;
  /** La chiave generata e non ancora verificata (collegamento o rigenerazione). */
  pending: SshPublicKey | null;
  /** L'ultima verifica: i gruppi, `sudo`, `docker`, il journal, `ok`. */
  verification: SshVerification | null;
  /**
   * Se l'accesso si può usare adesso (`accessUsable`): durante una
   * rigenerazione dipende anche dall'esito della vecchia chiave, che la
   * vista non porta, quindi la UI non lo può ricavare da sé.
   */
  usable: boolean;
  /** Se Claude legge il journal di sistema adesso (`journalReadable`, F4b-3). */
  journal: boolean;
  lastUse: SshUseView | null;
  /** Quando è stato revocato («Revoked Oct 29», il comando di rimozione); `null` se non lo è. */
  revokedAt: string | null;
  canManage: boolean;
}

function useView(me: string, use: SshUse | null | undefined): SshUseView | null {
  if (!use) return null;
  const ref = use.ref;
  const analysis =
    ref.kind === "analysis" ? state.serverAnalyses.find((a) => a.id === ref.analysisId) : undefined;
  const taskId = ref.kind === "task" ? ref.taskId : (analysis?.taskId ?? null);
  const task = taskId ? state.tasksById.get(taskId) : undefined;
  return {
    at: use.at,
    label: { kind: ref.kind, code: task && sees(me, task.projectId) ? task.code : null },
    sessionId: analysis ? analysisSessionOf(me, analysis) : null,
  };
}

/** Il pannello «Accesso SSH» di `code` per chi guarda (che lo vede già: passa da `serverFor`). */
export function sshAccessView(me: string, code: string): SshAccessView {
  const a = state.serverAccess.get(code);
  return structuredClone({
    state: accessState(a),
    username: SSH_READ_USER,
    key: a?.key ?? null,
    pending: a?.pending ?? null,
    verification: a?.verification ?? null,
    usable: accessUsable(a),
    journal: journalReadable(a),
    lastUse: useView(me, a?.lastUse),
    revokedAt: a?.revokedAt ?? null,
    canManage: canManageSsh(me),
  });
}

/**
 * Il comando da incollare sul server: lo script dell'utente di sola lettura
 * con la sola chiave PUBBLICA — quella in attesa se c'è (collegamento o
 * rigenerazione), altrimenti quella in uso. In rigenerazione (R-L8) riceve
 * anche la chiave in uso, che resta valida finché la verifica della nuova
 * non riesce. `null` senza chiavi. L'indirizzo dell'istanza nel prototipo
 * non è noto: niente `from=`.
 */
export function installCommandOf(code: string, lang: ScriptLang = "en"): string | null {
  const a = state.serverAccess.get(code);
  const key = a?.pending ?? a?.key;
  if (!a || !key) return null;
  return installScript({
    serverCode: code,
    key,
    previous: a.pending ? a.key : null,
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
  if (accessUsable(state.serverAccess.get(n.objectCode))) return null;
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
