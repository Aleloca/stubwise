import { matches, type FilterContext } from "../domain/filters";
import { stallOf, type Stall } from "../domain/stalled";
import { ACTIVITY } from "./seed/activity";
import { DECISION_REQUESTS } from "./seed/decisions";
import { DEPARTMENT_ROLES } from "./seed/departmentRoles";
import { DEPARTMENTS } from "./seed/departments";
import { SAVED_FILTERS } from "./seed/filters";
import { DAY_ARRANGEMENTS, DEPARTMENT_HOMES, PERSONAL_HOMES } from "./seed/homes";
import { MILESTONES } from "./seed/milestones";
import { NOTIFICATIONS } from "./seed/notifications";
import { PEOPLE } from "./seed/people";
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
  Department,
  DepartmentHome,
  DepartmentRole,
  FilterCriteria,
  Milestone,
  Person,
  PersonalHome,
  Project,
  ProjectPulse,
  ProjectRequest,
  ProjectStatus,
  SavedFilter,
  SearchResult,
  StatusFamily,
  Task,
  TimelineEvent,
} from "./types";
import { can, viewerFor } from "./viewer";

export type { SearchResult } from "./types";

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
  | "listDepartmentHomes"
  | "getPersonalHome"
  | "listDepartmentRoles"
  | "listDayArrangements"
  | "listStalled"
  | "projectPulse"
  | "listTimeline"
  | "listNotifications"
  | "markNotification"
  | "search";
const failures = new Set<ApiFnName>();

/** Fissa la latenza simulata (ms); `0` per i test, `null` per tornare a 150–400 ms. */
export function setLatency(ms: number | null): void {
  latencyOverride = ms;
}

/** La prossima chiamata a `fnName` (e solo quella) viene rifiutata. */
export function failNext(fnName: ApiFnName): void {
  failures.add(fnName);
}

/** Ripristina lo stato (sessione, fissati, notifiche, errori iniettati). */
export function resetApi(): void {
  failures.clear();
  callCounter = 0;
  setSessionPersonId(DEFAULT_SESSION_PERSON_ID);
  pinned = initialPinned();
  notifications = NOTIFICATIONS.map((n) => ({ ...n }));
}

/**
 * Attende la latenza simulata e restituisce chi sta guardando. La persona si
 * legge PRIMA dell'attesa: una chiamata partita a nome di una persona
 * risponde per lei anche se nel frattempo si è cambiato «vedi come».
 */
async function gate(fnName: ApiFnName): Promise<string> {
  const me = getSessionPersonId();
  // Latenza deterministica (150–400 ms) che varia da una chiamata all'altra.
  const ms = latencyOverride ?? 150 + ((callCounter++ * 97) % 251);
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  if (failures.delete(fnName)) throw new Error(`Simulated failure: ${fnName}`);
  return me;
}

// --- stato ------------------------------------------------------------------

function initialPinned(): Map<string, string[]> {
  return new Map(
    Object.entries(INITIAL_PINNED_CODES).map(([personId, codes]) => [
      personId,
      codes.map((c) => PROJECTS.find((p) => p.code === c)!.id),
    ]),
  );
}

let pinned = initialPinned();
let notifications: AppNotification[] = NOTIFICATIONS.map((n) => ({ ...n }));

// --- visibilità e derivati (come sul server) --------------------------------

const projectsById = new Map(PROJECTS.map((p) => [p.id, p]));
const statusById = new Map(PROJECT_STATUSES.map((s) => [s.id, s]));
const tasksById = new Map(TASKS.map((t) => [t.id, t]));

/** I progetti che una persona vede: quelli di cui è membro, o tutti se è full admin. */
export function visibleProjectIds(personId: string): Set<string> {
  const viewer = viewerFor(personId);
  if (viewer.instancePermissions.includes("instance.full_admin")) {
    return new Set(PROJECTS.map((p) => p.id));
  }
  return new Set(PROJECTS.filter((p) => p.memberIds.includes(personId)).map((p) => p.id));
}

const familyOf = (task: Task): StatusFamily => statusById.get(task.statusId)!.family;

