import { stallOf, type Stall } from "../domain/stalled";
import { currentWeek } from "../domain/weeks";
import type { FilterContext } from "../domain/filters";
import { ACTIVITY } from "./seed/activity";
import { BRIEFS } from "./seed/briefs";
import { CONVERSATION_EVENTS, CONVERSATIONS } from "./seed/conversations";
import { TODAY } from "./seed/dates";
import { DECISION_LOG } from "./seed/decisionLog";
import { DECISION_REQUESTS } from "./seed/decisions";
import { INITIAL_PINNED_FILTERS, SAVED_FILTERS } from "./seed/filters";
import { DAY_ARRANGEMENTS, DEPARTMENT_HOMES, PERSONAL_HOMES } from "./seed/homes";
import { MILESTONES } from "./seed/milestones";
import { NOTIFICATIONS } from "./seed/notifications";
import { INITIAL_PINNED_CODES, PROJECTS } from "./seed/projects";
import { REQUESTS } from "./seed/requests";
import { PROJECT_STATUSES } from "./seed/statuses";
import { TASKS } from "./seed/tasks";
import { DAILY_REPORTS, PULL_REQUEST_EVENTS } from "./seed/timeline";
import { DEFAULT_SESSION_PERSON_ID, getSessionPersonId, setSessionPersonId } from "./session";
import type {
  ActivityEntry,
  AppNotification,
  Conversation,
  ConversationActivity,
  ConversationEvent,
  ConversationKind,
  ConversationPermissions,
  ConversationRow,
  DailyReport,
  DayArrangement,
  DecisionLogEntry,
  DecisionRequest,
  DepartmentHome,
  Milestone,
  PersonalHome,
  Project,
  ProjectRequest,
  ProjectStatus,
  PullRequestEvent,
  ReadOnlyReason,
  SavedFilter,
  StatusFamily,
  Task,
  WeeklyBrief,
} from "./types";
import { can, resetViewerGrants, viewerFor } from "./viewer";

// Il «server» finto: il simulatore (latenza, errori iniettati), lo stato
// mutabile — una copia del seed, che `resetApi` rifà — e i derivati che le
// letture (`api.ts`) e le scritture (`api-mutations.ts`) condividono.

// --- controllo del simulatore ---------------------------------------------

let latencyOverride: number | null = null;
let callCounter = 0;
let chunkCounter = 0;
export type ApiFnName =
  | "listDepartments"
  | "listPeople"
  | "listProjects"
  | "getProjectByCode"
  | "listPinnedProjectIds"
  | "setPinned"
  | "listWaitingOnMeProjectIds"
  | "listProjectStatuses"
  | "listMilestones"
  | "listTasks"
  | "getTaskByCode"
  | "listActivity"
  | "listDecisionRequests"
  | "listRequests"
  | "listRequestsToConvert"
  | "getRequest"
  | "getRequestByCode"
  | "listDocPages"
  | "listSavedFilters"
  | "getSavedFilter"
  | "listPinnedFilterIds"
  | "listDepartmentHomes"
  | "getPersonalHome"
  | "listDepartmentRoles"
  | "listDayArrangements"
  | "listStalled"
  | "projectPulse"
  | "listProjectPulses"
  | "listPortfolioActivity"
  | "listTimeline"
  | "listDecisionLog"
  | "getLatestBrief"
  | "listNotifications"
  | "markNotification"
  | "search"
  | "createTask"
  | "updateTask"
  | "bulkUpdateTasks"
  | "planTask"
  | "setDay"
  | "addComment"
  | "editComment"
  | "deleteComment"
  | "askDecision"
  | "answerDecision"
  | "withdrawDecision"
  | "createRequest"
  | "updateRequest"
  | "mergeRequest"
  | "archiveRequest"
  | "reopenRequest"
  | "restoreRequest"
  | "startRefine"
  | "convertRequest"
  | "saveFilter"
  | "updateFilter"
  | "deleteFilter"
  | "setFilterPinned"
  | "setPersonalHome"
  | "resetPersonalHome"
  | "setDepartmentHome"
  | "markDepartmentHomeSeen"
  | "createProject"
  | "setProjectStatuses"
  | "setStallThresholds"
  | "recordDecision"
  | "setDecisionSuperseded"
  | "createMilestone"
  | "updateMilestone"
  | "deleteMilestone"
  | "listConversations"
  | "getConversation"
  | "getTaskWork"
  | "listCommands"
  | "listPeopleActivity"
  | "createConversation"
  | "sendMessage"
  | "stop"
  | "stopAndSend"
  | "answerQuestion"
  | "decidePlan"
  | "preApprovePlan"
  | "revokePlanApproval"
  | "confirmProposal"
  | "cancelProposal"
  | "editProposal"
  | "setVisibility"
  | "continueConversation"
  | "renameConversation"
  | "archiveConversation"
  | "deleteConversation"
  | "startRun"
  | "relaunchWithInstructions"
  | "resumeCorrection"
  | "requestChanges"
  | "startRefineConversation"
  | "closeRefine"
  | "resolveCitations"
  | "searchMentions"
  | "setConversationContext"
  | "completeEditedProposal";
