import { matches } from "../domain/filters";
import type { Stall } from "../domain/stalled";
import { DEPARTMENT_ROLES } from "./seed/departmentRoles";
import { DEPARTMENTS } from "./seed/departments";
import { commandsFor } from "./seed/commands";
import { COMMITS } from "./seed/commits";
import { DOC_PAGES } from "./seed/docPages";
import { daysFromToday, TODAY } from "./seed/dates";
import { PEOPLE } from "./seed/people";
import { can, viewerFor } from "./viewer";
import {
  canSeeConversation,
  conversationPermissions,
  conversationRow,
  copy,
  eventsOf,
  filterContext,
  gate,
  openDecisions,
  presentEvent,
  readableLength,
  resetStore,
  slipWeeks,
  stallScope,
  state,
  visibleProjectIds,
  visibleTasks,
  waitingOnMe,
  familyOf,
} from "./store";
import type {
  ActivityEntry,
  AppNotification,
  Conversation,
  ConversationDetail,
  ConversationFilter,
  ConversationRow,
  DayArrangement,
  DecisionLogEntry,
  DecisionRequest,
  Department,
  DepartmentHome,
  DepartmentRole,
  DocPage,
  FilterCriteria,
  Milestone,
  Person,
  PersonDayActivity,
  PersonalHome,
  Project,
  PortfolioEvent,
  ProjectPulse,
  ProjectRequest,
  ProjectStatus,
  SavedFilter,
  SearchResult,
  SlashCommand,
  Task,
  TimelineEvent,
  WeeklyBrief,
} from "./types";

export type { SearchResult } from "./types";
export type { ApiFnName } from "./store";
export { failNext, setLatency, setStreamLatency, slipWeeks, visibleProjectIds } from "./store";
export * from "./api-mutations";
export {
  mergeStreamEvent,
  onConversationChange,
  reconnectDelay,
  runScript,
  simulateDisconnect,
  subscribe,
  whenIdle,
} from "./stream";
export type { ScriptStep, StreamConnection, StreamMode, SubscribeOptions } from "./stream";

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
  const ctx = filterContext(me);
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

/** Una richiesta per codice (`STW-R4`); invisibile o inesistente: `null`. */
export async function getRequestByCode(code: string): Promise<ProjectRequest | null> {
  const me = await gate("getRequestByCode");
  const request = state.requests.find((r) => r.code === code.toUpperCase());
  return request && visibleProjectIds(me).has(request.projectId) ? copy(request) : null;
}

/**
 * Le pagine dei Docs di un progetto visibile; un progetto senza il modulo
 * Docs (o invisibile) non ne ha.
 */