const openDecisions = () =>
  DECISION_REQUESTS.filter((d) => d.answer === null && d.withdrawnAt === null);

function stallOfTask(task: Task, open: DecisionRequest[] = openDecisions()): Stall | null {
  return stallOf(task, {
    family: familyOf(task),
    openDecisions: open,
    tasksById,
    familyOf,
    thresholds: projectsById.get(task.projectId)!.stallThresholds,
  });
}

function filterContext(): FilterContext {
  const open = openDecisions();
  return {
    familyOf,
    isStalled: (task) => stallOfTask(task, open) !== null,
    projectName: (id) => projectsById.get(id)?.name ?? "",
  };
}

function visibleTasks(personId: string): Task[] {
  const visible = visibleProjectIds(personId);
  return TASKS.filter((t) => visible.has(t.projectId));
}

/** Progetti dove la persona deve decidere qualcosa: decisioni aperte per lei, richieste nuove da trasformare. */
function waitingOnMe(personId: string): Set<string> {
  const visible = visibleProjectIds(personId);
  const viewer = viewerFor(personId);
  const out = new Set<string>();
  for (const d of openDecisions()) {
    const projectId = tasksById.get(d.taskId)!.projectId;
    if (d.askedOfId === personId && visible.has(projectId)) out.add(projectId);
  }
  for (const r of REQUESTS) {
    if (
      r.status === "new" &&
      visible.has(r.projectId) &&
      can(viewer, "tickets.create", r.projectId)
    )
      out.add(r.projectId);
  }
  return out;
}

const copy = <T extends object>(x: T): T => structuredClone(x);

// --- letture ----------------------------------------------------------------

export async function listDepartments(): Promise<Department[]> {
  await gate("listDepartments");
  return DEPARTMENTS.map(copy);
}

export async function listPeople(): Promise<Person[]> {
  await gate("listPeople");
  return PEOPLE.map(copy);
}

export async function listProjects(): Promise<Project[]> {
  const me = await gate("listProjects");
  const visible = visibleProjectIds(me);
  return PROJECTS.filter((p) => visible.has(p.id)).map(copy);
}

/** Un progetto invisibile risponde come uno che non esiste: `null`. */
export async function getProjectByCode(code: string): Promise<Project | null> {
  const me = await gate("getProjectByCode");
  const project = PROJECTS.find((p) => p.code === code.toUpperCase());
  return project && visibleProjectIds(me).has(project.id) ? copy(project) : null;
}

/** I fissati di chi guarda, nell'ordine in cui li ha fissati (solo progetti visibili). */
export async function listPinnedProjectIds(): Promise<string[]> {
  const me = await gate("listPinnedProjectIds");
  const visible = visibleProjectIds(me);
  return (pinned.get(me) ?? []).filter((id) => visible.has(id));
}

export async function setPinned(projectId: string, isPinned: boolean): Promise<void> {
  const me = await gate("setPinned");
  const mine = pinned.get(me) ?? [];
  if (isPinned) {
    if (!mine.includes(projectId) && visibleProjectIds(me).has(projectId)) {
      pinned.set(me, [...mine, projectId]);
    }
  } else {
    pinned.set(
      me,
      mine.filter((id) => id !== projectId),
    );
  }
}

/** I progetti dove qualcosa aspetta chi guarda (il punto «ti aspetta» delle tessere). */
export async function listWaitingOnMeProjectIds(): Promise<string[]> {
  const me = await gate("listWaitingOnMeProjectIds");
  return [...waitingOnMe(me)];
}

export async function listProjectStatuses(projectId: string): Promise<ProjectStatus[]> {
  const me = await gate("listProjectStatuses");
  if (!visibleProjectIds(me).has(projectId)) return [];
  return PROJECT_STATUSES.filter((s) => s.projectId === projectId)
    .sort((a, b) => a.order - b.order)
    .map(copy);
}

export async function listMilestones(projectId?: string): Promise<Milestone[]> {
  const me = await gate("listMilestones");
  const visible = visibleProjectIds(me);
  return MILESTONES.filter(
    (m) => visible.has(m.projectId) && (!projectId || m.projectId === projectId),
  ).map(copy);
}