const failures = new Set<ApiFnName>();

/** Fissa la latenza simulata (ms); `0` per i test, `null` per tornare a 150–400 ms. */
export function setLatency(ms: number | null): void {
  latencyOverride = ms;
}

let streamLatencyOverride: number | null = null;

/**
 * Fissa solo l'attesa fra due pezzi dello stream (ms), diversa da quella
 * delle chiamate: per i test che riproducono uno stream più veloce delle
 * letture, come nell'app. `null` torna a seguire `setLatency`.
 */
export function setStreamLatency(ms: number | null): void {
  streamLatencyOverride = ms;
}

/**
 * L'attesa fra due pezzi dello stream di una conversazione (ms): quella
 * fissata con `setStreamLatency` o `setLatency`, altrimenti 40–160 ms
 * deterministici.
 */
export function streamDelay(): number {
  return streamLatencyOverride ?? latencyOverride ?? 40 + ((chunkCounter++ * 53) % 121);
}

/** Quanto resta «Riconnessione…» dopo una disconnessione (ms): la latenza fissata, altrimenti 800 ms. */
export function reconnectDelay(): number {
  return latencyOverride ?? 800;
}

/** La prossima chiamata a `fnName` (e solo quella) viene rifiutata. */
export function failNext(fnName: ApiFnName): void {
  failures.add(fnName);
}

/**
 * Attende la latenza simulata e restituisce chi sta guardando. La persona si
 * legge PRIMA dell'attesa: una chiamata partita a nome di una persona
 * risponde per lei anche se nel frattempo si è cambiato «vedi come».
 */
export async function gate(fnName: ApiFnName): Promise<string> {
  const me = getSessionPersonId();
  // Latenza deterministica (150–400 ms) che varia da una chiamata all'altra.
  const ms = latencyOverride ?? 150 + ((callCounter++ * 97) % 251);
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  if (failures.delete(fnName)) throw new Error(`Simulated failure: ${fnName}`);
  // Stato fresco: la prima chiamata porta le task scadute alla settimana corrente.
  if (!state.slipped) slipWeeks();
  return me;
}

// --- stato ------------------------------------------------------------------

export const copy = <T extends object>(x: T): T => structuredClone(x);

function initialPinned(): Map<string, string[]> {
  return new Map(
    Object.entries(INITIAL_PINNED_CODES).map(([personId, codes]) => [
      personId,
      codes.map((c) => PROJECTS.find((p) => p.code === c)!.id),
    ]),
  );
}

interface State {
  projects: Project[];
  statuses: ProjectStatus[];
  tasks: Task[];
  activity: ActivityEntry[];
  decisions: DecisionRequest[];
  requests: ProjectRequest[];
  milestones: Milestone[];
  briefs: WeeklyBrief[];
  decisionLog: DecisionLogEntry[];
  dailyReports: DailyReport[];
  pullRequests: PullRequestEvent[];
  filters: SavedFilter[];
  departmentHomes: DepartmentHome[];
  personalHomes: PersonalHome[];
  arrangements: DayArrangement[];
  notifications: AppNotification[];
  conversations: Conversation[];
  /** Il flusso di ogni conversazione, per id: lo scrive solo il motore dello stream. */
  conversationEvents: Map<string, ConversationEvent[]>;
  /** Le sessioni di task il cui piano è approvato in anticipo (prima che arrivi): da chi. */
  preApprovedPlans: Map<string, string>;
  /**
   * Le conversazioni con un invio in corso (quanti): una libera ancora senza
   * messaggi resta fra le proprie solo finché il primo invio è in viaggio.
   */
  sendingTo: Map<string, number>;
  pinned: Map<string, string[]>;
  /** Filtri fissati, per persona. */
  pinnedFilters: Map<string, string[]>;
  projectsById: Map<string, Project>;
  statusById: Map<string, ProjectStatus>;
  tasksById: Map<string, Task>;
  /** Per gli id delle righe create. */
  counter: number;
  slipped: boolean;
}