export async function listDocPages(projectId: string): Promise<DocPage[]> {
  const me = await gate("listDocPages");
  const project = state.projectsById.get(projectId);
  if (!project || !visibleProjectIds(me).has(projectId) || !project.modules.includes("docs")) {
    return [];
  }
  return DOC_PAGES.filter((d) => d.projectId === projectId).map(copy);
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
  const ctx = filterContext(me);
  const stallOfTask = stallScope(me);
  return visibleTasks(me)
    .filter((t) => !criteria || matches(t, criteria, ctx))
    .flatMap((t) => {
      const stall = stallOfTask(t);
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
  const stallOfTask = stallScope(me, open);
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
    stalled: tasks.filter((t) => stallOfTask(t) !== null).length,
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

// --- conversazioni con Claude -----------------------------------------------

const FINISHED_WINDOW_DAYS = 14;

/**
 * Le conversazioni che chi guarda vede, per sezione della destinazione
 * «Claude», dalla più recente. La visibilità (`canSeeConversation`) viene
 * prima di ogni filtro: la posta resta del solo titolare anche qui.
 */
export async function listConversations(filter: ConversationFilter): Promise<ConversationRow[]> {
  const me = await gate("listConversations");
  const since = daysFromToday(-FINISHED_WINDOW_DAYS);
  return state.conversations
    .filter((c) => {
      if (!canSeeConversation(me, c)) return false;
      switch (filter.scope) {
        case "live":
          if (c.kind === "free" || c.state === "finished") return false;
          break;
        case "mine":
          if (c.kind !== "free" || c.ownerId !== me || c.archived) return false;
          break;
        case "public":
          if (c.kind !== "free" || c.visibility !== "public" || c.ownerId === me) return false;
          if (c.archived) return false;
          break;
        case "finished":
          if (c.kind === "free" || c.state !== "finished") return false;
          if (!filter.includeOlder && c.updatedAt.slice(0, 10) < since) return false;
          break;
      }
      if (filter.projectId && (c.projectId ?? c.contextProjectId) !== filter.projectId)
        return false;
      if (filter.kind && c.kind !== filter.kind) return false;
      if (filter.outcome && c.outcome !== filter.outcome) return false;
      if (filter.taskId && c.taskId !== filter.taskId) return false;
      if (filter.requestId && c.requestId !== filter.requestId) return false;
      return true;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .map((c) => conversationRow(me, c));
}

/**
 * Una conversazione con il suo flusso e ciò che chi guarda può farci (i
 * permessi li calcola il livello dati). Invisibile o inesistente: `null`.
 */
export async function getConversation(id: string): Promise<ConversationDetail | null> {
  const me = await gate("getConversation");
  const c = state.conversations.find((x) => x.id === id);
  if (!c || !canSeeConversation(me, c)) return null;
  return {
    ...conversationRow(me, c),
    ...conversationPermissions(me, c),
    events: readableEvents(me, c),
    planPreApproved: state.preApprovedPlans.has(id),
    continuesFrom: originOf(me, c),
  };
}

/** Il flusso che una persona può leggere (senza il seguito privato di una pubblica). */
function readableEvents(me: string, c: Conversation) {
  const log = eventsOf(c.id);
  return log.slice(0, readableLength(me, c)).map((_, i) => presentEvent(log, i));
}

/**
 * La pubblica da cui una continuazione parte, letta dal vivo (R-E7): se chi
 * guarda non la vede più, resta solo il suo id e `available: false`.
 */
function originOf(me: string, c: Conversation): ConversationDetail["continuesFrom"] {
  if (!c.continuesFromId) return null;
  const origin = state.conversations.find((x) => x.id === c.continuesFromId);
  if (!origin || !canSeeConversation(me, origin)) {
    return { id: c.continuesFromId, available: false, title: null, events: [] };
  }
  return {
    id: origin.id,
    available: true,
    title: origin.title,
    events: readableEvents(me, origin),
  };
}

/**
 * I comandi di «/» per il contesto di progetto della conversazione: quelli
 * di Stubwise e le skill dei plugin abilitati nel progetto. Un progetto che
 * chi guarda non vede vale come nessun contesto.
 */
export async function listCommands(contextProjectId: string | null): Promise<SlashCommand[]> {
  const me = await gate("listCommands");
  const visible = contextProjectId !== null && visibleProjectIds(me).has(contextProjectId);
  return commandsFor(visible ? contextProjectId : null).map(copy);
}

/**
 * La rassegna del giorno per persona (chi ha `people.activity.view`): task
 * chiuse e spostate, commenti, decisioni, richieste create e commit, solo
 * nei progetti che chi guarda vede. Solo eventi di Stubwise: posta e
 * calendario non entrano. Con `departmentId`, solo le persone di quel
 * reparto (gli autori di commit non collegati non ne hanno uno).
 */
export async function listPeopleActivity(
  date: string,
  departmentId?: string,
): Promise<PersonDayActivity[]> {
  const me = await gate("listPeopleActivity");
  if (!can(viewerFor(me), "people.activity.view")) throw new Error("forbidden");
  const visible = visibleProjectIds(me);
  const onDay = (at: string | null | undefined) => at?.slice(0, 10) === date;
  const byKey = new Map<string, PersonDayActivity>();
  const row = (personId: string | null, name?: string): PersonDayActivity => {
    const key = personId ?? `unlinked:${name}`;
    let entry = byKey.get(key);
    if (!entry) {
      const person = PEOPLE.find((p) => p.id === personId);
      entry = {
        personId,
        name: person?.name ?? name ?? "",
        departmentIds: person ? [...person.departmentIds] : [],
        tasksClosed: [],
        tasksMoved: [],
        comments: [],
        decisions: [],
        requestsCreated: [],
        commits: [],
      };
      byKey.set(key, entry);
    }
    return entry;
  };
  const taskRef = (taskId: string) => {
    const t = state.tasksById.get(taskId);
    return t && visible.has(t.projectId) ? t : null;
  };

  for (const t of state.tasks) {
    if (!visible.has(t.projectId) || !onDay(t.closedAt)) continue;
    row(t.assigneeId ?? t.createdById).tasksClosed.push({
      taskId: t.id,
      code: t.code,
      title: t.title,
      projectId: t.projectId,
      at: t.closedAt!,
    });
  }
  for (const a of state.activity) {
    if (!onDay(a.at) || a.authorId === null) continue;
    const t = taskRef(a.taskId);
    if (!t) continue;
    if (a.kind === "field_change" && (a.field === "status" || a.field === "week")) {
      row(a.authorId).tasksMoved.push({
        taskId: t.id,
        code: t.code,
        title: t.title,
        projectId: t.projectId,
        field: a.field,
        from: a.from ?? null,
        to: a.to ?? null,
        at: a.at,
      });
    } else if (a.kind === "comment" && !a.deletedAt) {
      row(a.authorId).comments.push({
        id: a.id,
        taskId: t.id,
        code: t.code,
        projectId: t.projectId,
        body: a.body ?? "",
        at: a.at,
      });
    }
  }
  for (const d of state.decisionLog) {
    if (!visible.has(d.projectId) || !onDay(d.decidedAt) || d.decidedById === null) continue;
    row(d.decidedById).decisions.push({
      id: d.id,
      source: "log",
      projectId: d.projectId,
      taskId: d.taskId,
      title: d.title,
      at: d.decidedAt,
    });
  }
  for (const d of state.decisions) {
    if (!d.answer || !onDay(d.answer.at)) continue;
    const t = taskRef(d.taskId);
    if (!t) continue;
    row(d.answer.byId).decisions.push({
      id: d.id,
      source: "answer",
      projectId: t.projectId,
      taskId: t.id,
      title: d.question,
      at: d.answer.at,
    });
  }
  for (const r of state.requests) {
    if (!visible.has(r.projectId) || !onDay(r.createdAt) || !r.requesterIds[0]) continue;
    row(r.requesterIds[0]).requestsCreated.push({
      requestId: r.id,
      code: r.code,
      title: r.title,
      projectId: r.projectId,
      at: r.createdAt,
    });
  }
  for (const commit of COMMITS) {
    if (!visible.has(commit.projectId) || !onDay(commit.at)) continue;
    row(commit.authorId, commit.authorName).commits.push(copy(commit));
  }

  return [...byKey.values()]
    .filter((p) => !p.personId || !PEOPLE.find((x) => x.id === p.personId)?.isClaude)
    .filter((p) => !departmentId || p.departmentIds.includes(departmentId))
    .sort((a, b) => a.name.localeCompare(b.name));
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
  // Le richieste dei progetti visibili, per codice e titolo: aprono il pannello.
  for (const r of state.requests) {
    if (visible.has(r.projectId) && has(r.code, r.title)) {
      const code = state.projectsById.get(r.projectId)!.code;
      results.push({
        kind: "request",
        id: r.id,
        code: r.code,
        label: r.title,
        route: `#/p/${code}/requests?request=${r.id}`,
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
