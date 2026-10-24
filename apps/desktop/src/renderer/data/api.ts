import { matches } from "../domain/filters";
import type { Stall } from "../domain/stalled";
import { DEPARTMENT_ROLES } from "./seed/departmentRoles";
import { DEPARTMENTS } from "./seed/departments";
import { TODAY } from "./seed/dates";
import { PEOPLE } from "./seed/people";
import { can, viewerFor } from "./viewer";
import {
  copy,
  filterContext,
  gate,
  openDecisions,
  resetStore,
  slipWeeks,
  stallOfTask,
  state,
  visibleProjectIds,
  visibleTasks,
  waitingOnMe,
  familyOf,
} from "./store";
import type {
  ActivityEntry,
  AppNotification,
  DayArrangement,
  DecisionLogEntry,
  DecisionRequest,
  Department,
  DepartmentHome,
  DepartmentRole,
  FilterCriteria,
  Milestone,
  Person,
  PersonalHome,
  Project,
  PortfolioEvent,
  ProjectPulse,
  ProjectRequest,
  ProjectStatus,
  SavedFilter,
  SearchResult,
  Task,
  TimelineEvent,
  WeeklyBrief,
} from "./types";

export type { SearchResult } from "./types";
export type { ApiFnName } from "./store";
export { failNext, setLatency, slipWeeks, visibleProjectIds } from "./store";
export * from "./api-mutations";

/** Ripristina lo stato (sessione, dati, errori iniettati) e porta le task scadute alla settimana corrente. */
export function resetApi(): void {
  resetStore();
  slipWeeks();
}

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
  return state.projects.filter((p) => visible.has(p.id)).map(copy);
}

/** Un progetto invisibile risponde come uno che non esiste: `null`. */
export async function getProjectByCode(code: string): Promise<Project | null> {
  const me = await gate("getProjectByCode");
  const project = state.projects.find((p) => p.code === code.toUpperCase());
  return project && visibleProjectIds(me).has(project.id) ? copy(project) : null;
}

/** I fissati di chi guarda, nell'ordine in cui li ha fissati (solo progetti visibili). */
export async function listPinnedProjectIds(): Promise<string[]> {
  const me = await gate("listPinnedProjectIds");
  const visible = visibleProjectIds(me);
  return (state.pinned.get(me) ?? []).filter((id) => visible.has(id));
}