function freshState(): State {
  return {
    projects: PROJECTS.map(copy),
    statuses: PROJECT_STATUSES.map(copy),
    tasks: TASKS.map(copy),
    activity: ACTIVITY.map(copy),
    decisions: DECISION_REQUESTS.map(copy),
    requests: REQUESTS.map(copy),
    milestones: MILESTONES.map(copy),
    briefs: BRIEFS.map(copy),
    decisionLog: DECISION_LOG.map(copy),
    dailyReports: DAILY_REPORTS.map(copy),
    pullRequests: PULL_REQUEST_EVENTS.map(copy),
    filters: SAVED_FILTERS.map(copy),
    departmentHomes: DEPARTMENT_HOMES.map(copy),
    personalHomes: PERSONAL_HOMES.map(copy),
    arrangements: DAY_ARRANGEMENTS.map(copy),
    notifications: NOTIFICATIONS.map(copy),
    conversations: CONVERSATIONS.map(copy),
    conversationEvents: new Map(
      Object.entries(CONVERSATION_EVENTS).map(([id, events]) => [id, events.map(copy)]),
    ),
    preApprovedPlans: new Map(),
    sendingTo: new Map(),
    pinned: initialPinned(),
    pinnedFilters: new Map(Object.entries(INITIAL_PINNED_FILTERS).map(([k, v]) => [k, [...v]])),
    projectsById: new Map(),
    statusById: new Map(),
    tasksById: new Map(),
    counter: 0,
    slipped: false,
  };
}

export const state: State = freshState();

/** Rifà le mappe per id dopo che un array è cambiato di struttura. */
export function reindex(): void {
  state.projectsById = new Map(state.projects.map((p) => [p.id, p]));
  state.statusById = new Map(state.statuses.map((s) => [s.id, s]));
  state.tasksById = new Map(state.tasks.map((t) => [t.id, t]));
}
reindex();

const resetHooks = new Set<() => void>();

/**
 * Lavoro da fermare quando lo stato si ripristina (es. gli stream in corso,
 * che altrimenti continuerebbero a scrivere nello stato nuovo).
 */
export function onStoreReset(fn: () => void): void {
  resetHooks.add(fn);
}

/** Ripristina lo stato (sessione, dati, errori iniettati). */
export function resetStore(): void {
  for (const fn of resetHooks) fn();
  failures.clear();
  streamLatencyOverride = null;
  callCounter = 0;
  chunkCounter = 0;
  setSessionPersonId(DEFAULT_SESSION_PERSON_ID);
  resetViewerGrants();
  Object.assign(state, freshState());
  reindex();
}

/** L'id di una riga creata dal prototipo. */
export const newId = (prefix: string): string => `${prefix}-new-${++state.counter}`;

/** L'«adesso» del prototipo: nessuna logica legge l'orologio. */
export const now = (): string => `${TODAY}T12:00:00Z`;

export const familyOf = (task: Task): StatusFamily => state.statusById.get(task.statusId)!.family;

/**
 * Le task aperte pianificate in una settimana passata scivolano alla corrente,
 * con `slipCount + 1`. Idempotente: dopo il primo giro nessuna è più nel passato.
 */
export function slipWeeks(): void {
  const week = currentWeek();
  for (const task of state.tasks) {
    if (task.plannedWeek && task.plannedWeek < week && familyOf(task) !== "closed") {
      task.plannedWeek = week;
      task.slipCount += 1;
    }
  }
  state.slipped = true;
}

// --- visibilità e derivati (come sul server) --------------------------------

/** I progetti che una persona vede: quelli di cui è membro, o tutti se è full admin. */
export function visibleProjectIds(personId: string): Set<string> {
  const viewer = viewerFor(personId);
  if (viewer.instancePermissions.includes("instance.full_admin")) {
    return new Set(state.projects.map((p) => p.id));
  }
  return new Set(state.projects.filter((p) => p.memberIds.includes(personId)).map((p) => p.id));
}

/**
 * Chi vede una conversazione con Claude — l'unica regola, per le letture e
 * per lo stream. Libera privata: chi l'ha aperta; pubblica: anche chi ha
 * `claude.public.view`. Sessioni di lavoro: `repos.view` nel progetto (il
 * refine `backlog.edit`). Posta: solo il titolare, mai gli admin.
 */
