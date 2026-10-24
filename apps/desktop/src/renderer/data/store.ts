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
  ConversationEvent,
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
  | "deleteMilestone";
const failures = new Set<ApiFnName>();

/** Fissa la latenza simulata (ms); `0` per i test, `null` per tornare a 150–400 ms. */
export function setLatency(ms: number | null): void {
  latencyOverride = ms;
}

/**
 * L'attesa fra due pezzi dello stream di una conversazione (ms): la latenza
 * fissata con `setLatency`, altrimenti 40–160 ms deterministici.
 */
export function streamDelay(): number {
  return latencyOverride ?? 40 + ((chunkCounter++ * 53) % 121);
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
