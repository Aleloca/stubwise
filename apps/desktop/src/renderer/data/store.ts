import { stallOf, type Stall } from "../domain/stalled";
import { currentWeek } from "../domain/weeks";
import type { FilterContext } from "../domain/filters";
import { ACTIVITY } from "./seed/activity";
import { TODAY } from "./seed/dates";
import { DECISION_REQUESTS } from "./seed/decisions";
import { SAVED_FILTERS } from "./seed/filters";
import { DAY_ARRANGEMENTS, DEPARTMENT_HOMES, PERSONAL_HOMES } from "./seed/homes";
import { MILESTONES } from "./seed/milestones";
import { NOTIFICATIONS } from "./seed/notifications";
import { INITIAL_PINNED_CODES, PROJECTS } from "./seed/projects";
import { REQUESTS } from "./seed/requests";
import { PROJECT_STATUSES } from "./seed/statuses";
import { TASKS } from "./seed/tasks";
import { DEFAULT_SESSION_PERSON_ID, getSessionPersonId, setSessionPersonId } from "./session";
import type {
  ActivityEntry,
  AppNotification,
  DayArrangement,
  DecisionRequest,
  DepartmentHome,
  Milestone,
  PersonalHome,
  Project,
  ProjectRequest,
  ProjectStatus,
  SavedFilter,
  StatusFamily,
  Task,
} from "./types";
import { can, resetViewerGrants, viewerFor } from "./viewer";

// Il «server» finto: il simulatore (latenza, errori iniettati), lo stato
// mutabile — una copia del seed, che `resetApi` rifà — e i derivati che le
// letture (`api.ts`) e le scritture (`api-mutations.ts`) condividono.

// --- controllo del simulatore ---------------------------------------------

let latencyOverride: number | null = null;
let callCounter = 0;
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
  | "listTimeline"
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
  | "setStallThresholds";
const failures = new Set<ApiFnName>();

/** Fissa la latenza simulata (ms); `0` per i test, `null` per tornare a 150–400 ms. */
export function setLatency(ms: number | null): void {
  latencyOverride = ms;
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
  filters: SavedFilter[];
  departmentHomes: DepartmentHome[];
  personalHomes: PersonalHome[];
  arrangements: DayArrangement[];
  notifications: AppNotification[];
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
    filters: SAVED_FILTERS.map(copy),
    departmentHomes: DEPARTMENT_HOMES.map(copy),
    personalHomes: PERSONAL_HOMES.map(copy),
    arrangements: DAY_ARRANGEMENTS.map(copy),
    notifications: NOTIFICATIONS.map(copy),
    pinned: initialPinned(),
    pinnedFilters: new Map(),
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

/** Ripristina lo stato (sessione, dati, errori iniettati). */
export function resetStore(): void {
  failures.clear();
  callCounter = 0;
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

export const openDecisions = () =>
  state.decisions.filter((d) => d.answer === null && d.withdrawnAt === null);

export function stallOfTask(task: Task, open: DecisionRequest[] = openDecisions()): Stall | null {
  return stallOf(task, {
    family: familyOf(task),
    openDecisions: open,
    tasksById: state.tasksById,
    familyOf,
    thresholds: state.projectsById.get(task.projectId)!.stallThresholds,
  });
}

export function filterContext(): FilterContext {
  const open = openDecisions();
  return {
    familyOf,
    isStalled: (task) => stallOfTask(task, open) !== null,
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
