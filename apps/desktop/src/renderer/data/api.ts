import { matches } from "../domain/filters";
import { DEFAULT_CORRECTION_CAP } from "../domain/releases/prState";
import type { Stall } from "../domain/stalled";
import { accessState } from "./access/index";
import { commandsFor } from "./seed/commands";
import { COMMITS } from "./seed/commits";
import {
  canReadDocPage,
  docPageByCode,
  docPageById,
  docsAccess,
  repositoryById,
} from "./docs/reads";
import { driveRow } from "./drive/reads";
import { canSeeDriveFile } from "./drive/visibility";
import { daysFromToday, TODAY } from "./seed/dates";
import { PEOPLE } from "./seed/people";
import { projectOfRepo, REPO_FILES } from "./seed/repoFiles";
import { can, viewerFor } from "./viewer";
import { presentChatNotification } from "./chat/reads";
import { deliveredTo } from "./alerts/reads";
import { whyReceives } from "./alerts/visibility";
import { linkAccessHrefOf } from "./servers/visibility";
import { assigneeStatusOf } from "./admin/people";
import {
  canSeeConversation,
  chatKey,
  conversationPermissions,
  conversationRow,
  copy,
  eventsOf,
  filterContext,
  gate,
  hasOpenPr,
  hasRepository,
  openDecisions,
  pulseOf,
  runPreconditions,
  presentEvent,
  readableLength,
  resetStore,
  slipWeeks,
  stalledTasks,
  state,
  visibleProjectIds,
  visibleTasks,
  waitingClaudeEvents,
  waitingOnMe,
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
  DailyReport,
  DailyReportView,
  DayArrangement,
  DecisionLogEntry,
  DecisionRequest,
  Department,
  DepartmentHome,
  DepartmentRole,
  DocPage,
  FilterCriteria,
  MentionResult,
  ModelUsage,
  PrFactView,
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
/** La Chat (area 4): `api.chat.listChannels()`, `api.chat.sendMessage(…)`… */
export * as chat from "./chat";
/** I Docs (area 5): `api.docs.listDocSpaces(…)`, `api.docs.createManualPage(…)`… */
export * as docs from "./docs";
/** Il Drive (area 5): `api.drive.listDriveFiles(…)`, `api.drive.uploadFiles(…)`… */
export * as drive from "./drive";
/** La Posta (area 6): `api.mail.listMailThreads(…)`, `api.mail.syncMailbox(…)`… */
export * as mail from "./mail";
/** Il Calendario (area 6): `api.calendar.listEvents(…)`, `api.calendar.respond(…)`… */
export * as calendar from "./calendar";
/** Le Automations (area 7): `api.automations.listAutomations(…)`, `api.automations.approve(…)`… */
export * as automations from "./automations";
/** Gli avvisi (area 8a): `api.alerts.subscriptionRows()`, `api.alerts.setSubscription(…)`… */
export * as alerts from "./alerts";
/** Rilasci, PR e ambienti (area 8a): `api.releases.listOpenPrs(…)`, `api.releases.mergePr(…)`… */
export * as releases from "./releases";
/** Support (area 8a): `api.support.listSupportConversations(…)`, `api.support.replyToCustomer(…)`… */
export * as support from "./support";
/** I Server (area 8b): `api.servers.listProjectServers(…)`, `api.servers.createServer(…)`… */
export * as servers from "./servers";
/** Il registro delle modifiche (area 9a): `api.changelog.listChanges(…)`, `api.changelog.listProjectChanges(…)`. */
export * as changelog from "./changelog/reads";
/** La riconferma e l'ingresso (area 9a): `api.auth.reauthenticate(…)`, `api.auth.login(…)`… */
export * as auth from "./auth";
/** L'Amministrazione (area 9a): `api.admin.listPeople(…)`, `api.admin.addMember(…)`… */
export * as admin from "./admin";
/** Le Preferenze personali (area 9a): `api.me.getMySecurity()`, `api.me.createToken(…)`… */
export * as me from "./me";

/** Ripristina lo stato (sessione, dati, errori iniettati) e porta le task scadute alla settimana corrente. */
export function resetApi(): void {
  resetStore();
  slipWeeks();
}

// --- letture ----------------------------------------------------------------

export async function listDepartments(): Promise<Department[]> {
  await gate("listDepartments");
  return state.departments.map(copy);
}

export async function listPeople(): Promise<Person[]> {
  await gate("listPeople");
  // `deactivated` è calcolato dallo stato degli accessi (area 9a): la persona
  // resta nell'elenco (le sue task la nominano) ma non si assegna.
  return PEOPLE.map((p) => ({ ...copy(p), deactivated: assigneeStatusOf(p.id) === "deactivated" }));
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
  if (!task || !visibleProjectIds(me).has(task.projectId)) return null;
  return { ...copy(task), assigneeStatus: assigneeStatusOf(task.assigneeId) };
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
        : {
            ...base,
            kind: "plan",
            planId: event.id,
            summary: event.summary,
            // Approvazione spenta (correzione di server): si può solo rifiutare.
            blockedReason: conversationPermissions(me, c).planBlockedReason,
            serverCode: c.serverFix?.serverCode ?? null,
          };
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
 * Le pagine dei Docs di un progetto di cui chi guarda legge i Docs (per
 * Claude); un progetto senza il modulo Docs, invisibile o senza `docs.view`
 * non ne ha.
 */
export async function listDocPages(projectId: string): Promise<DocPage[]> {
  const me = await gate("listDocPages");
  if (docsAccess(me, projectId) !== "read") return [];
  return state.docPages.filter((d) => d.projectId === projectId).map(copy);
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
  // Dallo stato degli accessi: chi gestisce la Home di quale reparto.
  return accessState()
    .departments.flatMap((d) =>
      d.homeManagerIds.map(
        (id): DepartmentRole => ({
          personId: id,
          departmentId: d.departmentId,
          permissions: ["department.home.manage"],
        }),
      ),
    )
    .filter((r) => !personId || r.personId === personId);
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
  return stalledTasks(me, criteria);
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

/**
 * Le notifiche che arrivano a chi guarda, nei progetti che vede: per i kind
 * del catalogo degli avvisi (area 8a) i destinatari si calcolano adesso
 * (iscrizioni, obbligatori, permessi), per gli altri sono quelli fissi della
 * riga. Letto, archiviato e posticipato sono di chi guarda.
 */
export async function listNotifications(): Promise<AppNotification[]> {
  const me = await gate("listNotifications");
  return state.notifications.flatMap((n) => {
    const delivered = deliveredTo(me, n);
    if (!delivered) return [];
    // Una menzione della Chat si legge dal messaggio di adesso: eliminato o
    // in un canale che non legge più, non c'è.
    if (n.chatMessageId === undefined) {
      // Un avviso di un server senza accesso: «Link SSH access», di adesso.
      const href = linkAccessHrefOf(me, delivered);
      return [copy(href ? { ...delivered, linkAccessHref: href } : delivered)];
    }
    const shown = presentChatNotification(me, delivered);
    return shown ? [shown] : [];
  });
}

/** Segna una notifica per chi guarda soltanto: che Laura la legga non la segna letta per Marco. */
export async function markNotification(
  id: string,
  change: { read?: boolean; archived?: boolean; snoozedUntil?: string | null },
): Promise<void> {
  const me = await gate("markNotification");
  const n = state.notifications.find((x) => x.id === id);
  if (!n || whyReceives(me, n) === null) return;
  const key = chatKey(me, id);
  state.notificationMarks.set(key, { ...state.notificationMarks.get(key), ...change });
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
  // Il filtro per progetto vale solo per un progetto che chi guarda vede: uno
  // invisibile non trova nulla, come uno che non esiste — altrimenti direbbe
  // quali pubbliche altrui hanno come contesto un progetto che non vede.
  if (filter.projectId && !visibleProjectIds(me).has(filter.projectId)) return [];
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
      provider: c.provider ? copy(c.provider) : null,
      failureSummary:
        c.state === "finished" && c.outcome !== "ok" ? (c.failureSummary ?? null) : null,
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
            .map((d) => ({
              decidedById: d.decidedById,
              decidedAt: d.decidedAt,
              decision: d.decision,
              // Le righe del seed (in inglese) non portano l'esito: lo dice il loro testo.
              status: d.planOutcome ?? (/\brejected\b/i.test(d.decision) ? "rejected" : "approved"),
            })),
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
    prFacts: software
      ? state.prFacts
          .filter((f) => f.taskId === taskId)
          .map(
            (f): PrFactView => ({
              repo: f.repo,
              number: f.number,
              review: f.review ? copy(f.review) : null,
              branchProtected: f.branchProtected,
              queued: f.queued,
            }),
          )
      : [],
    correctionCap: state.projectsById.get(task.projectId)?.correctionCap ?? DEFAULT_CORRECTION_CAP,
    usage: usageOfTask(taskId),
  };
}

/**
 * I consumi AI di una task per modello, su tutte le sue sessioni di lavoro:
 * come `GET /api/tickets/:id/usage` di oggi, li vede chi vede la task (non
 * chi vede le sessioni), dal costo più alto.
 */
function usageOfTask(taskId: string): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const c of state.conversations) {
    if (c.kind !== "task_run" || c.taskId !== taskId) continue;
    for (const u of c.usage ?? []) {
      const sum = byModel.get(u.model) ?? {
        model: u.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      };
      sum.inputTokens += u.inputTokens;
      sum.outputTokens += u.outputTokens;
      sum.cacheReadTokens += u.cacheReadTokens;
      // Al centesimo: le somme di decimali non lasciano code di virgola mobile.
      sum.costUsd = Math.round((sum.costUsd + u.costUsd) * 100) / 100;
      byModel.set(u.model, sum);
    }
  }
  return [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
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
  const onDay = (at: string | null | undefined) => !!at && localDay(at) === date;
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
    // Un autore collegato dopo il seed («Link a person») passa sotto la persona.
    const authorId = commit.authorId ?? state.commitAuthorLinks.get(commit.authorName) ?? null;
    row(authorId, commit.authorName).commits.push({ ...copy(commit), authorId });
  }

  return [...byKey.values()]
    .filter((p) => !p.personId || !PEOPLE.find((x) => x.id === p.personId)?.isClaude)
    .filter((p) => !departmentId || p.departmentIds.includes(departmentId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Il giorno locale (YYYY-MM-DD) di un istante, nel fuso di chi guarda: la
 * rassegna conta i fatti sulla giornata di chi la legge. Nel prototipo
 * «server» e finestra stanno sulla stessa macchina, quindi è il fuso del
 * processo; il server vero lo riceverà dal client.
 */
function localDay(at: string): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * I report giornalieri di un giorno, dei progetti che chi guarda vede, per la
 * rassegna per persona (stesso permesso). Il report è sul giorno UTC, come
 * oggi: la rassegna lo mostra sul giorno scelto senza ricalcolarlo. Un
 * progetto senza riga non l'ha ancora; `summary: null` è fallito.
 */
export async function listDailyReports(date: string): Promise<DailyReportView[]> {
  const me = await gate("listDailyReports");
  if (!can(viewerFor(me), "people.activity.view")) throw new Error("forbidden");
  const visible = visibleProjectIds(me);
  return state.dailyReports
    .filter((r) => r.date === date && visible.has(r.projectId))
    .sort((a, b) => a.projectId.localeCompare(b.projectId))
    .map((r) => ({ ...copy(r), newCommits: commitsAfterReport(r) }));
}

/**
 * I commit della giornata del report (giorno UTC, come il report) arrivati
 * dopo che è stato scritto: l'avviso «N new commits not included».
 */
function commitsAfterReport(report: DailyReport): number {
  if (report.generatedAt === null || report.summary === null) return 0;
  return COMMITS.filter(
    (c) =>
      c.projectId === report.projectId &&
      c.at.slice(0, 10) === report.date &&
      c.at > report.generatedAt!,
  ).length;
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
 * I codici di task, richieste, pagine dei Docs e file del Drive scritti a
 * mano in un testo («AUD-88», «AUD-D12», «AUD-F7») che chi guarda VEDE: codice + nome, apribili. Uno che
 * non vede e uno che non esiste non tornano, e nello stesso modo (R-G5):
 * altrimenti, scrivendo un codice a caso, la differenza direbbe che cosa
 * esiste in un progetto che non si vede. Il codice tenue resta solo per le
 * citazioni registrate sul messaggio.
 */
export async function resolveCodes(codes: string[]): Promise<CitationView[]> {
  const refs = codes.flatMap((code): CitationRef[] => {
    const task = state.tasks.find((t) => t.code === code);
    if (task) return [{ kind: "task", id: task.id }];
    const request = state.requests.find((r) => r.code === code);
    if (request) return [{ kind: "request", id: request.id }];
    const page = docPageByCode(code);
    if (page) return [{ kind: "doc", id: page.id }];
    // Un file del Drive (`AUD-F7`): un nascosto vale come uno che non c'è.
    const file = state.driveFiles.find((f) => f.code === code);
    return file ? [{ kind: "drive", id: file.id, code: file.code }] : [];
  });
  return (await resolveCitations(refs)).filter((v) => v.visible);
}

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
        // Una pagina eliminata, o di Docs che chi guarda non legge: niente.
        const d = docPageById(ref.id);
        if (!d || !canReadDocPage(me, d)) return hidden(ref);
        const project = projectCodeOf(d.projectId)!;
        return {
          ...hidden(ref),
          visible: true,
          code: d.code,
          name: d.title,
          projectCode: project,
          status: d.path,
          // La pagina stessa: `#/p/<CODE>/docs/<repository>/<slug>`.
          route: `#/p/${project}/docs/${repositoryById(d.repositoryId)?.name ?? ""}/${d.slug}`,
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
      case "drive": {
        // Un file del Drive: progetto invisibile, nascosto (anche per chi lo
        // gestisce: una citazione non apre i nascosti), tolto o inesistente
        // si leggono identici — niente codice, niente nome (R-E9, R-G5).
        const f = state.driveFiles.find((x) => x.id === ref.id);
        if (!f || !canSeeDriveFile(me, f)) return hidden(ref);
        const row = driveRow(me, f);
        return {
          ...hidden(ref),
          visible: true,
          code: f.code,
          name: f.name,
          projectCode: row.projectCode,
          // Il dettaglio nel Drive del progetto; il clic sul gettone apre il file.
          route: `#/p/${row.projectCode}/drive?file=${f.code}`,
          drive: {
            type: f.type,
            google: f.source === "google",
            summary: f.summary,
            opens90d: row.opens90d,
            unavailable: f.unavailable,
            projectName: state.projectsById.get(f.projectId)!.name,
          },
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
      // Le schede degli eventi della Chat (area 4): visibili a chi vede il progetto.
      case "milestone": {
        const m = state.milestones.find((x) => x.id === ref.id);
        if (!m || !visible.has(m.projectId)) return hidden(ref);
        const project = projectCodeOf(m.projectId)!;
        return {
          ...hidden(ref),
          visible: true,
          code: project,
          name: m.name,
          projectCode: project,
          route: `#/p/${project}`,
        };
      }
      case "brief": {
        const b = state.briefs.find((x) => x.id === ref.id);
        if (!b || !visible.has(b.projectId)) return hidden(ref);
        const project = projectCodeOf(b.projectId)!;
        return {
          ...hidden(ref),
          visible: true,
          code: project,
          // La prima frase del «dove siamo»: il brief non ha un titolo.
          name: b.headline.split(/(?<=\.)\s/)[0]!,
          projectCode: project,
          route: `#/p/${project}`,
        };
      }
      case "release": {
        const r = state.releasePages.find((x) => x.id === ref.id);
        if (!r || !visible.has(r.projectId)) return hidden(ref);
        const project = projectCodeOf(r.projectId)!;
        return {
          ...hidden(ref),
          visible: true,
          code: project,
          name: `${r.version} · ${r.title}`,
          projectCode: project,
          personId: r.publishedById,
          // Le note di rilascio stanno nei Docs (come l'avviso `docs.release_note`),
          // non nella sezione Rilasci dell'area 8a.
          route: `#/p/${project}/docs`,
        };
      }
    }
  });
}

/** Quanti risultati per gruppo nei menu «#» e «@». */
export const MENTION_LIMIT = 6;

/**
 * I risultati dei menu della casella, cercando mentre si scrive: «#» task,
 * richieste, pagine dei Docs, file del Drive (per nome e codice, mai i
 * nascosti), file dei repository (con `repos.view`) e progetti; «@» le persone. Solo ciò che chi guarda può vedere; al massimo
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
        detail: state.departments.find((d) => d.id === p.departmentIds[0])?.name ?? null,
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
  const docs = state.docPages
    .filter((d) => canReadDocPage(me, d) && has(d.code, d.title, d.path))
    .map(
      (d): MentionResult => ({
        ref: { kind: "doc", id: d.id },
        // Il codice della pagina (`AUD-D3`), come una task: è quello che entra nel testo.
        code: d.code,
        label: d.title,
        detail: [projectCodeOf(d.projectId), d.path].filter(Boolean).join(" · "),
        projectId: d.projectId,
      }),
    );
  // I file del Drive: per nome e codice, mai per contenuto (il menu è veloce;
  // la ricerca per contenuto è del Drive e di ⌘K). Mai un nascosto.
  const driveFiles = state.driveFiles
    .filter((f) => canSeeDriveFile(me, f) && has(f.code, f.name))
    .map(
      (f): MentionResult => ({
        // Il codice va con la citazione (R-H5): resta anche se il file viene tolto.
        ref: { kind: "drive", id: f.id, code: f.code },
        code: f.code,
        label: f.name,
        detail: projectCodeOf(f.projectId),
        projectId: f.projectId,
        drive: { type: f.type, google: f.source === "google" },
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
  return [tasks, requests, docs, driveFiles, files, projects].flatMap(take);
}