export async function setPinned(projectId: string, isPinned: boolean): Promise<void> {
  const me = await gate("setPinned");
  const mine = state.pinned.get(me) ?? [];
  if (isPinned) {
    if (!mine.includes(projectId) && visibleProjectIds(me).has(projectId)) {
      state.pinned.set(me, [...mine, projectId]);
    }
  } else {
    state.pinned.set(
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
  return state.statuses
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => a.order - b.order)
    .map(copy);
}

export async function listMilestones(projectId?: string): Promise<Milestone[]> {
  const me = await gate("listMilestones");
  const visible = visibleProjectIds(me);
  return state.milestones
    .filter((m) => visible.has(m.projectId) && (!projectId || m.projectId === projectId))
    .map(copy);
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
  const task = state.tasks.find((t) => t.code === code.toUpperCase());
  return task && visibleProjectIds(me).has(task.projectId) ? copy(task) : null;
}

export async function listActivity(taskId: string): Promise<ActivityEntry[]> {
  const me = await gate("listActivity");
  const task = state.tasksById.get(taskId);
  if (!task || !visibleProjectIds(me).has(task.projectId)) return [];
  return state.activity.filter((a) => a.taskId === taskId).map(copy);
}

export async function listDecisionRequests(filter: {
  taskId?: string;
  askedOfId?: string;
  open?: boolean;
}): Promise<DecisionRequest[]> {
  const me = await gate("listDecisionRequests");
  const visible = visibleProjectIds(me);
  return state.decisions
    .filter((d) => {
      if (!visible.has(state.tasksById.get(d.taskId)!.projectId)) return false;
      if (filter.taskId && d.taskId !== filter.taskId) return false;
      if (filter.askedOfId && d.askedOfId !== filter.askedOfId) return false;
      if (filter.open !== undefined) {
        const isOpen = d.answer === null && d.withdrawnAt === null;
        if (isOpen !== filter.open) return false;
      }
      return true;
    })
    .map(copy);
}

export async function listRequests(projectId: string): Promise<ProjectRequest[]> {
  const me = await gate("listRequests");
  if (!visibleProjectIds(me).has(projectId)) return [];
  return state.requests.filter((r) => r.projectId === projectId).map(copy);
}

/**
 * Le richieste ancora da trasformare (nuove, in rifinitura, pronte; non
 * fuse) nei progetti dove chi guarda può creare task, dalla più recente.
 */
export async function listRequestsToConvert(): Promise<ProjectRequest[]> {
  const me = await gate("listRequestsToConvert");
  const viewer = viewerFor(me);
  const visible = visibleProjectIds(me);
  return state.requests
    .filter(
      (r) =>
        (r.status === "new" || r.status === "refining" || r.status === "ready") &&
        r.mergedIntoId === null &&
        visible.has(r.projectId) &&
        can(viewer, "tickets.create", r.projectId),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(copy);
}

export async function getRequest(id: string): Promise<ProjectRequest | null> {
  const me = await gate("getRequest");
  const request = state.requests.find((r) => r.id === id);
  return request && visibleProjectIds(me).has(request.projectId) ? copy(request) : null;
}

const canSeeFilter = (f: SavedFilter, me: string) => f.visibility === "public" || f.ownerId === me;

/** I miei filtri e i pubblici. */
export async function listSavedFilters(): Promise<SavedFilter[]> {
  const me = await gate("listSavedFilters");
  return state.filters.filter((f) => canSeeFilter(f, me)).map(copy);
}

/** Un filtro privato di un altro risponde come uno che non esiste: `null`. */
export async function getSavedFilter(id: string): Promise<SavedFilter | null> {
  const me = await gate("getSavedFilter");
  const filter = state.filters.find((f) => f.id === id);
  return filter && canSeeFilter(filter, me) ? copy(filter) : null;
}

/** I filtri che chi guarda ha fissato (solo quelli che può ancora vedere), nell'ordine in cui li ha fissati. */
export async function listPinnedFilterIds(): Promise<string[]> {
  const me = await gate("listPinnedFilterIds");
  return (state.pinnedFilters.get(me) ?? []).filter((id) => {
    const f = state.filters.find((x) => x.id === id);
    return f && canSeeFilter(f, me);
  });
}

export async function listDepartmentHomes(): Promise<DepartmentHome[]> {
  await gate("listDepartmentHomes");
  return state.departmentHomes.map(copy);
}

/** La Home personalizzata di chi guarda; `null` se usa quella del reparto. */
export async function getPersonalHome(): Promise<PersonalHome | null> {
  const me = await gate("getPersonalHome");
  const home = state.personalHomes.find((h) => h.personId === me);
  return home ? copy(home) : null;
}

export async function listDepartmentRoles(personId?: string): Promise<DepartmentRole[]> {
  await gate("listDepartmentRoles");
  return DEPARTMENT_ROLES.filter((r) => !personId || r.personId === personId).map(copy);
}

/** Le sistemazioni nei giorni di chi guarda, per quella settimana: sono personali. */
export async function listDayArrangements(week: string): Promise<DayArrangement[]> {
  const me = await gate("listDayArrangements");
  return state.arrangements.filter((a) => a.personId === me && a.week === week).map(copy);
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
  const project = state.projectsById.get(projectId);
  if (!project || !visibleProjectIds(me).has(projectId)) return null;
  return pulseOf(me, project, openDecisions());
}

/**
 * Il polso di ogni progetto visibile (il portafoglio): la stessa formula di
 * `projectPulse`, in una chiamata sola invece di una per riga.
 */
export async function listProjectPulses(): Promise<ProjectPulse[]> {
  const me = await gate("listProjectPulses");
  const visible = visibleProjectIds(me);
  const open = openDecisions();
  return state.projects.filter((p) => visible.has(p.id)).map((p) => pulseOf(me, p, open));
}

function pulseOf(me: string, project: Project, open: DecisionRequest[]): ProjectPulse {
  const projectId = project.id;
  const tasks = state.tasks.filter((t) => t.projectId === projectId);
  const nextMilestone =
    state.milestones
      .filter((m) => m.projectId === projectId && !m.closed && m.dueDate)
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

/**
 * Cronologia del progetto (la Roadmap del web), dalla più recente: task
 * aperte e chiuse, traguardi (alla loro data, anche futura), decisioni del
 * registro, brief settimanali, report giornalieri, pull request.
 */
export async function listTimeline(projectId: string): Promise<TimelineEvent[]> {
  const me = await gate("listTimeline");
  if (!visibleProjectIds(me).has(projectId)) return [];
  return timelineOf(projectId);
}

/**
 * L'attività di tutti i progetti visibili (la «Activity» del portafoglio),
 * dalla più recente: le stesse voci della cronologia di ogni progetto, con
 * il progetto accanto. Solo ciò che è già successo: i traguardi futuri non
 * sono attività.
 */
export async function listPortfolioActivity(): Promise<PortfolioEvent[]> {
  const me = await gate("listPortfolioActivity");
  const visible = visibleProjectIds(me);
  return state.projects
    .filter((p) => visible.has(p.id))
    .flatMap((p) => timelineOf(p.id).map((e) => ({ ...e, projectId: p.id })))
    .filter((e) => e.at.slice(0, 10) <= TODAY)
    .sort((a, b) => b.at.localeCompare(a.at));
}

function timelineOf(projectId: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const t of state.tasks) {
    if (t.projectId !== projectId) continue;
    events.push({ kind: "task_opened", at: t.createdAt, taskId: t.id });
    if (t.closedAt) events.push({ kind: "task_closed", at: t.closedAt, taskId: t.id });
  }
  for (const m of state.milestones) {
    if (m.projectId === projectId && m.dueDate) {
      events.push({ kind: "milestone", at: m.dueDate, milestoneId: m.id });
    }
  }
  for (const d of state.decisionLog) {
    if (d.projectId !== projectId) continue;
    events.push({ kind: "decision", at: d.decidedAt, decisionId: d.id, title: d.title });
  }
  for (const b of state.briefs) {
    if (b.projectId !== projectId) continue;
    events.push({ kind: "brief", at: b.createdAt, briefId: b.id, headline: b.headline });
  }
  for (const r of state.dailyReports) {
    if (r.projectId !== projectId) continue;
    // Il report di un giorno si colloca a fine giornata.
    events.push({
      kind: "daily_report",
      at: `${r.date}T20:00:00Z`,
      reportId: r.id,
      summary: r.summary,
    });
  }
  for (const pr of state.pullRequests) {
    if (pr.projectId !== projectId) continue;
    events.push({ kind: pr.kind, at: pr.at, prId: pr.id, taskId: pr.taskId, number: pr.number });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

/** Il registro decisioni del progetto, dalla più recente (superate comprese). */
export async function listDecisionLog(projectId: string): Promise<DecisionLogEntry[]> {
  const me = await gate("listDecisionLog");
  if (!visibleProjectIds(me).has(projectId)) return [];
  return state.decisionLog
    .filter((d) => d.projectId === projectId)
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt) || b.id.localeCompare(a.id))
    .map(copy);
}

/** L'ultimo brief settimanale del progetto; `null` se non ce n'è ancora uno. */
export async function getLatestBrief(projectId: string): Promise<WeeklyBrief | null> {
  const me = await gate("getLatestBrief");
  if (!visibleProjectIds(me).has(projectId)) return null;
  const latest = state.briefs
    .filter((b) => b.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .at(0);
  return latest ? copy(latest) : null;
}

/** Le notifiche di cui chi guarda è destinatario, nei progetti che vede. */
export async function listNotifications(): Promise<AppNotification[]> {
  const me = await gate("listNotifications");
  const visible = visibleProjectIds(me);
  return state.notifications
    .filter((n) => n.recipientIds.includes(me) && (!n.projectId || visible.has(n.projectId)))
    .map(copy);
}

export async function markNotification(
  id: string,
  change: { read?: boolean; archived?: boolean; snoozedUntil?: string | null },
): Promise<void> {
  const me = await gate("markNotification");
  state.notifications = state.notifications.map((n) =>
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
  for (const p of state.projects) {
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
      const code = state.projectsById.get(t.projectId)!.code;
      results.push({
        kind: "task",
        id: t.id,
        code: t.code,
        label: t.title,
        route: `#/p/${code}/tasks?task=${t.code}`,
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