export function canSeeConversation(personId: string, c: Conversation): boolean {
  const viewer = viewerFor(personId);
  switch (c.kind) {
    case "free":
      return (
        c.ownerId === personId || (c.visibility === "public" && can(viewer, "claude.public.view"))
      );
    case "mail_classify":
      return c.ownerId === personId;
    case "refine":
      return c.projectId !== null && can(viewer, "backlog.edit", c.projectId);
    default:
      return c.projectId !== null && can(viewer, "repos.view", c.projectId);
  }
}

/** Una proposta aperta scade dopo 20 eventi successivi o 24 ore. */
export const PROPOSAL_EXPIRY = { events: 20, ms: 24 * 60 * 60 * 1000 } as const;

/**
 * Vero se la proposta in posizione `index` del flusso è scaduta adesso: si
 * calcola a lettura (orologio fisso del prototipo), non si salva.
 */
export function proposalExpired(log: readonly ConversationEvent[], index: number): boolean {
  const event = log[index];
  if (!event || event.type !== "proposal" || event.status !== "open") return false;
  const later = log.length - 1 - index;
  return (
    later >= PROPOSAL_EXPIRY.events ||
    Date.parse(now()) - Date.parse(event.at) >= PROPOSAL_EXPIRY.ms
  );
}

/**
 * Un evento del flusso come lo legge chi guarda: una copia, con la proposta
 * scaduta già detta `expired`. Lo usano lo stream e le letture.
 */
export function presentEvent(log: readonly ConversationEvent[], index: number): ConversationEvent {
  const event = copy(log[index]!);
  if (event.type === "proposal" && proposalExpired(log, index)) event.status = "expired";
  return event;
}

/**
 * Lo stato di Claude sulla task segue la sua sessione di lavoro (come
 * `task.claude` del seed): al lavoro, aspetta, fermata, fatta.
 */
export function syncTaskClaude(c: Conversation): void {
  if (c.kind !== "task_run" || c.taskId === null) return;
  const task = state.tasksById.get(c.taskId);
  if (!task) return;
  switch (c.state) {
    case "finished":
      task.claude = c.outcome === "ok" ? "done" : "stopped";
      break;
    case "paused":
      task.claude = "stopped";
      break;
    case "working":
    case "awaiting_answer":
    case "awaiting_approval":
      task.claude = c.state;
      break;
    case "idle":
      break;
  }
}

/** Le sessioni automatiche: si guardano, non si scrivono (come oggi). */
const AUTOMATIC_KINDS: ReadonlySet<ConversationKind> = new Set([
  "pr_review",
  "docs",
  "brief",
  "daily_report",
  "mail_classify",
  "intake",
]);

export const eventsOf = (conversationId: string): ConversationEvent[] =>
  state.conversationEvents.get(conversationId) ?? [];

/** L'ultimo evento che soddisfa `test`, dal fondo del flusso. */
export function lastEvent<E extends ConversationEvent>(
  log: readonly ConversationEvent[],
  test: (e: ConversationEvent) => e is E,
): E | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (test(e)) return e;
  }
  return undefined;
}

type QuestionEvent = Extract<ConversationEvent, { type: "question" }>;
type PlanEvent = Extract<ConversationEvent, { type: "plan" }>;

/** La domanda ancora senza risposta (al più una per volta). */
export const openQuestion = (log: readonly ConversationEvent[]) =>
  lastEvent(log, (e): e is QuestionEvent => e.type === "question" && e.answer === null);

/** Il piano che aspetta una decisione. */
export const pendingPlan = (log: readonly ConversationEvent[]) =>
  lastEvent(log, (e): e is PlanEvent => e.type === "plan" && e.status === "pending");

/** La fase in cui si trova una sessione: l'ultima del flusso. */
export function currentPhase(log: readonly ConversationEvent[]): string | null {
  const phase = lastEvent(
    log,
    (e): e is Extract<ConversationEvent, { type: "phase" }> => e.type === "phase",
  );
  return phase?.phase ?? null;
}

/**
 * Cosa può fare una persona in una conversazione che vede: la regola del
 * server di oggi (`canWrite`/`canInterrupt`/`canAnswer`, gate del piano),
 * in un posto solo. Scrivere in una sessione di task chiede
 * `agent_sessions.intervene` e un passo interattivo (al lavoro o in pausa);
 * nel refine `backlog.edit` finché la sessione è aperta. Rispondere: il
 * richiedente o chi ha `plans.approve`. Una libera la scrive solo l'autore.
 */
