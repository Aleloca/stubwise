import { matches } from "../domain/filters";
import type { Stall } from "../domain/stalled";
import { DEPARTMENT_ROLES } from "./seed/departmentRoles";
import { DEPARTMENTS } from "./seed/departments";
import { commandsFor } from "./seed/commands";
import { COMMITS } from "./seed/commits";
import { DOC_PAGES } from "./seed/docPages";
import { daysFromToday, TODAY } from "./seed/dates";
import { PEOPLE } from "./seed/people";
import { projectOfRepo, REPO_FILES } from "./seed/repoFiles";
import { can, viewerFor } from "./viewer";
import {
  canSeeConversation,
  conversationPermissions,
  conversationRow,
  copy,
  eventsOf,
  filterContext,
  gate,
  hasOpenPr,
  hasRepository,
  openDecisions,
  runPreconditions,
  presentEvent,
  readableLength,
  resetStore,
  slipWeeks,
  stallScope,
  state,
  visibleProjectIds,
  visibleTasks,
  waitingClaudeEvents,
  waitingOnMe,
  familyOf,
  objectCodeOf,
} from "./store";
import type {
  ActivityEntry,
  AppNotification,
  CitationRef,
  CitationView,
  ClaudeDecision,
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
  MentionResult,
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
  TaskWork,
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

/**
 * Le domande e i piani di Claude che aspettano chi guarda («Decide» della
 * Home), dal più vecchio: solo dalle conversazioni che vede, la domanda se
 * può rispondere, il piano se ha `plans.approve`. Rispondere passa dalle
 * stesse scritture della conversazione (`answerQuestion`, `decidePlan`).
 */
export async function listClaudeDecisions(): Promise<ClaudeDecision[]> {
  const me = await gate("listClaudeDecisions");
  return waitingClaudeEvents(me)
    .map(({ conversation: c, event }): ClaudeDecision => {
      const base = {
        id: `${c.id}:${event.id}`,
        conversationId: c.id,
        conversationKind: c.kind,
        title: c.title,
        ownerId: c.ownerId,
        projectId: c.projectId,
        taskId: c.taskId,
        requestId: c.requestId,
        objectCode: objectCodeOf(c),
        at: event.at,
      };
      return event.type === "question"
        ? {
            ...base,
            kind: "question",
            questionId: event.questionId,
            text: event.text,
            options: copy(event.options),
          }
        : { ...base, kind: "plan", planId: event.id, summary: event.summary };
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
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
  return (
    state.conversations
      .filter((c) => {
        if (!canSeeConversation(me, c)) return false;
        switch (filter.scope) {
          case "live":
            if (c.kind === "free" || c.state === "finished") return false;
            break;
          case "mine":
            if (c.kind !== "free" || c.ownerId !== me) return false;
            if (c.archived !== (filter.archived ?? false)) return false;
            // Una conversazione senza nemmeno un messaggio non è fra le proprie
            // (il primo invio non è riuscito, o non è mai partito), salvo
            // mentre il primo invio è in viaggio.
            if (eventsOf(c.id).length === 0 && !state.sendingTo.has(c.id)) return false;
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
      .map((c) => conversationRow(me, c))
      // Sulla data della riga come la vede chi guarda: il seguito privato di
      // una pubblica non la fa salire per gli altri.
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  );
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

/**
 * Il refine di una richiesta come lo vede chi guarda: quello vivo (al più
 * uno per richiesta), se no il più recente già chiuso; `null` se non ce n'è
 * o chi guarda non lo vede (vederlo chiede `backlog.edit`, come scriverci).
 */
export async function getRefineOf(requestId: string): Promise<ConversationRow | null> {
  const me = await gate("getRefineOf");
  const mine = state.conversations
    .filter((c) => c.kind === "refine" && c.requestId === requestId && canSeeConversation(me, c))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const pick = mine.find((c) => c.state !== "finished") ?? mine[0];
  return pick ? conversationRow(me, pick) : null;
}

/**
 * Il lavoro di Claude su una task (la sezione «Claude» del dettaglio): le
 * sessioni di lavoro che chi guarda vede, dalla più vecchia, con il flusso
 * leggibile; le PR della task dalla piattaforma. Task invisibile: `null`.
 */
export async function getTaskWork(taskId: string): Promise<TaskWork | null> {
  const me = await gate("getTaskWork");
  const task = state.tasksById.get(taskId);
  if (!task || !visibleProjectIds(me).has(task.projectId)) return null;
  const runs = state.conversations
    .filter((c) => c.kind === "task_run" && c.taskId === taskId && canSeeConversation(me, c))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      ownerId: c.ownerId,
      createdAt: c.createdAt,
      state: c.state,
      outcome: c.outcome,
      events: readableEvents(me, c),
    }));
  const software = hasRepository(task.projectId);
  const viewer = viewerFor(me);
  const ready = runPreconditions(task);
  const availability = (stateAllows: boolean, perm: "runs.start" | "corrections.request") =>
    !stateAllows ? "unavailable" : can(viewer, perm, task.projectId) ? "allowed" : "forbidden";
  const latest = state.conversations.find((c) => c.id === runs.at(-1)?.id);
  return {
    runs,
    pullRequests: software
      ? state.pullRequests
          .filter((pr) => pr.taskId === taskId)
          .sort((a, b) => a.at.localeCompare(b.at))
          .map(copy)
      : [],
    software,
    openPr: hasOpenPr(task),
    // Solo se chi guarda vede le sessioni: le decisioni sui piani le raccontano.
    planDecisions:
      runs.length === 0
        ? []
        : state.decisionLog
            .filter((d) => d.taskId === taskId && d.source === "plan_review")
            .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt))
            .map((d) => ({ decidedById: d.decidedById, decidedAt: d.decidedAt, decision: d.decision })),
    waitsOnViewer: latest ? conversationRow(me, latest).waitsOnViewer : false,
    hiddenRuns: state.conversations.some(
      (c) => c.kind === "task_run" && c.taskId === taskId && !canSeeConversation(me, c),
    ),
    actions: {
      start: availability(ready.start, "runs.start"),
      relaunch: availability(ready.relaunch, "runs.start"),
      resume: availability(ready.resume, "corrections.request"),
      requestChanges: availability(ready.requestChanges, "corrections.request"),
    },
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
    return { id: c.continuesFromId, available: false, title: null, ownerId: null, events: [] };
  }
  return {
    id: origin.id,
    available: true,
    title: origin.title,
    ownerId: origin.ownerId,
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

// --- citazioni e menu della casella ------------------------------------------

const projectCodeOf = (projectId: string) => state.projectsById.get(projectId)?.code ?? null;

/**
 * Gli oggetti citati in una conversazione, come li legge chi guarda: per
 * l'anteprima e per aprirli. Quello che non vede arriva con `visible: false`:
 * una task, una richiesta o un progetto col solo codice (R-E9: il testo si
 * legge, il codice non si apre), mai il titolo; pagine, file e il resto
 * senza nulla.
 */
export async function resolveCitations(refs: CitationRef[]): Promise<CitationView[]> {
  const me = await gate("resolveCitations");
  const visible = visibleProjectIds(me);
  const viewer = viewerFor(me);
  const hidden = (ref: CitationRef): CitationView => ({
    kind: ref.kind,
    id: ref.id,
    visible: false,
    code: null,
    name: null,
    projectCode: null,
    status: null,
    personId: null,
    route: null,
  });
  return refs.map((ref): CitationView => {
    switch (ref.kind) {
      case "task": {
        const t = state.tasksById.get(ref.id);
        if (!t) return hidden(ref);
        // R-E9: chi non vede il progetto legge il codice, mai il titolo.
        if (!visible.has(t.projectId)) return { ...hidden(ref), code: t.code };
        const project = projectCodeOf(t.projectId)!;
        return {
          ...hidden(ref),
          visible: true,
          code: t.code,
          name: t.title,
          projectCode: project,
          status: state.statusById.get(t.statusId)?.name ?? null,
          personId: t.assigneeId,
          route: `#/p/${project}/tasks?task=${t.code}`,
        };
      }
      case "request": {
        const r = state.requests.find((x) => x.id === ref.id);
        if (!r) return hidden(ref);
        if (!visible.has(r.projectId)) return { ...hidden(ref), code: r.code };
        const project = projectCodeOf(r.projectId)!;
        return {
          ...hidden(ref),
          visible: true,
          code: r.code,
          name: r.title,
          projectCode: project,
          status: r.status,
          personId: r.requesterIds[0] ?? null,
          route: `#/p/${project}/requests?request=${r.id}`,
        };
      }
      case "doc": {
        const d = DOC_PAGES.find((x) => x.id === ref.id);
        if (!d || !visible.has(d.projectId)) return hidden(ref);
        const project = projectCodeOf(d.projectId)!;
        return {
          ...hidden(ref),
          visible: true,
          code: project,
          name: d.title,
          projectCode: project,
          status: d.path,
          route: `#/p/${project}/docs`,
        };
      }
      case "file": {
        const [repo = "", ...rest] = ref.id.split(":");
        const projectId = projectOfRepo(repo);
        if (!projectId || !visible.has(projectId) || !can(viewer, "repos.view", projectId)) {
          return hidden(ref);
        }
        return {
          ...hidden(ref),
          visible: true,
          code: repo,
          name: rest.join(":"),
          projectCode: projectCodeOf(projectId),
        };
      }
      case "project": {
        const p = state.projectsById.get(ref.id);
        if (!p) return hidden(ref);
        if (!visible.has(p.id)) return { ...hidden(ref), code: p.code };
        return {
          ...hidden(ref),
          visible: true,
          code: p.code,
          name: p.name,
          projectCode: p.code,
          route: `#/p/${p.code}`,
        };
      }
      case "person": {
        const p = PEOPLE.find((x) => x.id === ref.id);
        if (!p) return hidden(ref);
        return { ...hidden(ref), visible: true, name: p.name, personId: p.id };
      }
    }
  });
}

/** Quanti risultati per gruppo nei menu «#» e «@». */
export const MENTION_LIMIT = 6;

/**
 * I risultati dei menu della casella, cercando mentre si scrive: «#» task,
 * richieste, pagine dei Docs, file dei repository (con `repos.view`) e
 * progetti; «@» le persone. Solo ciò che chi guarda può vedere; al massimo
 * `MENTION_LIMIT` per gruppo.
 */
export async function searchMentions(
  q: string,
  kind: "objects" | "people",
): Promise<MentionResult[]> {
  const me = await gate("searchMentions");
  const needle = q.trim().toLowerCase();
  const has = (...fields: (string | null | undefined)[]) =>
    !needle || fields.some((f) => f?.toLowerCase().includes(needle));
  const take = <T>(list: T[]) => list.slice(0, MENTION_LIMIT);

  if (kind === "people") {
    return take(
      PEOPLE.filter((p) => !p.isClaude && has(p.name)).map<MentionResult>((p) => ({
        ref: { kind: "person", id: p.id },
        code: null,
        label: p.name,
        detail: DEPARTMENTS.find((d) => d.id === p.departmentIds[0])?.name ?? null,
        projectId: null,
      })),
    );
  }

  const visible = visibleProjectIds(me);
  const viewer = viewerFor(me);
  const projectName = (id: string) => state.projectsById.get(id)?.name ?? null;
  const tasks = visibleTasks(me)
    .filter((t) => has(t.code, t.title))
    .map<MentionResult>((t) => ({
      ref: { kind: "task", id: t.id },
      code: t.code,
      label: t.title,
      detail: projectName(t.projectId),
      projectId: t.projectId,
    }));
  const requests = state.requests
    .filter((r) => visible.has(r.projectId) && r.mergedIntoId === null && has(r.code, r.title))
    .map<MentionResult>((r) => ({
      ref: { kind: "request", id: r.id },
      code: r.code,
      label: r.title,
      detail: projectName(r.projectId),
      projectId: r.projectId,
    }));
  const docs = DOC_PAGES.filter((d) => visible.has(d.projectId) && has(d.title, d.path)).map(
    (d): MentionResult => ({
      ref: { kind: "doc", id: d.id },
      code: projectCodeOf(d.projectId),
      label: d.title,
      detail: d.path,
      projectId: d.projectId,
    }),
  );
  const files = REPO_FILES.filter(
    (f) => visible.has(f.projectId) && can(viewer, "repos.view", f.projectId) && has(f.path),
  ).map(
    (f): MentionResult => ({
      ref: { kind: "file", id: f.id },
      code: null,
      label: f.path,
      detail: f.repo,
      projectId: f.projectId,
    }),
  );
  const projects = state.projects
    .filter((p) => visible.has(p.id) && has(p.code, p.name, p.clientName))
    .map<MentionResult>((p) => ({
      ref: { kind: "project", id: p.id },
      code: p.code,
      label: p.name,
      detail: p.clientName ?? null,
      projectId: p.id,
    }));
  return [tasks, requests, docs, files, projects].flatMap(take);
}