/** Le task visibili, filtrate con i criteri (la visibilità viene prima di tutto). */
export async function listTasks(criteria?: FilterCriteria): Promise<Task[]> {
  const me = await gate("listTasks");
  const tasks = visibleTasks(me);
  if (!criteria) return tasks.map(copy);
  const ctx = filterContext();
  return tasks.filter((t) => matches(t, criteria, ctx)).map(copy);
}

export async function getTaskByCode(code: string): Promise<Task | null> {
  const me = await gate("getTaskByCode");
  const task = TASKS.find((t) => t.code === code.toUpperCase());
  return task && visibleProjectIds(me).has(task.projectId) ? copy(task) : null;
}

export async function listActivity(taskId: string): Promise<ActivityEntry[]> {
  const me = await gate("listActivity");
  const task = tasksById.get(taskId);
  if (!task || !visibleProjectIds(me).has(task.projectId)) return [];
  return ACTIVITY.filter((a) => a.taskId === taskId).map(copy);
}

export async function listDecisionRequests(filter: {
  taskId?: string;
  askedOfId?: string;
  open?: boolean;
}): Promise<DecisionRequest[]> {
  const me = await gate("listDecisionRequests");
  const visible = visibleProjectIds(me);
  return DECISION_REQUESTS.filter((d) => {
    if (!visible.has(tasksById.get(d.taskId)!.projectId)) return false;
    if (filter.taskId && d.taskId !== filter.taskId) return false;
    if (filter.askedOfId && d.askedOfId !== filter.askedOfId) return false;
    if (filter.open !== undefined) {
      const isOpen = d.answer === null && d.withdrawnAt === null;
      if (isOpen !== filter.open) return false;
    }
    return true;
  }).map(copy);
}

export async function listRequests(projectId: string): Promise<ProjectRequest[]> {
  const me = await gate("listRequests");
  if (!visibleProjectIds(me).has(projectId)) return [];
  return REQUESTS.filter((r) => r.projectId === projectId).map(copy);
}

export async function getRequest(id: string): Promise<ProjectRequest | null> {
  const me = await gate("getRequest");
  const request = REQUESTS.find((r) => r.id === id);
  return request && visibleProjectIds(me).has(request.projectId) ? copy(request) : null;
}

const canSeeFilter = (f: SavedFilter, me: string) => f.visibility === "public" || f.ownerId === me;

/** I miei filtri e i pubblici. */
export async function listSavedFilters(): Promise<SavedFilter[]> {
  const me = await gate("listSavedFilters");
  return SAVED_FILTERS.filter((f) => canSeeFilter(f, me)).map(copy);
}

/** Un filtro privato di un altro risponde come uno che non esiste: `null`. */
export async function getSavedFilter(id: string): Promise<SavedFilter | null> {
  const me = await gate("getSavedFilter");
  const filter = SAVED_FILTERS.find((f) => f.id === id);
  return filter && canSeeFilter(filter, me) ? copy(filter) : null;
}

export async function listDepartmentHomes(): Promise<DepartmentHome[]> {
  await gate("listDepartmentHomes");
  return DEPARTMENT_HOMES.map(copy);
}

/** La Home personalizzata di chi guarda; `null` se usa quella del reparto. */
export async function getPersonalHome(): Promise<PersonalHome | null> {
  const me = await gate("getPersonalHome");
  const home = PERSONAL_HOMES.find((h) => h.personId === me);
  return home ? copy(home) : null;
}

export async function listDepartmentRoles(personId?: string): Promise<DepartmentRole[]> {
  await gate("listDepartmentRoles");
  return DEPARTMENT_ROLES.filter((r) => !personId || r.personId === personId).map(copy);
}

/** Le sistemazioni nei giorni di chi guarda, per quella settimana: sono personali. */
export async function listDayArrangements(week: string): Promise<DayArrangement[]> {
  const me = await gate("listDayArrangements");
  return DAY_ARRANGEMENTS.filter((a) => a.personId === me && a.week === week).map(copy);
}