export function conversationPermissions(
  personId: string,
  c: Conversation,
): ConversationPermissions {
  const viewer = viewerFor(personId);
  const log = eventsOf(c.id);
  const isOwner = c.ownerId === personId;
  const inProject = (perm: Parameters<typeof can>[1]) =>
    c.projectId !== null && can(viewer, perm, c.projectId);
  const approver = c.kind === "task_run" && inProject("plans.approve");
  const live = c.state !== "finished";
  const planning = currentPhase(log) === "plan" && !log.some((e) => e.type === "plan");

  let canWrite = false;
  let canInterrupt = false;
  let readOnlyReason: ReadOnlyReason | null = null;
  if (c.kind === "free") {
    canWrite = isOwner && !c.archived;
    // L'autore ferma la risposta in corso (e quelle in coda dietro di lei).
    canInterrupt = canWrite && c.state === "working";
    if (!canWrite) readOnlyReason = isOwner ? "archived" : "not_owner";
  } else if (AUTOMATIC_KINDS.has(c.kind)) {
    readOnlyReason = "automatic";
  } else if (!live) {
    readOnlyReason = "finished";
  } else {
    const allowed = inProject(c.kind === "refine" ? "backlog.edit" : "agent_sessions.intervene");
    const interactive = c.kind === "refine" ? true : c.state === "working" || c.state === "paused";
    canWrite = allowed && interactive;
    canInterrupt = allowed && c.state === "working";
    if (!canWrite) readOnlyReason = allowed ? "not_interactive" : "no_permission";
  }

  const question = openQuestion(log);
  const plan = pendingPlan(log);
  const preApproved = state.preApprovedPlans.has(c.id);
  return {
    isOwner,
    canWrite,
    canInterrupt,
    canAnswer: question !== undefined && live && (isOwner || inProject("plans.approve")),
    canDecidePlan: plan !== undefined && approver && c.state === "awaiting_approval",
    canPreApprovePlan: approver && live && planning && !preApproved,
    // Revocabile solo finché il piano non è arrivato: dopo, l'anticipo è già speso.
    canRevokePlanApproval: approver && live && planning && preApproved,
    canContinue: c.kind === "free" && !isOwner && c.visibility === "public",
    canManage: c.kind === "free" && isOwner,
    readOnlyReason,
  };
}

/** Il codice dell'oggetto della sessione (task o richiesta), se c'è. */
export function objectCodeOf(c: Conversation): string | null {
  if (c.taskId) return state.tasksById.get(c.taskId)?.code ?? null;
  if (c.requestId) return state.requests.find((r) => r.id === c.requestId)?.code ?? null;
  return null;
}

/** Cosa sta facendo Claude adesso: l'azione in corso, una domanda o un piano che aspettano. */
export function activityOf(c: Conversation): ConversationActivity {
  if (c.state === "awaiting_answer") return { kind: "question" };
  if (c.state === "awaiting_approval") return { kind: "plan" };
  if (c.state !== "working") return null;
  const running = lastEvent(
    eventsOf(c.id),
    (e): e is Extract<ConversationEvent, { type: "action" }> =>
      e.type === "action" && e.state === "running",
  );
  return running ? { kind: "action", label: running.label } : null;
}

/**
 * La conversazione come la legge una persona: una copia, e i progetti toccati
 * ridotti a quelli che vede (un progetto invisibile non si nomina, come un
 * oggetto che non esiste).
 */
export function conversationRow(personId: string, c: Conversation): ConversationRow {
  const visible = visibleProjectIds(personId);
  const row = copy(c);
  const privateTail = hasPrivateTail(personId, c);
  if (c.ownerId !== personId) {
    // Chi non è l'autore di una pubblica vede solo i progetti confermati
    // (R-E6): uno toccato dopo resta dell'autore finché non lo riconferma.
    const shown = c.visibility === "public" ? c.publishedProjectIds : c.touchedProjectIds;
    row.touchedProjectIds = shown.filter((id) => visible.has(id));
    row.publishedProjectIds = row.publishedProjectIds.filter((id) => visible.has(id));
    if (row.contextProjectId !== null && !visible.has(row.contextProjectId)) {
      row.contextProjectId = null;
    }
  }
  if (privateTail) {
    // Nemmeno il movimento del seguito privato si vede: la riga resta
    // com'era all'ultimo evento leggibile.
    const lastReadable = eventsOf(c.id)[c.privateFromIndex! - 1];
    row.state = "idle";
    row.outcome = null;
    row.updatedAt = lastReadable?.at ?? c.createdAt;
  }
  return {
    ...row,
    objectCode: objectCodeOf(c),
    // Cosa fa Claude nel seguito privato non si dice a chi non è l'autore.
    activity: privateTail ? null : activityOf(c),
    privateTail,
    waitsOnViewer: waitsOn(personId, c),
  };
}