/** Le task ferme visibili (eventualmente filtrate), dalla più vecchia. */
export async function listStalled(
  criteria?: FilterCriteria,
): Promise<{ task: Task; stall: Stall }[]> {
  const me = await gate("listStalled");
  const ctx = filterContext();
  const open = openDecisions();
  return visibleTasks(me)
    .filter((t) => !criteria || matches(t, criteria, ctx))
    .flatMap((t) => {
      const stall = stallOfTask(t, open);
      return stall ? [{ task: copy(t), stall }] : [];
    })
    .sort((a, b) => b.stall.days - a.stall.days || a.task.code.localeCompare(b.task.code));
}

/** Il polso di un progetto per chi guarda; `null` se il progetto non è visibile. */
export async function projectPulse(projectId: string): Promise<ProjectPulse | null> {
  const me = await gate("projectPulse");
  const project = projectsById.get(projectId);
  if (!project || !visibleProjectIds(me).has(projectId)) return null;
  const tasks = TASKS.filter((t) => t.projectId === projectId);
  const open = openDecisions();
  const nextMilestone =
    MILESTONES.filter((m) => m.projectId === projectId && !m.closed && m.dueDate)
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
      .at(0) ?? null;
  return {
    projectId,
    open: {
      todo: tasks.filter((t) => familyOf(t) === "todo").length,
      active: tasks.filter((t) => familyOf(t) === "active").length,
    },
    stalled: tasks.filter((t) => stallOfTask(t, open) !== null).length,
    waitingOnMe: waitingOnMe(me).has(projectId),
    claudeWorking: project.signals.claudeWorking,
    nextMilestone: nextMilestone ? copy(nextMilestone) : null,
  };
}

/** Cronologia del progetto: task aperte e chiuse, traguardi; dalla più recente. */
export async function listTimeline(projectId: string): Promise<TimelineEvent[]> {
  const me = await gate("listTimeline");
  if (!visibleProjectIds(me).has(projectId)) return [];
  const events: TimelineEvent[] = [];
  for (const t of TASKS) {
    if (t.projectId !== projectId) continue;
    events.push({ kind: "task_opened", at: t.createdAt, taskId: t.id });
    if (t.closedAt) events.push({ kind: "task_closed", at: t.closedAt, taskId: t.id });
  }
  for (const m of MILESTONES) {
    if (m.projectId === projectId && m.dueDate) {
      events.push({ kind: "milestone", at: m.dueDate, milestoneId: m.id });
    }
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

/** Le notifiche di cui chi guarda è destinatario, nei progetti che vede. */
export async function listNotifications(): Promise<AppNotification[]> {
  const me = await gate("listNotifications");
  const visible = visibleProjectIds(me);
  return notifications
    .filter((n) => n.recipientIds.includes(me) && (!n.projectId || visible.has(n.projectId)))
    .map(copy);
}

export async function markNotification(
  id: string,
  change: { read?: boolean; archived?: boolean; snoozedUntil?: string | null },
): Promise<void> {
  const me = await gate("markNotification");
  notifications = notifications.map((n) =>
    n.id === id && n.recipientIds.includes(me) ? { ...n, ...change } : n,
  );
}

export async function search(q: string): Promise<SearchResult[]> {
  const me = await gate("search");
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const has = (...fields: (string | undefined)[]) =>
    fields.some((f) => f?.toLowerCase().includes(needle));
  const visible = visibleProjectIds(me);
  const results: SearchResult[] = [];
  for (const p of PROJECTS) {
    if (visible.has(p.id) && has(p.code, p.name, p.clientName)) {
      results.push({
        kind: "project",
        id: p.id,
        code: p.code,
        label: p.name,
        route: `#/p/${p.code}`,
      });
    }
  }
  for (const t of visibleTasks(me)) {
    if (has(t.code, t.title)) {
      const code = projectsById.get(t.projectId)!.code;
      results.push({
        kind: "task",
        id: t.id,
        code: t.code,
        label: t.title,
        route: `#/p/${code}/tasks`,
        departmentId: t.departmentId,
      });
    }
  }
  for (const p of PEOPLE) {
    if (!p.isClaude && has(p.name)) {
      results.push({ kind: "person", id: p.id, label: p.name, route: "#/chat" });
    }
  }
  return results;
}