/** Claude aspetta questa persona: una domanda a cui può rispondere o un piano che può decidere. */
function waitsOn(personId: string, c: Conversation): boolean {
  if (c.state !== "awaiting_answer" && c.state !== "awaiting_approval") return false;
  const perms = conversationPermissions(personId, c);
  return perms.canAnswer || perms.canDecidePlan;
}

/** Vero se per questa persona il seguito della pubblica è privato (R-E6). */
export function hasPrivateTail(personId: string, c: Conversation): boolean {
  return c.privateFromIndex !== null && c.ownerId !== personId;
}

/**
 * Quanti eventi del flusso una persona può leggere: tutti, salvo il seguito
 * privato di una pubblica per chi non è l'autore (R-E6).
 */
export function readableLength(personId: string, c: Conversation): number {
  const length = eventsOf(c.id).length;
  return hasPrivateTail(personId, c) ? Math.min(length, c.privateFromIndex!) : length;
}

/** Un progetto con un repository (template `software`): prova il codice e apre PR. */
export function hasRepository(projectId: string): boolean {
  return state.projectsById.get(projectId)?.template === "software";
}

/**
 * La task ha una PR ancora aperta: solo un progetto con un repository, e
 * l'ultima apertura (della pipeline o della piattaforma) è più recente
 * dell'ultimo merge o chiusura.
 */
export function hasOpenPr(task: Task): boolean {
  if (!hasRepository(task.projectId)) return false;
  const prs = state.pullRequests.filter((pr) => pr.taskId === task.id);
  const lastClose = prs
    .filter((pr) => pr.kind !== "pr_opened")
    .reduce((max, pr) => (pr.at > max ? pr.at : max), "");
  const openings = [
    ...prs.filter((pr) => pr.kind === "pr_opened").map((pr) => pr.at),
    ...state.conversations
      .filter((c) => c.kind === "task_run" && c.taskId === task.id)
      .flatMap((c) =>
        eventsOf(c.id).flatMap((e) =>
          e.type === "work_result" && e.kind === "pr_opened" ? [e.at] : [],
        ),
      ),
  ];
  return openings.some((at) => at > lastClose);
}

export const openDecisions = () =>
  state.decisions.filter((d) => d.answer === null && d.withdrawnAt === null);

/**
 * Lo stato «ferma» come lo vede una persona: le bloccanti si cercano solo fra
 * le task che vede. Una bloccante invisibile non compare e non ferma la task
 * per lei (altrimenti la task direbbe «Blocked by unknown»). La mappa delle
 * visibili si costruisce una volta per chiamata, non per task.
 */
export function stallScope(
  personId: string,
  open: DecisionRequest[] = openDecisions(),
): (task: Task) => Stall | null {
  const visible = visibleProjectIds(personId);
  const tasksById = new Map(
    state.tasks.filter((t) => visible.has(t.projectId)).map((t) => [t.id, t]),
  );
  return (task) =>
    stallOf(task, {
      family: familyOf(task),
      openDecisions: open,
      tasksById,
      familyOf,
      thresholds: state.projectsById.get(task.projectId)!.stallThresholds,
    });
}

export function filterContext(personId: string): FilterContext {
  const stallOfTask = stallScope(personId);
  return {
    familyOf,
    isStalled: (task) => stallOfTask(task) !== null,
    projectName: (id) => state.projectsById.get(id)?.name ?? "",
  };
}

export function visibleTasks(personId: string): Task[] {
  const visible = visibleProjectIds(personId);
  return state.tasks.filter((t) => visible.has(t.projectId));
}

/** Progetti dove la persona deve decidere qualcosa: decisioni aperte per lei, richieste nuove da trasformare. */
export function waitingOnMe(personId: string): Set<string> {
  const visible = visibleProjectIds(personId);
  const viewer = viewerFor(personId);
  const out = new Set<string>();
  for (const d of openDecisions()) {
    const projectId = state.tasksById.get(d.taskId)!.projectId;
    if (d.askedOfId === personId && visible.has(projectId)) out.add(projectId);
  }
  for (const r of state.requests) {
    if (
      r.status === "new" &&
      visible.has(r.projectId) &&
      can(viewer, "tickets.create", r.projectId)
    )
      out.add(r.projectId);
  }
  return out;
}
