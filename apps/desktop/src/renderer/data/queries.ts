import {
  keepPreviousData,
  QueryClient,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import type { MailDraftRequest } from "../domain/claude/intents/mailDraft";
import { resolveHome } from "../domain/home";
import { MIN_QUERY } from "../pages/chat/search";
import type {
  Attachment,
  AutomationFlow,
  AutomationMeta,
  AutomationRunRow,
  ClientProjectLink,
  CalendarEventInput,
  CalendarEventPatch,
  CalendarEventView,
  CalendarScope,
  CalendarSeriesPatch,
  ChannelPatch,
  ChatEventKind,
  ChatMessageInput,
  ChatMessageView,
  ChatSearchFilters,
  CitationRef,
  NewChannelInput,
  NewTaskInput,
  NotifyLevel,
  ConversationEvent,
  ConversationFilter,
  DayArrangement,
  DecisionDraft,
  DepartmentHome,
  DocGeneration,
  DocsQuestion,
  DriveFileRow,
  DriveFilters,
  DriveOpen,
  DriveSearchScope,
  DriveUploadInput,
  GraphActionKind,
  GraphState,
  ManualPageInput,
  FilterCriteria,
  HomeBlockRef,
  MailboxView,
  MailDraft,
  MailProposalFilters,
  MailThreadFilters,
  MailThreadRow,
  MilestoneInput,
  MilestonePatch,
  Person,
  PersonalHome,
  Project,
  ProjectRequest,
  ProjectStatus,
  RefinePatch,
  Rsvp,
  StatusInput,
  Task,
  TaskPatch,
} from "./types";
import { useViewer } from "./viewer";

/**
 * Ogni chiave comincia con `["as", personId]`: cambiare persona «vedi come»
 * cambia tutte le chiavi, quindi nessun dato della persona precedente resta a
 * schermo (le query nuove partono da `pending`).
 */
export const queryKeys = {
  all: (personId: string) => ["as", personId] as const,
  departments: (personId: string) => ["as", personId, "departments"] as const,
  people: (personId: string) => ["as", personId, "people"] as const,
  projects: (personId: string) => ["as", personId, "projects"] as const,
  project: (personId: string, code: string) => ["as", personId, "project", code] as const,
  pinned: (personId: string) => ["as", personId, "pinned"] as const,
  waitingOnMe: (personId: string) => ["as", personId, "waitingOnMe"] as const,
  statuses: (personId: string, projectId: string) =>
    ["as", personId, "statuses", projectId] as const,
  milestones: (personId: string, projectId?: string) =>
    ["as", personId, "milestones", projectId ?? null] as const,
  tasks: (personId: string, criteria?: FilterCriteria) =>
    ["as", personId, "tasks", criteria ?? null] as const,
  task: (personId: string, code: string) => ["as", personId, "task", code] as const,
  activity: (personId: string, taskId: string) => ["as", personId, "activity", taskId] as const,
  decisions: (personId: string, filter: { taskId?: string; askedOfId?: string; open?: boolean }) =>
    ["as", personId, "decisions", filter] as const,
  requests: (personId: string, projectId: string) =>
    ["as", personId, "requests", projectId] as const,
  request: (personId: string, id: string) => ["as", personId, "request", id] as const,
  refineOf: (personId: string, requestId: string) =>
    ["as", personId, "refineOf", requestId] as const,
  requestsToConvert: (personId: string) => ["as", personId, "requests", "toConvert"] as const,
  savedFilters: (personId: string) => ["as", personId, "savedFilters"] as const,
  savedFilter: (personId: string, id: string) => ["as", personId, "savedFilter", id] as const,
  pinnedFilters: (personId: string) => ["as", personId, "pinnedFilters"] as const,
  departmentHomes: (personId: string) => ["as", personId, "departmentHomes"] as const,
  personalHome: (personId: string) => ["as", personId, "personalHome"] as const,
  departmentRoles: (personId: string, of?: string) =>
    ["as", personId, "departmentRoles", of ?? null] as const,
  dayArrangements: (personId: string, week: string) =>
    ["as", personId, "dayArrangements", week] as const,
  stalled: (personId: string, criteria?: FilterCriteria) =>
    ["as", personId, "stalled", criteria ?? null] as const,
  pulse: (personId: string, projectId: string) => ["as", personId, "pulse", projectId] as const,
  // Il polso di tutti e l'attività del portafoglio stanno nelle aree «pulse» e
  // «timeline»: le scritture che le toccano le ricaricano già.
  pulses: (personId: string) => ["as", personId, "pulse", "*all"] as const,
  timeline: (personId: string, projectId: string) =>
    ["as", personId, "timeline", projectId] as const,
  portfolioActivity: (personId: string) => ["as", personId, "timeline", "*portfolio"] as const,
  decisionLog: (personId: string, projectId: string) =>
    ["as", personId, "decisionLog", projectId] as const,
  latestBrief: (personId: string, projectId: string) =>
    ["as", personId, "latestBrief", projectId] as const,
  notifications: (personId: string) => ["as", personId, "notifications"] as const,
  search: (personId: string, q: string) => ["as", personId, "search", q] as const,
  conversations: (personId: string, filter: ConversationFilter) =>
    ["as", personId, "conversations", filter] as const,
  conversation: (personId: string, id: string) => ["as", personId, "conversation", id] as const,
  /**
   * Le domande e i piani di Claude per «Decide»: nell'area delle
   * conversazioni, quindi si rileggono quando una sessione cambia.
   */
  claudeDecisions: (personId: string) => ["as", personId, "conversations", "decide"] as const,
  /** Nell'area delle conversazioni: si rilegge quando una sessione della task cambia. */
  taskWork: (personId: string, taskId: string) =>
    ["as", personId, "conversations", "task-work", taskId] as const,
  commands: (personId: string, contextProjectId: string | null) =>
    ["as", personId, "commands", contextProjectId] as const,
  citations: (personId: string, refs: string) => ["as", personId, "citations", refs] as const,
  codeCitations: (personId: string, codes: string) =>
    ["as", personId, "codeCitations", codes] as const,
  mentions: (personId: string, kind: "objects" | "people", q: string) =>
    ["as", personId, "mentions", kind, q] as const,
  peopleActivity: (personId: string, date: string, departmentId?: string) =>
    ["as", personId, "peopleActivity", date, departmentId ?? null] as const,
  dailyReports: (personId: string, date: string) => ["as", personId, "dailyReports", date] as const,
  // Chat (area 4)
  chatChannels: (personId: string, scope: ChatChannelsScope) =>
    ["as", personId, "chatChannels", scope] as const,
  chatChannel: (personId: string, id: string) => ["as", personId, "chatChannel", id] as const,
  chatMembers: (personId: string, channelId: string) =>
    ["as", personId, "chatMembers", channelId] as const,
  chatMessages: (personId: string, channelId: string, limit = CHAT_PAGE) =>
    ["as", personId, "chatMessages", channelId, limit] as const,
  chatMessage: (personId: string, id: string) => ["as", personId, "chatMessage", id] as const,
  chatThread: (personId: string, messageId: string) =>
    ["as", personId, "chatThread", messageId] as const,
  chatThreads: (personId: string) => ["as", personId, "chatThreads"] as const,
  chatMentions: (personId: string) => ["as", personId, "chatMentions"] as const,
  chatQuestions: (personId: string) => ["as", personId, "chatQuestions"] as const,
  chatClaudeQuestions: (personId: string) => ["as", personId, "chatClaudeQuestions"] as const,
  chatSignal: (personId: string) => ["as", personId, "chatSignal"] as const,
  // Docs (area 5): tutto nell'area «docs», che ogni scrittura dei Docs ricarica.
  docSpaces: (personId: string, projectId: string) =>
    ["as", personId, "docs", "spaces", projectId] as const,
  docSpace: (personId: string, repositoryId: string) =>
    ["as", personId, "docs", "space", repositoryId] as const,
  docTree: (personId: string, repositoryId: string) =>
    ["as", personId, "docs", "tree", repositoryId] as const,
  docPage: (personId: string, repositoryId: string, slug: string) =>
    ["as", personId, "docs", "page", repositoryId, slug] as const,
  docsHome: (personId: string, projectId: string) =>
    ["as", personId, "docs", "home", projectId] as const,
  docBrief: (personId: string, repositoryId: string) =>
    ["as", personId, "docs", "brief", repositoryId] as const,
  docSearch: (personId: string, q: string, repositoryId: string | null) =>
    ["as", personId, "docs", "search", q, repositoryId] as const,
  // Drive (area 5): tutto nell'area «drive», che ogni scrittura del Drive ricarica.
  driveFiles: (personId: string, filters: DriveFilters) =>
    ["as", personId, "drive", "files", filters] as const,
  driveFile: (personId: string, id: string) => ["as", personId, "drive", "file", id] as const,
  folderLinks: (personId: string, projectId: string) =>
    ["as", personId, "drive", "folders", projectId] as const,
  googleAccount: (personId: string) => ["as", personId, "drive", "google-account"] as const,
  myFolderLinks: (personId: string) => ["as", personId, "drive", "my-folders"] as const,
  driveReaders: (personId: string, projectId: string) =>
    ["as", personId, "drive", "readers", projectId] as const,
  driveSearch: (personId: string, q: string, scope: DriveSearchScope) =>
    ["as", personId, "drive", "search", q, scope] as const,
  googleFolders: (personId: string, projectId: string) =>
    ["as", personId, "drive", "google-folders", projectId] as const,
  googleFiles: (personId: string, projectId: string, q: string) =>
    ["as", personId, "drive", "google-files", projectId, q] as const,
  chatSearch: (personId: string, q: string, filters: ChatSearchFilters) =>
    ["as", personId, "chatSearch", q, filters] as const,
  // Posta (area 6): tutto nell'area «mail», che ogni scrittura della Posta ricarica.
  mailThreads: (personId: string, filters: MailThreadFilters) =>
    ["as", personId, "mail", "threads", filters] as const,
  mailThread: (personId: string, threadId: string) =>
    ["as", personId, "mail", "thread", threadId] as const,
  mailboxes: (personId: string) => ["as", personId, "mail", "mailboxes"] as const,
  importantMail: (personId: string) => ["as", personId, "mail", "important"] as const,
  mailSearch: (personId: string, q: string) => ["as", personId, "mail", "search", q] as const,
  mailProposals: (personId: string, filters: MailProposalFilters) =>
    ["as", personId, "mail", "proposals", filters] as const,
  mailProposal: (personId: string, id: string) => ["as", personId, "mail", "proposal", id] as const,
  mailDecisions: (personId: string) => ["as", personId, "mail", "decisions"] as const,
  mailDraft: (personId: string, threadId: string | null, mode: MailDraft["mode"]) =>
    ["as", personId, "mail", "draft", threadId, mode] as const,
  mailDrafts: (personId: string) => ["as", personId, "mail", "drafts"] as const,
  mailRecipients: (personId: string, q: string) =>
    ["as", personId, "mail", "recipients", q] as const,
  // Calendario (area 6): tutto nell'area «calendar».
  calendarEvents: (personId: string, range: { from: string; to: string }) =>
    ["as", personId, "calendar", "events", range] as const,
  calendarEvent: (personId: string, id: string) =>
    ["as", personId, "calendar", "event", id] as const,
  calendarSeries: (personId: string) => ["as", personId, "calendar", "series"] as const,
  calendars: (personId: string) => ["as", personId, "calendar", "calendars"] as const,
  freeBusy: (personId: string, personIds: readonly string[], from: string, to: string) =>
    ["as", personId, "calendar", "freeBusy", personIds, from, to] as const,
  upcomingEvents: (personId: string) => ["as", personId, "calendar", "upcoming"] as const,
  // Riunioni registrate e scheda di preparazione: area «meeting», che si
  // rilegge con le scritture di posta, calendario, task, richieste e traguardi.
  meetingPrep: (personId: string, eventId: string) =>
    ["as", personId, "meeting", "prep", eventId] as const,
  meetingSummary: (personId: string, eventId: string) =>
    ["as", personId, "meeting", "summary", eventId] as const,
  tasksBornFrom: (personId: string, eventId: string) =>
    ["as", personId, "meeting", "born", eventId] as const,
  // Automations (area 7): tutto nell'area «automations».
  automations: (personId: string, filter: AutomationListFilter) =>
    ["as", personId, "automations", "list", filter] as const,
  automation: (personId: string, id: string) =>
    ["as", personId, "automations", "detail", id] as const,
  automationRuns: (personId: string, filter: AutomationRunFilter) =>
    ["as", personId, "automations", "runs", filter] as const,
  automationRun: (personId: string, id: string) =>
    ["as", personId, "automations", "run", id] as const,
  automationSources: (personId: string) => ["as", personId, "automations", "sources"] as const,
  clientLinks: (personId: string) => ["as", personId, "automations", "clientLinks"] as const,
  automationApprovals: (personId: string) =>
    ["as", personId, "automations", "approvals"] as const,
  automationSearch: (personId: string, q: string) =>
    ["as", personId, "automations", "search", q] as const,
};

export type AutomationListFilter = Parameters<typeof api.automations.listAutomations>[0];
export type AutomationRunFilter = Parameters<typeof api.automations.listRuns>[0];

/** Quali canali: tutti (colonna, «Browse channels») o quelli di un progetto. */
export type ChatChannelsScope = { scope: "all" } | { scope: "project"; projectId: string };

/** Quanti messaggi del canale si leggono alla volta (spec: finestra di 50). */
const CHAT_PAGE = 50;

/** Chi sta guardando: la persona di tutte le chiavi. */
export function useSessionPersonId(): string {
  return useViewer().viewer.personId;
}

export function useDepartments() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.departments(me), queryFn: api.listDepartments });
}

export function usePeople() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.people(me), queryFn: api.listPeople });
}

export function useProjects() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.projects(me), queryFn: api.listProjects });
}

export function useProject(code: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.project(me, code),
    queryFn: () => api.getProjectByCode(code),
  });
}

/** I progetti fissati, nell'ordine in cui sono stati fissati. */
export function usePinnedProjects() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.pinned(me),
    queryFn: async () => {
      const [ids, projects] = await Promise.all([api.listPinnedProjectIds(), api.listProjects()]);
      return ids.flatMap((id) => projects.filter((p) => p.id === id));
    },
  });
}

const EMPTY = new Set<string>();

/**
 * I progetti che aspettano chi guarda (decisioni aperte rivolte a lui,
 * domande e piani di Claude per lui, richieste nuove dove può creare task).
 * Una sessione che arriva a una domanda lo accende da sola. Finché carica:
 * nessuno.
 */
export function useWaitingOnMe(): Set<string> {
  const me = useSessionPersonId();
  useConversationChanges();
  const { data } = useQuery({
    queryKey: queryKeys.waitingOnMe(me),
    queryFn: api.listWaitingOnMeProjectIds,
  });
  return useMemo(() => (data ? new Set(data) : EMPTY), [data]);
}

export function useProjectStatuses(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.statuses(me, projectId),
    queryFn: () => api.listProjectStatuses(projectId),
  });
}

/**
 * Gli stati di più progetti insieme (un insieme di task che li attraversa,
 * come un filtro salvato): `undefined` finché uno qualsiasi carica.
 */
export function useStatusesOf(projectIds: readonly string[]) {
  const me = useSessionPersonId();
  return useQueries({
    queries: projectIds.map((id) => ({
      queryKey: queryKeys.statuses(me, id),
      queryFn: () => api.listProjectStatuses(id),
    })),
    combine: (results) => ({
      data: results.every((r) => r.data)
        ? results.flatMap((r) => r.data as ProjectStatus[])
        : undefined,
      isError: results.some((r) => r.isError),
      refetch: () => Promise.all(results.map((r) => r.refetch())),
    }),
  });
}

export function useMilestones(projectId?: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.milestones(me, projectId),
    queryFn: () => api.listMilestones(projectId),
  });
}

/** `enabled: false` aspetta (es. l'id del progetto della pagina, non ancora letto). */
export function useTasks(
  criteria?: FilterCriteria,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.tasks(me, criteria),
    queryFn: () => api.listTasks(criteria),
    enabled,
  });
}

export function useTask(code: string) {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.task(me, code), queryFn: () => api.getTaskByCode(code) });
}

export function useActivity(taskId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.activity(me, taskId),
    queryFn: () => api.listActivity(taskId),
  });
}

export function useDecisionRequests(filter: {
  taskId?: string;
  askedOfId?: string;
  open?: boolean;
}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.decisions(me, filter),
    queryFn: () => api.listDecisionRequests(filter),
  });
}

export function useRequests(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.requests(me, projectId),
    queryFn: () => api.listRequests(projectId),
  });
}

/** Le richieste da trasformare dove chi guarda può creare task (tutti i progetti). */
export function useRequestsToConvert() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.requestsToConvert(me),
    queryFn: api.listRequestsToConvert,
  });
}

export function useRequest(id: string, { enabled = true }: { enabled?: boolean } = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.request(me, id),
    queryFn: () => api.getRequest(id),
    enabled,
  });
}

export function useSavedFilters() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.savedFilters(me), queryFn: api.listSavedFilters });
}

export function useSavedFilter(id: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.savedFilter(me, id),
    queryFn: () => api.getSavedFilter(id),
  });
}

export function useDepartmentHomes() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.departmentHomes(me), queryFn: api.listDepartmentHomes });
}

export function usePersonalHome() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.personalHome(me), queryFn: api.getPersonalHome });
}

/**
 * La Home di chi guarda, risolta (R-A1): i blocchi nell'ordine giusto e i
 * reparti la cui Home è cambiata dopo che l'ha vista. `personal` è la Home
 * personale grezza (`null` = usa quella del reparto).
 */
export function useHome() {
  const me = useSessionPersonId();
  const people = usePeople();
  const homes = useDepartmentHomes();
  const personal = usePersonalHome();
  const person = people.data?.find((p) => p.id === me);
  const data = useMemo(
    () =>
      person && homes.data && personal.data !== undefined
        ? {
            person,
            departmentHomes: homes.data,
            personal: personal.data,
            ...resolveHome(person, homes.data, personal.data),
          }
        : undefined,
    [person, homes.data, personal.data],
  );
  const parts = [people, homes, personal];
  return {
    data,
    isError: parts.some((q) => q.isError),
    refetch: () => Promise.all(parts.filter((q) => q.isError).map((q) => q.refetch())),
  };
}

export function useDepartmentRoles(personId?: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.departmentRoles(me, personId),
    queryFn: () => api.listDepartmentRoles(personId),
  });
}

export function useDayArrangements(week: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.dayArrangements(me, week),
    queryFn: () => api.listDayArrangements(week),
  });
}

export function useStalled(
  criteria?: FilterCriteria,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.stalled(me, criteria),
    queryFn: () => api.listStalled(criteria),
    enabled,
  });
}

export function useProjectPulse(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.pulse(me, projectId),
    queryFn: () => api.projectPulse(projectId),
  });
}

/** Il polso di ogni progetto visibile (il portafoglio). */
export function useProjectPulses() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.pulses(me), queryFn: api.listProjectPulses });
}

/** L'attività di tutti i progetti visibili, dalla più recente. */
export function usePortfolioActivity() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.portfolioActivity(me),
    queryFn: api.listPortfolioActivity,
  });
}

export function useTimeline(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.timeline(me, projectId),
    queryFn: () => api.listTimeline(projectId),
  });
}

export function useDecisionLog(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.decisionLog(me, projectId),
    queryFn: () => api.listDecisionLog(projectId),
  });
}

/** L'ultimo brief settimanale (`null` = non ce n'è ancora uno). */
export function useLatestBrief(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.latestBrief(me, projectId),
    queryFn: () => api.getLatestBrief(projectId),
  });
}

export function useNotifications() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.notifications(me), queryFn: api.listNotifications });
}

export function useSearch(q: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.search(me, q),
    queryFn: () => api.search(q),
    enabled: q.trim().length > 0,
    // Mentre arriva la ricerca nuova restano i risultati di prima — ma solo
    // della stessa persona: dopo un cambio di «vedi come» non si mostra nulla
    // di ciò che vedeva l'altra.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

// --- conversazioni con Claude ------------------------------------------------

/** Le aree delle conversazioni: elenchi e dettaglio. */
const CONVERSATION_AREAS = ["conversations", "conversation", "refineOf"] as const;
/** Claude che lavora su una task ne cambia lo stato: anche le aree delle task. */
const CONVERSATION_CHANGE_AREAS = [
  ...CONVERSATION_AREAS,
  "task",
  "tasks",
  "pulse",
  // Una proposta confermata cambia stato e persona degli oggetti citati.
  "citations",
  // Claude nel refine scrive design, piano e metadati della richiesta.
  "request",
  "requests",
  // Una domanda o un piano di Claude accende (o spegne) il punto «ti aspetta».
  "waitingOnMe",
  // Lo stato di una task si legge anche nella scheda di preparazione.
  "meeting",
] as const;

/** Quanto si aspetta per raccogliere più cambi in una sola rilettura (ms). */
const CHANGE_DEBOUNCE_MS = 50;

/** Un solo ascoltatore dei cambi per QueryClient, condiviso da tutti gli hook che ne hanno bisogno. */
const changeListeners = new Map<QueryClient, { users: number; stop: () => void }>();

function listenToConversationChanges(client: QueryClient): () => void {
  let entry = changeListeners.get(client);
  if (!entry) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.onConversationChange(() => {
      // Più cambi ravvicinati (uno stato, poi un patch) → una sola rilettura.
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void client.invalidateQueries(
          {
            predicate: (query) =>
              query.queryKey[0] === "as" &&
              (CONVERSATION_CHANGE_AREAS as readonly string[]).includes(
                query.queryKey[2] as string,
              ),
          },
          // Una rilettura già in corso non si butta: arriverebbe un cambio
          // dopo l'altro e nessuna lettura finirebbe mai. Non perde dati
          // perché ogni lettura legge lo store DOPO l'attesa di `gate`: una
          // rilettura partita prima del cambio lo vede comunque, se il cambio
          // arriva durante la sua latenza (il caso normale). Se mai una
          // lettura leggesse prima dell'attesa, questo andrebbe rivisto.
          { cancelRefetch: false },
        );
      }, CHANGE_DEBOUNCE_MS);
    });
    entry = {
      users: 0,
      stop: () => {
        clearTimeout(timer);
        off();
      },
    };
    changeListeners.set(client, entry);
  }
  const current = entry;
  current.users += 1;
  return () => {
    current.users -= 1;
    if (current.users === 0) {
      current.stop();
      changeListeners.delete(client);
    }
  };
}

/**
 * Tiene fresche le letture delle conversazioni: quando una cambia (stato,
 * risposta, decisione, proposta, titolo, visibilità — non a ogni pezzo dello
 * stream) le rilegge. Le chiavi sono per persona e le letture filtrano per
 * chi guarda, quindi una conversazione che non vede non compare. Un solo
 * ascoltatore per app, qualunque sia il numero di hook montati.
 */
function useConversationChanges(): void {
  const client = useQueryClient();
  useEffect(() => listenToConversationChanges(client), [client]);
}

export function useConversations(
  filter: ConversationFilter,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const me = useSessionPersonId();
  useConversationChanges();
  return useQuery({
    queryKey: queryKeys.conversations(me, filter),
    queryFn: () => api.listConversations(filter),
    enabled,
  });
}

/** Il dettaglio di una conversazione con i permessi di chi guarda; `null` se non la vede. */
export function useConversation(id: string) {
  const me = useSessionPersonId();
  useConversationChanges();
  return useQuery({
    queryKey: queryKeys.conversation(me, id),
    queryFn: () => api.getConversation(id),
  });
}

/** Il lavoro di Claude su una task (sessioni, PR); `null` se la task non si vede. */
export function useTaskWork(taskId: string) {
  const me = useSessionPersonId();
  useConversationChanges();
  return useQuery({
    queryKey: queryKeys.taskWork(me, taskId),
    queryFn: () => api.getTaskWork(taskId),
  });
}

export function useCommands(contextProjectId: string | null) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.commands(me, contextProjectId),
    queryFn: () => api.listCommands(contextProjectId),
  });
}

/** Gli oggetti citati come li legge chi guarda (invisibili: `visible: false`, senza nome). */
export function useCitations(refs: readonly CitationRef[]) {
  const me = useSessionPersonId();
  const key = refs.map((r) => `${r.kind}:${r.id}`).join("|");
  return useQuery({
    queryKey: queryKeys.citations(me, key),
    queryFn: () => api.resolveCitations([...refs]),
    enabled: refs.length > 0,
  });
}

/**
 * I codici scritti a mano in un testo che chi guarda vede (codice + nome);
 * uno nascosto e uno inesistente non tornano, nello stesso modo (R-G5).
 */
export function useCodeCitations(codes: readonly string[]) {
  const me = useSessionPersonId();
  const key = codes.join("|");
  return useQuery({
    queryKey: queryKeys.codeCitations(me, key),
    queryFn: () => api.resolveCodes([...codes]),
    enabled: codes.length > 0,
  });
}

/** I menu «#» e «@» della casella: cerca mentre si scrive, solo ciò che chi guarda vede. */
export function useMentionSearch(kind: "objects" | "people", q: string, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.mentions(me, kind, q),
    queryFn: () => api.searchMentions(q, kind),
    enabled,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

export function usePeopleActivity(date: string, departmentId?: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.peopleActivity(me, date, departmentId),
    queryFn: () => api.listPeopleActivity(date, departmentId),
  });
}

/** I report giornalieri di un giorno, per la rassegna (stesso permesso). */
export function useDailyReports(date: string, { enabled = true }: { enabled?: boolean } = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.dailyReports(me, date),
    queryFn: () => api.listDailyReports(date),
    enabled,
  });
}

/** Un report rigenerato cambia anche la cronologia dei progetti. */
export function useGenerateDailyReport() {
  return useWrite(
    ({ projectId, date }: { projectId: string; date: string }) =>
      api.generateDailyReport(projectId, date),
    ["dailyReports", "timeline"],
  );
}

/** Collegato l'autore, i suoi commit passano sotto la persona. */
export function useLinkCommitAuthor() {
  return useWrite(
    ({ authorName, personId }: { authorName: string; personId: string }) =>
      api.linkCommitAuthor(authorName, personId),
    ["peopleActivity"],
  );
}

export function useMarkNotification() {
  const client = useQueryClient();
  const me = useSessionPersonId();
  return useMutation({
    mutationFn: ({
      id,
      change,
    }: {
      id: string;
      change: { read?: boolean; archived?: boolean; snoozedUntil?: string | null };
    }) => api.markNotification(id, change),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.notifications(me) }),
  });
}

export function usePinnedFilters() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.pinnedFilters(me), queryFn: api.listPinnedFilterIds });
}

// --- mutazioni ---------------------------------------------------------------

/**
 * Le aree (il terzo elemento di `["as", persona, area, …]`) che una scrittura
 * può aver cambiato. Le mutazioni invalidano per area, non per chiave esatta:
 * una task cambiata sposta liste, board, ferme, polso e cronologia — e la
 * scheda di preparazione del Calendario («meeting»), che ne mostra lo stato.
 */
const TASK_AREAS = [
  "tasks",
  "task",
  "activity",
  "stalled",
  "pulse",
  "timeline",
  "dayArrangements",
  "waitingOnMe",
  "notifications",
  "decisions",
  "meeting",
] as const;
/**
 * Una richiesta convertita nasce come task: oltre alle richieste sposta liste,
 * ferme, polso, cronologia e attività del progetto.
 */
const REQUEST_AREAS = [
  "requests",
  "request",
  "waitingOnMe",
  "tasks",
  "task",
  "pulse",
  "stalled",
  "timeline",
  "activity",
  "meeting",
] as const;
const FILTER_AREAS = ["savedFilters", "savedFilter", "pinnedFilters"] as const;
const HOME_AREAS = ["personalHome", "departmentHomes"] as const;
const PROJECT_AREAS = [
  "projects",
  "project",
  "pinned",
  "statuses",
  "tasks",
  "task",
  "stalled",
  "pulse",
  // Chi è membro decide se c'è la scheda di preparazione.
  "meeting",
] as const;

const DECISION_AREAS = ["decisionLog", "timeline"] as const;
/** Un traguardo cambiato sposta avanzamenti, polso, cronologia e le task che lo portano. */
const MILESTONE_AREAS = ["milestones", "tasks", "task", "pulse", "timeline", "meeting"] as const;

/** Ricarica le aree indicate, ma solo di chi sta guardando. */
function useInvalidate(areas: readonly string[]) {
  const client = useQueryClient();
  const me = useSessionPersonId();
  return () =>
    client.invalidateQueries({
      predicate: (query) =>
        query.queryKey[0] === "as" &&
        query.queryKey[1] === me &&
        areas.includes(query.queryKey[2] as string),
    });
}

/** Una mutazione semplice: alla fine ricarica le aree che può aver toccato. */
function useWrite<TVars, TData>(
  mutationFn: (vars: TVars) => Promise<TData>,
  areas: readonly string[],
) {
  const invalidate = useInvalidate(areas);
  return useMutation({ mutationFn, onSettled: invalidate });
}

/**
 * Una mutazione ottimistica: `onMutate` applica subito `optimistic` alle
 * cache delle aree (dopo aver fermato le ricariche in corso e tenuto
 * un'istantanea), `onError` ripristina l'istantanea e `onSettled` ricarica
 * dal «server». Chi usa il hook legge `error` per dire all'utente che
 * l'azione è stata annullata.
 */
function useOptimistic<TVars, TData>(
  mutationFn: (vars: TVars) => Promise<TData>,
  areas: readonly string[],
  optimistic: (vars: TVars, area: string, old: unknown, key: readonly unknown[]) => unknown,
  settleAreas: readonly string[] = areas,
) {
  const client = useQueryClient();
  const me = useSessionPersonId();
  const invalidate = useInvalidate(settleAreas);
  const match = (area: string) => ({
    predicate: (q: { queryKey: readonly unknown[] }) =>
      q.queryKey[0] === "as" && q.queryKey[1] === me && q.queryKey[2] === area,
  });
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      const snapshots: [readonly unknown[], unknown][] = [];
      for (const area of areas) {
        await client.cancelQueries(match(area));
        for (const [key, old] of client.getQueriesData(match(area))) {
          if (old === undefined) continue;
          snapshots.push([key, old]);
          client.setQueryData(key, optimistic(vars, area, old, key));
        }
      }
      return { snapshots };
    },
    onError: (_error, _vars, context) => {
      for (const [key, old] of context?.snapshots ?? []) client.setQueryData(key, old);
    },
    onSettled: invalidate,
  });
}

/** Applica una `TaskPatch` alle task in cache: liste, ferme e singola. */
function patchTasks(ids: readonly string[], patch: TaskPatch, area: string, old: unknown) {
  const apply = (t: Task): Task => (ids.includes(t.id) ? { ...t, ...patch } : t);
  if (area === "tasks") return (old as Task[]).map(apply);
  if (area === "stalled") {
    return (old as { task: Task }[]).map((row) => ({ ...row, task: apply(row.task) }));
  }
  return old ? apply(old as Task) : old;
}

export function useCreateTask() {
  return useWrite(api.createTask, TASK_AREAS);
}

export function useUpdateTask() {
  return useOptimistic(
    ({ id, patch }: { id: string; patch: TaskPatch }) => api.updateTask(id, patch),
    ["tasks", "task", "stalled"],
    (vars, area, old) => patchTasks([vars.id], vars.patch, area, old),
    TASK_AREAS,
  );
}

export function useBulkUpdateTasks() {
  return useOptimistic(
    ({ ids, patch }: { ids: string[]; patch: TaskPatch }) => api.bulkUpdateTasks(ids, patch),
    ["tasks", "task", "stalled"],
    (vars, area, old) => patchTasks(vars.ids, vars.patch, area, old),
    TASK_AREAS,
  );
}

export function usePlanTask() {
  return useOptimistic(
    ({ id, ...plan }: { id: string; assigneeId: string | null; week: string | null }) =>
      api.planTask(id, plan),
    ["tasks", "task"],
    (vars, area, old) =>
      patchTasks([vars.id], { assigneeId: vars.assigneeId, plannedWeek: vars.week }, area, old),
    TASK_AREAS,
  );
}

export function useSetDay() {
  const me = useSessionPersonId();
  return useOptimistic(
    ({ taskId, week, day }: { taskId: string; week: string; day: DayArrangement["day"] }) =>
      api.setDay(taskId, week, day),
    ["dayArrangements"],
    (vars, _area, old, key) => {
      const rest = (old as DayArrangement[]).filter((a) => a.taskId !== vars.taskId);
      // La chiave è `["as", persona, "dayArrangements", settimana]`.
      return key[3] === vars.week
        ? [...rest, { personId: me, taskId: vars.taskId, week: vars.week, day: vars.day }]
        : old;
    },
  );
}

export function useAddComment() {
  return useWrite(
    ({ taskId, body, replyToId }: { taskId: string; body: string; replyToId?: string }) =>
      api.addComment(taskId, body, replyToId),
    // Un commento sposta l'ultima attività: può chiudere una ferma per inattività.
    TASK_AREAS,
  );
}

export function useEditComment() {
  return useWrite(
    ({ id, body }: { id: string; body: string }) => api.editComment(id, body),
    ["activity"],
  );
}

export function useDeleteComment() {
  return useWrite(api.deleteComment, ["activity"]);
}

export function useAskDecision() {
  return useWrite(api.askDecision, TASK_AREAS);
}

export function useAnswerDecision() {
  return useWrite(
    ({ id, answer }: { id: string; answer: { optionIndex: number } | { text: string } }) =>
      api.answerDecision(id, answer),
    TASK_AREAS,
  );
}

/**
 * Risponde SUBITO, senza passare dalla coda di `useMutation`: la chiamata
 * all'api parte in questo stesso istante, quindi legge la sessione di chi
 * risponde anche se subito dopo si cambia persona (la risposta tenuta per
 * l'«Undo» della Home parte così prima del cambio). Alla fine ricarica le
 * aree della persona che ha risposto.
 */
export function useAnswerDecisionNow() {
  const invalidate = useInvalidate(TASK_AREAS);
  return async (id: string, answer: { optionIndex: number } | { text: string }) => {
    // La chiamata parte prima del primo `await`: la sessione si legge ora.
    try {
      return await api.answerDecision(id, answer);
    } finally {
      // La voce resta nascosta finché le letture ricaricate non la tolgono.
      await invalidate();
    }
  };
}

export function useWithdrawDecision() {
  return useWrite(api.withdrawDecision, TASK_AREAS);
}

export function useCreateRequest() {
  return useWrite(api.createRequest, REQUEST_AREAS);
}

export function useUpdateRequest() {
  return useWrite(
    ({ id, patch }: { id: string; patch: Parameters<typeof api.updateRequest>[1] }) =>
      api.updateRequest(id, patch),
    REQUEST_AREAS,
  );
}

export function useMergeRequest() {
  return useWrite(
    ({ id, intoId }: { id: string; intoId: string }) => api.mergeRequest(id, intoId),
    REQUEST_AREAS,
  );
}

export function useArchiveRequest() {
  return useWrite(api.archiveRequest, REQUEST_AREAS);
}

export function useReopenRequest() {
  return useWrite(api.reopenRequest, REQUEST_AREAS);
}

export function useRestoreRequest() {
  return useWrite(
    ({ id, status }: { id: string; status: Parameters<typeof api.restoreRequest>[1] }) =>
      api.restoreRequest(id, status),
    REQUEST_AREAS,
  );
}

export function useConvertRequest() {
  return useWrite(
    ({ id, input }: { id: string; input: Parameters<typeof api.convertRequest>[1] }) =>
      api.convertRequest(id, input),
    REQUEST_AREAS,
  );
}

export function useSaveFilter() {
  return useWrite(api.saveFilter, FILTER_AREAS);
}

export function useUpdateFilter() {
  return useWrite(
    ({ id, patch }: { id: string; patch: Parameters<typeof api.updateFilter>[1] }) =>
      api.updateFilter(id, patch),
    FILTER_AREAS,
  );
}

export function useDeleteFilter() {
  return useWrite(api.deleteFilter, FILTER_AREAS);
}

export function useSetFilterPinned() {
  return useOptimistic(
    ({ filterId, pinned }: { filterId: string; pinned: boolean }) =>
      api.setFilterPinned(filterId, pinned),
    ["pinnedFilters"],
    (vars, _area, old) =>
      vars.pinned
        ? [...new Set([...(old as string[]), vars.filterId])]
        : (old as string[]).filter((id) => id !== vars.filterId),
  );
}

/**
 * Salva la Home personale. Ottimistica: se non c'era, quella nuova ha già
 * «visto» le Home dei reparti (come fa il server), così la riga «è
 * cambiata» non lampeggia mentre la scrittura è in volo.
 */
export function useSetPersonalHome() {
  const me = useSessionPersonId();
  const client = useQueryClient();
  return useOptimistic(
    (blocks: HomeBlockRef[]) => api.setPersonalHome(blocks),
    ["personalHome"],
    (blocks, _area, old): PersonalHome => {
      if (old) return { ...(old as PersonalHome), blocks };
      const person = client.getQueryData<Person[]>(queryKeys.people(me))?.find((p) => p.id === me);
      const seen: Record<string, string> = {};
      for (const h of client.getQueryData<DepartmentHome[]>(queryKeys.departmentHomes(me)) ?? []) {
        if (person?.departmentIds.includes(h.departmentId)) seen[h.departmentId] = h.updatedAt;
      }
      return { personId: me, blocks, seenDepartmentUpdates: seen };
    },
  );
}

export function useResetPersonalHome() {
  return useOptimistic(api.resetPersonalHome, ["personalHome"], () => null);
}

export function useSetDepartmentHome() {
  return useWrite(
    ({ departmentId, blocks }: { departmentId: string; blocks: HomeBlockRef[] }) =>
      api.setDepartmentHome(departmentId, blocks),
    HOME_AREAS,
  );
}

export function useMarkDepartmentHomeSeen() {
  return useWrite(api.markDepartmentHomeSeen, HOME_AREAS);
}

/**
 * Fissa o sgancia un progetto. Ottimistica: la tessera compare (o sparisce)
 * subito nel binario; su errore torna com'era e chi chiama lo dice.
 */
export function useSetPinned() {
  return useOptimistic(
    ({ project, pinned }: { project: Project; pinned: boolean }) =>
      api.setPinned(project.id, pinned),
    ["pinned"],
    ({ project, pinned }, _area, old) => {
      const rest = (old as Project[]).filter((p) => p.id !== project.id);
      return pinned ? [...rest, project] : rest;
    },
  );
}

export function useCreateProject() {
  return useWrite(api.createProject, PROJECT_AREAS);
}

export function useSetProjectStatuses() {
  return useWrite(
    ({
      projectId,
      statuses,
      reassign,
    }: {
      projectId: string;
      statuses: StatusInput[];
      reassign: Record<string, string>;
    }) => api.setProjectStatuses(projectId, statuses, reassign),
    // Un cambio di famiglia apre o chiude task: anche la cronologia cambia.
    [...PROJECT_AREAS, "timeline"],
  );
}

export function useRecordDecision() {
  return useWrite(
    ({ projectId, draft }: { projectId: string; draft: DecisionDraft }) =>
      api.recordDecision(projectId, draft),
    DECISION_AREAS,
  );
}

export function useSetDecisionSuperseded() {
  return useWrite(
    ({ id, supersededById }: { id: string; supersededById: string | null }) =>
      api.setDecisionSuperseded(id, supersededById),
    DECISION_AREAS,
  );
}

export function useCreateMilestone() {
  return useWrite(
    ({ projectId, input }: { projectId: string; input: MilestoneInput }) =>
      api.createMilestone(projectId, input),
    MILESTONE_AREAS,
  );
}

export function useUpdateMilestone() {
  return useWrite(
    ({ id, patch }: { id: string; patch: MilestonePatch }) => api.updateMilestone(id, patch),
    MILESTONE_AREAS,
  );
}

export function useDeleteMilestone() {
  return useWrite(api.deleteMilestone, MILESTONE_AREAS);
}

export function useSetStallThresholds() {
  return useWrite(
    ({ projectId, thresholds }: { projectId: string; thresholds: Project["stallThresholds"] }) =>
      api.setStallThresholds(projectId, thresholds),
    PROJECT_AREAS,
  );
}

// --- scritture delle conversazioni -------------------------------------------

/**
 * Una proposta confermata scrive task e richieste; una risposta o un piano il
 * registro. Task chiuse o spostate, commenti e richieste sono anche i fatti
 * della rassegna del giorno per persona: si rileggono anche quelli.
 */
const PROPOSAL_AREAS = [
  ...CONVERSATION_CHANGE_AREAS,
  ...TASK_AREAS,
  ...REQUEST_AREAS,
  ...DECISION_AREAS,
  "peopleActivity",
  "dailyReports",
] as const;
const DECIDE_AREAS = [...CONVERSATION_CHANGE_AREAS, ...DECISION_AREAS] as const;
const RUN_AREAS = [...CONVERSATION_CHANGE_AREAS, ...TASK_AREAS] as const;
const REFINE_AREAS = [...CONVERSATION_AREAS, ...REQUEST_AREAS] as const;

export function useCreateConversation() {
  return useWrite(
    (input: { contextProjectId?: string | null } = {}) => api.createConversation(input),
    CONVERSATION_AREAS,
  );
}

export function useSendMessage() {
  return useWrite(
    ({ id, text, attachments }: { id: string; text: string; attachments?: Attachment[] }) =>
      api.sendMessage(id, { text, ...(attachments ? { attachments } : {}) }),
    CONVERSATION_CHANGE_AREAS,
  );
}

export function useStopConversation() {
  return useWrite(api.stop, CONVERSATION_CHANGE_AREAS);
}

export function useStopAndSend() {
  return useWrite(
    ({ id, text }: { id: string; text: string }) => api.stopAndSend(id, text),
    CONVERSATION_CHANGE_AREAS,
  );
}

export function useAnswerQuestion() {
  return useWrite(
    ({
      id,
      questionId,
      answer,
    }: {
      id: string;
      questionId: string;
      answer: { optionIndex: number | null; text: string | null };
    }) => api.answerQuestion(id, questionId, answer),
    DECIDE_AREAS,
  );
}

export function useDecidePlan() {
  return useWrite(
    ({
      id,
      decision,
      instructions,
      planId,
    }: {
      id: string;
      decision: "approve" | "reject";
      instructions?: string;
      /** Il piano letto da chi decide: un piano diverso in attesa non si decide al buio. */
      planId?: string;
    }) => api.decidePlan(id, decision, instructions, planId),
    DECIDE_AREAS,
  );
}

/**
 * Le domande e i piani di Claude che aspettano chi guarda («Decide» della
 * Home). Freschi come le conversazioni: una risposta data altrove li toglie.
 */
export function useClaudeDecisions() {
  const me = useSessionPersonId();
  useConversationChanges();
  return useQuery({
    queryKey: queryKeys.claudeDecisions(me),
    queryFn: api.listClaudeDecisions,
  });
}

/**
 * Rispondere a una domanda di Claude ADESSO, senza `useMutation`, come
 * `useAnswerDecisionNow`: la chiamata parte in questo istante (la sessione
 * è di chi risponde anche se subito dopo si cambia persona), e alla fine
 * ricarica le aree di chi ha risposto. Per l'«Undo» di «Decide».
 */
export function useAnswerQuestionNow() {
  const invalidate = useInvalidate(DECIDE_AREAS);
  return async (
    id: string,
    questionId: string,
    answer: { optionIndex: number | null; text: string | null },
  ) => {
    try {
      return await api.answerQuestion(id, questionId, answer);
    } finally {
      await invalidate();
    }
  };
}

/**
 * Decidere un piano ADESSO (vedi `useAnswerQuestionNow`), sul piano letto
 * (`planId`): tenuta per l'«Undo», la decisione non cade su un piano
 * riscritto nel frattempo.
 */
export function useDecidePlanNow() {
  const invalidate = useInvalidate(DECIDE_AREAS);
  return async (
    id: string,
    planId: string,
    decision: "approve" | "reject",
    instructions?: string,
  ) => {
    try {
      return await api.decidePlan(id, decision, instructions, planId);
    } finally {
      await invalidate();
    }
  };
}

export function usePreApprovePlan() {
  return useWrite(api.preApprovePlan, CONVERSATION_AREAS);
}

export function useRevokePlanApproval() {
  return useWrite(api.revokePlanApproval, CONVERSATION_AREAS);
}

export function useConfirmProposal() {
  return useWrite(
    ({
      id,
      proposalId,
      actionIndexes,
    }: {
      id: string;
      proposalId: string;
      actionIndexes?: number[];
    }) => api.confirmProposal(id, proposalId, actionIndexes ? { actionIndexes } : {}),
    PROPOSAL_AREAS,
  );
}

/** «Modifica» salvata dal dialogo: la proposta si chiude «Done (edited)» con i codici nati. */
export function useCompleteEditedProposal() {
  return useWrite(
    ({ id, proposalId, resultCodes }: { id: string; proposalId: string; resultCodes: string[] }) =>
      api.completeEditedProposal(id, proposalId, resultCodes),
    PROPOSAL_AREAS,
  );
}

/** Il contesto di progetto di una conversazione libera (decide le skill di «/»). */
export function useSetConversationContext() {
  return useWrite(
    ({ id, projectId }: { id: string; projectId: string | null }) =>
      api.setConversationContext(id, projectId),
    CONVERSATION_AREAS,
  );
}

export function useCancelProposal() {
  return useWrite(
    ({ id, proposalId }: { id: string; proposalId: string }) => api.cancelProposal(id, proposalId),
    CONVERSATION_AREAS,
  );
}

/** «Modifica»: gli argomenti per aprire il dialogo dell'azione; non scrive nulla. */
export function useEditProposal() {
  return useMutation({
    mutationFn: ({
      id,
      proposalId,
      actionIndex,
    }: {
      id: string;
      proposalId: string;
      actionIndex?: number;
    }) => api.editProposal(id, proposalId, actionIndex),
  });
}

export function useSetVisibility() {
  return useWrite(
    ({
      id,
      visibility,
      confirmedProjectIds,
    }: {
      id: string;
      visibility: "public" | "private";
      confirmedProjectIds?: string[];
    }) => api.setVisibility(id, visibility, confirmedProjectIds ? { confirmedProjectIds } : {}),
    CONVERSATION_AREAS,
  );
}

export function useContinueConversation() {
  return useWrite(api.continueConversation, CONVERSATION_AREAS);
}

export function useRenameConversation() {
  return useWrite(
    ({ id, title }: { id: string; title: string }) => api.renameConversation(id, title),
    CONVERSATION_AREAS,
  );
}

export function useArchiveConversation() {
  return useWrite(
    ({ id, archived }: { id: string; archived?: boolean }) => api.archiveConversation(id, archived),
    CONVERSATION_AREAS,
  );
}

export function useDeleteConversation() {
  return useWrite(api.deleteConversation, CONVERSATION_AREAS);
}

export function useStartRun() {
  return useWrite(api.startRun, RUN_AREAS);
}

export function useRelaunchWithInstructions() {
  return useWrite(
    ({ taskId, instructions }: { taskId: string; instructions: string }) =>
      api.relaunchWithInstructions(taskId, instructions),
    RUN_AREAS,
  );
}

export function useResumeCorrection() {
  return useWrite(api.resumeCorrection, RUN_AREAS);
}

export function useRequestChanges() {
  return useWrite(
    ({ taskId, text }: { taskId: string; text: string }) => api.requestChanges(taskId, text),
    RUN_AREAS,
  );
}

export function useStartRefineConversation() {
  return useWrite(api.startRefineConversation, REFINE_AREAS);
}

export function useCloseRefine() {
  return useWrite(api.closeRefine, REFINE_AREAS);
}

/** Il refine di una richiesta (vivo, se no l'ultimo chiuso); `null` se non c'è o non si vede. */
export function useRefineOf(requestId: string) {
  const me = useSessionPersonId();
  useConversationChanges();
  return useQuery({
    queryKey: queryKeys.refineOf(me, requestId),
    queryFn: () => api.getRefineOf(requestId),
  });
}

/**
 * Applica subito alla richiesta in cache ciò che una riga del refine dice di
 * aver scritto: il lato cambia nello stesso istante della riga, e la
 * rilettura che segue (cambio della conversazione) conferma dallo store.
 */
export function usePatchRequestCache() {
  const client = useQueryClient();
  const me = useSessionPersonId();
  return useCallback(
    (id: string, patch: RefinePatch) =>
      client.setQueryData<ProjectRequest | null>(queryKeys.request(me, id), (old) =>
        old ? { ...old, ...patch } : old,
      ),
    [client, me],
  );
}

// --- stream delle conversazioni ---------------------------------------------

export interface ConversationStream {
  events: ConversationEvent[];
  connection: api.StreamConnection;
  /** `not_found`: la conversazione non esiste o chi guarda non la vede. */
  error: string | null;
}

const EMPTY_STREAM: ConversationStream = { events: [], connection: "live", error: null };

/**
 * Il flusso di una conversazione, dal vivo. È della persona che guarda:
 * cambiando persona (o conversazione) la vecchia iscrizione si chiude e
 * nessun suo evento resta a schermo. Se la connessione cade mostra
 * `reconnecting` e riprende dall'ultimo evento ricevuto, senza doppi.
 */
export function useConversationStream(
  id: string,
  { passive = false }: { passive?: boolean } = {},
): ConversationStream {
  const me = useSessionPersonId();
  const key = `${me}\u0000${id}`;
  const [stream, setStream] = useState<ConversationStream & { key: string }>({
    ...EMPTY_STREAM,
    key,
  });

  useEffect(() => {
    let events: ConversationEvent[] = [];
    let unsubscribe: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const publish = (connection: api.StreamConnection, error: string | null = null) => {
      if (active) setStream({ key, events, connection, error });
    };
    const connect = () => {
      try {
        unsubscribe = api.subscribe(
          id,
          (event) => {
            events = api.mergeStreamEvent(events, event);
            publish("live");
          },
          {
            ...(events.length > 0 ? { afterEventId: events.at(-1)!.id } : {}),
            passive,
            onConnection: (connection) => {
              unsubscribe = null;
              publish(connection);
              if (connection === "reconnecting") retry = setTimeout(connect, api.reconnectDelay());
            },
          },
        );
        publish("live");
      } catch (error) {
        publish("closed", error instanceof Error ? error.message : String(error));
      }
    };
    connect();
    return () => {
      active = false;
      clearTimeout(retry);
      unsubscribe?.();
    };
  }, [key, id, passive]);

  if (stream.key !== key) return EMPTY_STREAM;
  return { events: stream.events, connection: stream.connection, error: stream.error };
}

// --- Chat (area 4) -------------------------------------------------------------

/**
 * Le aree della Chat che un messaggio nuovo o cambiato (dal vivo) può
 * spostare: conteggi della colonna, Threads, Menzioni, domande, notifiche.
 * Il flusso del canale e del thread aperti li porta lo stream
 * (`useChannelStream`, `useThreadStream`), non una rilettura.
 */
const CHAT_LIVE_AREAS = [
  "chatChannels",
  "chatChannel",
  "chatMembers",
  "chatThreads",
  "chatMentions",
  "chatQuestions",
  "chatClaudeQuestions",
  "chatSignal",
  "chatMessage",
  "notifications",
] as const;
/** Una scrittura della Chat: le aree dal vivo più i flussi letti a pagine e la ricerca. */
const CHAT_AREAS = [...CHAT_LIVE_AREAS, "chatMessages", "chatThread", "chatSearch"] as const;
/** «Create task/request» da un messaggio: la Chat e le aree delle task e delle richieste. */
const CHAT_CREATE_AREAS = [...CHAT_AREAS, ...TASK_AREAS, ...REQUEST_AREAS] as const;

const chatListeners = new Map<QueryClient, { users: number; stop: () => void }>();

function listenToChatChanges(client: QueryClient): () => void {
  let entry = chatListeners.get(client);
  if (!entry) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.chat.onChatChange(() => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void client.invalidateQueries(
          {
            predicate: (query) =>
              query.queryKey[0] === "as" &&
              (CHAT_LIVE_AREAS as readonly string[]).includes(query.queryKey[2] as string),
          },
          { cancelRefetch: false },
        );
      }, CHANGE_DEBOUNCE_MS);
    });
    entry = {
      users: 0,
      stop: () => {
        clearTimeout(timer);
        off();
      },
    };
    chatListeners.set(client, entry);
  }
  const current = entry;
  current.users += 1;
  return () => {
    current.users -= 1;
    if (current.users === 0) {
      current.stop();
      chatListeners.delete(client);
    }
  };
}

/**
 * Tiene fresche le letture della Chat quando qualcosa cambia dal vivo (un
 * messaggio di un'altra persona, un evento di progetto): le rilegge per chi
 * guarda. Un solo ascoltatore per app.
 */
function useChatChanges(): void {
  const client = useQueryClient();
  useEffect(() => listenToChatChanges(client), [client]);
}

export function useChatChannels(
  scope: ChatChannelsScope = { scope: "all" },
  { enabled = true }: { enabled?: boolean } = {},
) {
  const me = useSessionPersonId();
  useChatChanges();
  return useQuery({
    queryKey: queryKeys.chatChannels(me, scope),
    queryFn: () => api.chat.listChannels(scope),
    enabled,
  });
}

/** Un canale con i permessi di chi guarda; `null` se non lo vede. */
export function useChatChannel(id: string) {
  const me = useSessionPersonId();
  useChatChanges();
  return useQuery({
    queryKey: queryKeys.chatChannel(me, id),
    queryFn: () => api.chat.getChannel(id),
  });
}

export function useChannelMembers(channelId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.chatMembers(me, channelId),
    queryFn: () => api.chat.listChannelMembers(channelId),
  });
}

/**
 * Gli ultimi `limit` messaggi del flusso del canale; `null` se chi guarda
 * non ne legge i messaggi. I nuovi arrivano da `useChannelStream`.
 */
export function useChannelMessages(channelId: string, limit = CHAT_PAGE) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.chatMessages(me, channelId, limit),
    queryFn: () => api.chat.listMessages(channelId, { limit }),
  });
}

/** Un messaggio (link, anteprima, salto); `null` se non lo legge o non c'è più. */
export function useChatMessage(id: string, { enabled = true }: { enabled?: boolean } = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.chatMessage(me, id),
    queryFn: () => api.chat.getMessage(id),
    enabled,
  });
}

export function useChatThread(messageId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.chatThread(me, messageId),
    queryFn: () => api.chat.listThread(messageId),
    enabled,
  });
}

export function useThreadsWithNews() {
  const me = useSessionPersonId();
  useChatChanges();
  return useQuery({ queryKey: queryKeys.chatThreads(me), queryFn: api.chat.listThreadsWithNews });
}

export function useChatMentions() {
  const me = useSessionPersonId();
  useChatChanges();
  return useQuery({ queryKey: queryKeys.chatMentions(me), queryFn: api.chat.listMentions });
}

/** Le domande della Chat rivolte a chi guarda, per «Da decidere». */
export function useChatQuestions() {
  const me = useSessionPersonId();
  useChatChanges();
  return useQuery({ queryKey: queryKeys.chatQuestions(me), queryFn: api.chat.listQuestions });
}

/**
 * Il punto della Chat sul binario: menzioni dirette, DM non letti, thread
 * seguiti con risposte nuove (mai il traffico normale dei canali).
 */
export function useChatSignal() {
  const me = useSessionPersonId();
  useChatChanges();
  return useQuery({ queryKey: queryKeys.chatSignal(me), queryFn: api.chat.hasNews });
}

/** Ignora una domanda della Chat ADESSO (vedi `useAnswerDecisionNow`): per l'«Undo» di «Decide». */
export function useDismissChatQuestionNow() {
  const invalidate = useInvalidate(CHAT_LIVE_AREAS);
  return async (messageId: string) => {
    try {
      return await api.chat.dismissQuestion(messageId);
    } finally {
      await invalidate();
    }
  };
}

/** Risponde ADESSO alla domanda di @Claude da «Decide» (vedi `useAnswerQuestionNow`). */
export function useAnswerChatClaudeQuestionNow() {
  const invalidate = useInvalidate([...CHAT_AREAS, ...DECIDE_AREAS]);
  return async (
    messageId: string,
    questionId: string,
    answer: { optionIndex: number | null; text: string | null },
  ) => {
    try {
      return await api.chat.answerChatClaudeQuestion(messageId, questionId, answer);
    } finally {
      await invalidate();
    }
  };
}

export function useChatSearch(q: string, filters: ChatSearchFilters = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.chatSearch(me, q, filters),
    queryFn: () => api.chat.searchChat(q, filters),
    enabled: q.trim().length >= 2,
    // Come la ricerca: i risultati di prima restano solo per la stessa persona.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

/**
 * Rilegge un messaggio al momento del salto (ricerca, palette): `null` se
 * chi guarda non lo legge più o è stato eliminato nel frattempo.
 */
export function useReachChatMessage() {
  const me = useSessionPersonId();
  const client = useQueryClient();
  return useCallback(
    async (id: string) => {
      const found = await client.fetchQuery({
        queryKey: queryKeys.chatMessage(me, id),
        queryFn: () => api.chat.getMessage(id),
        staleTime: 0,
      });
      return found && found.message.deletedAt === null ? found : null;
    },
    [client, me],
  );
}

export function useSendChatMessage() {
  return useWrite(
    ({ channelId, input }: { channelId: string; input: ChatMessageInput }) =>
      api.chat.sendMessage(channelId, input),
    CHAT_AREAS,
  );
}

export function useEditChatMessage() {
  return useWrite(
    ({ id, text }: { id: string; text: string }) => api.chat.editMessage(id, text),
    CHAT_AREAS,
  );
}

export function useDeleteChatMessage() {
  return useWrite(api.chat.deleteMessage, CHAT_AREAS);
}

export function useToggleReaction() {
  return useWrite(
    ({ id, emoji }: { id: string; emoji: string }) => api.chat.toggleReaction(id, emoji),
    CHAT_AREAS,
  );
}

export function useMarkChannelRead() {
  return useWrite(
    ({ channelId, at }: { channelId: string; at?: string }) => api.chat.markRead(channelId, at),
    CHAT_LIVE_AREAS,
  );
}

export function useMarkThreadRead() {
  return useWrite(
    ({ rootId, at }: { rootId: string; at?: string }) => api.chat.markThreadRead(rootId, at),
    [...CHAT_LIVE_AREAS, "chatThread", "chatMessages"],
  );
}

export function useSetThreadFollow() {
  return useWrite(
    ({ rootId, following }: { rootId: string; following: boolean }) =>
      api.chat.setThreadFollow(rootId, following),
    CHAT_AREAS,
  );
}

export function useSetNotifyLevel() {
  return useWrite(
    ({ channelId, level }: { channelId: string; level: NotifyLevel }) =>
      api.chat.setNotifyLevel(channelId, level),
    CHAT_LIVE_AREAS,
  );
}

export function useDismissChatQuestion() {
  return useWrite(api.chat.dismissQuestion, CHAT_LIVE_AREAS);
}

export function useJoinChannel() {
  return useWrite(api.chat.joinChannel, CHAT_AREAS);
}

export function useLeaveChannel() {
  return useWrite(api.chat.leaveChannel, CHAT_AREAS);
}

export function useCreateChannel() {
  return useWrite((input: NewChannelInput) => api.chat.createChannel(input), CHAT_AREAS);
}

export function useUpdateChannel() {
  return useWrite(
    ({ id, patch }: { id: string; patch: ChannelPatch }) => api.chat.updateChannel(id, patch),
    CHAT_AREAS,
  );
}

export function useSetPublishedEvents() {
  return useWrite(
    ({ id, events }: { id: string; events: ChatEventKind[] }) =>
      api.chat.setPublishedEvents(id, events),
    CHAT_AREAS,
  );
}

export function useArchiveChannel() {
  return useWrite(
    ({ id, archived }: { id: string; archived?: boolean }) => api.chat.archiveChannel(id, archived),
    CHAT_AREAS,
  );
}

export function useDeleteChannel() {
  return useWrite(api.chat.deleteChannel, CHAT_AREAS);
}

export function useInviteMembers() {
  return useWrite(
    ({ id, personIds }: { id: string; personIds: string[] }) =>
      api.chat.inviteMembers(id, personIds),
    CHAT_AREAS,
  );
}

export function useRemoveMember() {
  return useWrite(
    ({ id, personId }: { id: string; personId: string }) => api.chat.removeMember(id, personId),
    CHAT_AREAS,
  );
}

export function useOpenDm() {
  return useWrite(api.chat.openDm, CHAT_AREAS);
}

export function useCreateTaskFromMessage() {
  return useWrite(
    ({ messageId, input }: { messageId: string; input: NewTaskInput }) =>
      api.chat.createTaskFromMessage(messageId, input),
    CHAT_CREATE_AREAS,
  );
}

export function useCreateRequestFromMessage() {
  return useWrite(
    ({ messageId, input }: { messageId: string; input: api.NewRequestInput }) =>
      api.chat.createRequestFromMessage(messageId, input),
    CHAT_CREATE_AREAS,
  );
}

// --- @Claude nei thread: fermare, rifare, la domanda, le proposte (R-G1, R-G4) ---

/** Le domande di @Claude a chi guarda, nei thread in cui l'ha chiamato (per «Da decidere»). */
export function useChatClaudeQuestions() {
  const me = useSessionPersonId();
  useChatChanges();
  return useQuery({
    queryKey: queryKeys.chatClaudeQuestions(me),
    queryFn: api.chat.listClaudeQuestions,
  });
}

export function useStopClaudeReply() {
  return useWrite(api.chat.stopClaudeReply, CHAT_AREAS);
}

export function useRetryClaudeReply() {
  return useWrite(api.chat.retryClaudeReply, CHAT_AREAS);
}

/** Risponde alla domanda di @Claude (solo chi l'ha chiamato): la risposta continua. */
export function useAnswerChatClaudeQuestion() {
  return useWrite(
    ({
      messageId,
      questionId,
      answer,
    }: {
      messageId: string;
      questionId: string;
      answer: { optionIndex: number | null; text: string | null };
    }) => api.chat.answerChatClaudeQuestion(messageId, questionId, answer),
    [...CHAT_AREAS, ...DECIDE_AREAS],
  );
}

/** Le proposte di una risposta di @Claude: le stesse aree della conversazione, più la Chat. */
const CHAT_PROPOSAL_AREAS = [...PROPOSAL_AREAS, ...CHAT_AREAS] as const;

export function useConfirmChatProposal() {
  return useWrite(
    ({
      messageId,
      proposalId,
      actionIndexes,
    }: {
      messageId: string;
      proposalId: string;
      actionIndexes?: number[];
    }) =>
      api.chat.confirmChatProposal(messageId, proposalId, actionIndexes ? { actionIndexes } : {}),
    CHAT_PROPOSAL_AREAS,
  );
}

export function useCancelChatProposal() {
  return useWrite(
    ({ messageId, proposalId }: { messageId: string; proposalId: string }) =>
      api.chat.cancelChatProposal(messageId, proposalId),
    CHAT_AREAS,
  );
}

/** «Modifica»: gli argomenti per aprire il dialogo dell'azione; non scrive nulla. */
export function useEditChatProposal() {
  return useMutation({
    mutationFn: ({ messageId, proposalId }: { messageId: string; proposalId: string }) =>
      api.chat.editChatProposal(messageId, proposalId),
  });
}

export function useCompleteEditedChatProposal() {
  return useWrite(
    ({
      messageId,
      proposalId,
      resultCodes,
    }: {
      messageId: string;
      proposalId: string;
      resultCodes: string[];
    }) => api.chat.completeEditedChatProposal(messageId, proposalId, resultCodes),
    CHAT_PROPOSAL_AREAS,
  );
}

export interface ChatStream {
  /** I messaggi arrivati (o cambiati) dal vivo dopo l'iscrizione, per id: da unire alla pagina letta. */
  messages: ChatMessageView[];
  /** `not_found`: il canale (o il thread) non esiste o chi guarda non lo legge; `closed`: non lo legge più. */
  error: string | null;
}

const EMPTY_CHAT_STREAM: ChatStream = { messages: [], error: null };

/**
 * Unisce un messaggio dello stream all'elenco: un id già presente si
 * sostituisce (modifica, reazione, eliminazione, riassunto del thread), uno
 * nuovo va in fondo. Mai doppi. Serve anche per unire lo stream alla pagina.
 */
export function mergeChatMessage(
  messages: readonly ChatMessageView[],
  message: ChatMessageView,
): ChatMessageView[] {
  const index = messages.findIndex((m) => m.id === message.id);
  if (index === -1) return [...messages, message];
  const next = messages.slice();
  next[index] = message;
  return next;
}

/** Iscrive chi guarda a un flusso della Chat, finché la persona e l'id restano gli stessi. */
function useChatStream(streamId: api.chat.ChatStreamId): ChatStream {
  const me = useSessionPersonId();
  const key = `${me}\u0000${streamId}`;
  const [stream, setStream] = useState<ChatStream & { key: string }>({
    ...EMPTY_CHAT_STREAM,
    key,
  });
  useEffect(() => {
    let messages: ChatMessageView[] = [];
    let active = true;
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = api.chat.subscribeChat(
        streamId,
        (message) => {
          messages = mergeChatMessage(messages, message);
          if (active) setStream({ key, messages, error: null });
        },
        {
          onConnection: () => {
            unsubscribe = null;
            if (active) setStream({ key, messages: [], error: "closed" });
          },
        },
      );
      setStream({ key, messages, error: null });
    } catch (error) {
      setStream({ key, messages, error: error instanceof Error ? error.message : String(error) });
    }
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [key, streamId]);
  if (stream.key !== key) return EMPTY_CHAT_STREAM;
  return { messages: stream.messages, error: stream.error };
}

/**
 * I messaggi del canale che arrivano o cambiano dal vivo (radici, risposte
 * «anche nel canale», riassunti dei thread): la pagina letta con
 * `useChannelMessages` li unisce con `mergeChatMessage`. Cambiando persona o
 * canale la vecchia iscrizione si chiude e nulla resta a schermo.
 */
export function useChannelStream(channelId: string): ChatStream {
  return useChatStream(api.chat.channelStream(channelId));
}

/** Le risposte (e la radice aggiornata) di un thread, dal vivo. */
export function useThreadStream(rootId: string): ChatStream {
  return useChatStream(api.chat.threadStream(rootId));
}

// --- Docs (area 5) -------------------------------------------------------------

/** Le scritture dei Docs ricaricano i Docs; una pagina tolta o cambiata anche citazioni e «#». */
const DOCS_AREAS = ["docs"] as const;
const DOCS_PAGE_AREAS = ["docs", "citations", "codeCitations", "mentions"] as const;

/** Mentre una generazione o un grafo è in coda o in corso la lettura si ripete da sola (come il web). */
const DOCS_REFRESH_MS = 1000;
const LIVE_STATUSES: readonly string[] = ["queued", "running"];
const inFlight = (s: { generation: DocGeneration; graph: GraphState } | null | undefined) =>
  !!s && (LIVE_STATUSES.includes(s.generation.status) || LIVE_STATUSES.includes(s.graph.status));

/**
 * Quando una generazione o un grafo finisce (in corso → non più) le pagine
 * sono cambiate (commit, avviso di pagina vecchia, albero): si ricarica
 * tutta l'area Docs, anche ciò che non si ripeteva da solo. Il cambio di
 * persona riparte da capo (nessun «prima» della persona precedente).
 */
function useDocsSettled(live: boolean) {
  const me = useSessionPersonId();
  const invalidate = useInvalidate(DOCS_PAGE_AREAS);
  const was = useRef({ me, live });
  useEffect(() => {
    const before = was.current;
    was.current = { me, live };
    if (before.me === me && before.live && !live) void invalidate();
  });
}

export function useDocSpaces(projectId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const me = useSessionPersonId();
  const query = useQuery({
    queryKey: queryKeys.docSpaces(me, projectId),
    queryFn: () => api.docs.listDocSpaces(projectId),
    enabled,
    refetchInterval: (query) => (query.state.data?.some(inFlight) ? DOCS_REFRESH_MS : false),
  });
  useDocsSettled(!!query.data?.some(inFlight));
  return query;
}

export function useDocSpace(repositoryId: string) {
  const me = useSessionPersonId();
  const query = useQuery({
    queryKey: queryKeys.docSpace(me, repositoryId),
    queryFn: () => api.docs.getDocSpace(repositoryId),
    refetchInterval: (query) => (inFlight(query.state.data) ? DOCS_REFRESH_MS : false),
  });
  useDocsSettled(inFlight(query.data));
  return query;
}

export function useDocTree(repositoryId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.docTree(me, repositoryId),
    queryFn: () => api.docs.listDocTree(repositoryId),
  });
}

export function useDocPage(repositoryId: string, slug: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.docPage(me, repositoryId, slug),
    queryFn: () => api.docs.getDocPage(repositoryId, slug),
  });
}

export function useProjectDocsHome(projectId: string) {
  const me = useSessionPersonId();
  const query = useQuery({
    queryKey: queryKeys.docsHome(me, projectId),
    queryFn: () => api.docs.getProjectDocsHome(projectId),
    refetchInterval: (query) => (query.state.data?.spaces.some(inFlight) ? DOCS_REFRESH_MS : false),
  });
  useDocsSettled(!!query.data?.spaces.some(inFlight));
  return query;
}

/** La ricerca nei Docs (⌘K); con `repositoryId` solo in quello spazio. */
export function useDocSearch(q: string, repositoryId: string | null, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.docSearch(me, q, repositoryId),
    queryFn: () => api.docs.searchDocs(q, repositoryId ? { repositoryId } : {}),
    enabled: enabled && q.trim().length > 0,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

export function useCreateManualPage() {
  return useWrite(
    ({ repositoryId, input }: { repositoryId: string; input: ManualPageInput }) =>
      api.docs.createManualPage(repositoryId, input),
    DOCS_PAGE_AREAS,
  );
}

export function useUpdateManualPage() {
  return useWrite(
    ({ id, patch }: { id: string; patch: Partial<ManualPageInput> }) =>
      api.docs.updateManualPage(id, patch),
    DOCS_PAGE_AREAS,
  );
}

export function useDeleteManualPage() {
  return useWrite((id: string) => api.docs.deleteManualPage(id), DOCS_PAGE_AREAS);
}

export function useStartGeneration() {
  return useWrite((repositoryId: string) => api.docs.startGeneration(repositoryId), DOCS_AREAS);
}

export function useResumeGeneration() {
  return useWrite((repositoryId: string) => api.docs.resumeGeneration(repositoryId), DOCS_AREAS);
}

export function useGraphAction() {
  return useWrite(
    ({ repositoryId, kind }: { repositoryId: string; kind: GraphActionKind }) =>
      api.docs.graphAction(repositoryId, kind),
    DOCS_AREAS,
  );
}

/** Il brief di un repository (la sua vista nello spazio). */
export function useRepoBrief(repositoryId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.docBrief(me, repositoryId),
    queryFn: () => api.docs.getRepoBrief(repositoryId),
  });
}

/** Una domanda alla chat dei Docs: legge e basta, quindi non ricarica nulla. */
export function useAskDocs() {
  return useMutation({ mutationFn: (q: DocsQuestion) => api.docs.askDocs(q) });
}

/** Una visita alla pagina («più lette»). */
export function useRecordDocView() {
  return useWrite((pageId: string) => api.docs.recordDocView(pageId), DOCS_AREAS);
}

// --- Drive (area 5) ------------------------------------------------------------

/**
 * Le scritture del Drive ricaricano il Drive; quelle che tolgono, nascondono o
 * aggiungono un file anche citazioni, codici e «#» (un file che sparisce deve
 * sparire anche lì, R-G5).
 */
const DRIVE_AREAS = ["drive"] as const;
const DRIVE_FILE_AREAS = ["drive", "citations", "codeCitations", "mentions"] as const;

/** Mentre un file è in elaborazione la lettura si ripete da sola, finché non è pronto. */
const DRIVE_REFRESH_MS = 1000;
const reading = (rows: readonly Pick<DriveFileRow, "content">[] | null | undefined) =>
  !!rows?.some((r) => r.content === "processing");

/** Il Drive: di un progetto o, senza `projectId`, di tutti i progetti che vedo. */
export function useDriveFiles(filters: DriveFilters, { enabled = true } = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.driveFiles(me, filters),
    queryFn: () => api.drive.listDriveFiles(filters),
    enabled,
    refetchInterval: (query) => (reading(query.state.data) ? DRIVE_REFRESH_MS : false),
  });
}

/** Il dettaglio di un file (non conta un'apertura); `null` se non c'è per chi guarda. */
export function useDriveFile(id: string | null) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.driveFile(me, id ?? ""),
    queryFn: () => api.drive.getDriveFile(id!),
    enabled: id !== null,
    refetchInterval: (query) =>
      query.state.data?.content === "processing" ? DRIVE_REFRESH_MS : false,
  });
}

export function useFolderLinks(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.folderLinks(me, projectId),
    queryFn: () => api.drive.listFolderLinks(projectId),
  });
}

/** Quante persone leggono il Drive del progetto (membri e full admin, senza Claude). */
export function useDriveReaderCount(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.driveReaders(me, projectId),
    queryFn: () => api.drive.countDriveReaders(projectId),
  });
}

/** Le cartelle collegate da me (quelle che scollegare l'account ferma). */
export function useMyFolderLinks(enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.myFolderLinks(me),
    queryFn: () => api.drive.listMyFolderLinks(),
    enabled,
  });
}

/** L'account Google personale di chi guarda (collegato, scaduto o `null`). */
export function useGoogleAccount() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.googleAccount(me),
    queryFn: () => api.drive.getGoogleAccount(),
  });
}

/**
 * La ricerca nei file del Drive (da 2 caratteri): nel Drive e in ⌘K. Mostra
 * i risultati, non conta aperture. Mentre si scrive restano quelli di prima
 * (della stessa persona).
 */
export function useDriveSearch(q: string, scope: DriveSearchScope = {}, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.driveSearch(me, q, scope),
    queryFn: () => api.drive.searchDrive(q, scope),
    enabled: enabled && q.trim().length >= MIN_QUERY,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

/**
 * Prima di aprire un risultato di ricerca: il file c'è ancora per chi guarda?
 * Rilegge il dettaglio (non conta un'apertura). Tolto, nascosto o permesso
 * perso fra la ricerca e il clic → `false` (shape drive-search.md §5).
 */
export function useDriveFileStillThere() {
  const fileIfThere = useDriveFileIfStillThere();
  return useCallback((id: string) => fileIfThere(id).then((file) => file !== null), [fileIfThere]);
}

/**
 * Come `useDriveFileStillThere`, ma dà il file riletto (o `null`): chi apre
 * da una citazione ha solo l'id, e serve sapere se è Google o un caricato.
 */
export function useDriveFileIfStillThere() {
  const me = useSessionPersonId();
  const client = useQueryClient();
  return useCallback(
    (id: string) =>
      client
        .fetchQuery({
          queryKey: queryKeys.driveFile(me, id),
          queryFn: () => api.drive.getDriveFile(id),
          staleTime: 0,
        })
        .then((file) => (file && !file.hidden ? file : null))
        .catch(() => null),
    [client, me],
  );
}

/** Il selettore di «Collega una cartella». */
export function useGoogleFolders(projectId: string, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.googleFolders(me, projectId),
    queryFn: () => api.drive.listGoogleFolders(projectId),
    enabled,
  });
}

/** Il selettore di «Aggiungi da Google Drive». */
export function useGoogleFiles(projectId: string, q: string, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.googleFiles(me, projectId, q),
    queryFn: () => api.drive.listGoogleFiles(projectId, q),
    enabled,
    // Mentre si scrive restano i file di prima (della stessa persona).
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

export function useUploadFiles() {
  return useWrite(
    ({ projectId, files }: { projectId: string; files: DriveUploadInput[] }) =>
      api.drive.uploadFiles(projectId, files),
    DRIVE_FILE_AREAS,
  );
}

export function useDeleteDriveFile() {
  return useWrite((id: string) => api.drive.deleteDriveFile(id), DRIVE_FILE_AREAS);
}

export function useRemoveGoogleFile() {
  return useWrite((id: string) => api.drive.removeGoogleFile(id), DRIVE_FILE_AREAS);
}

export function useSetDriveHidden() {
  return useWrite(
    ({ id, hidden }: { id: string; hidden: boolean }) => api.drive.setHidden(id, hidden),
    DRIVE_FILE_AREAS,
  );
}

export function useLinkFolder() {
  return useWrite(
    ({ projectId, googleFolderId }: { projectId: string; googleFolderId: string }) =>
      api.drive.linkFolder(projectId, googleFolderId),
    DRIVE_FILE_AREAS,
  );
}

export function useUnlinkFolder() {
  return useWrite((linkId: string) => api.drive.unlinkFolder(linkId), DRIVE_FILE_AREAS);
}

export function useSyncFolder() {
  return useWrite((linkId: string) => api.drive.syncFolder(linkId), DRIVE_FILE_AREAS);
}

export function useAddGoogleFile() {
  return useWrite(
    ({ projectId, googleFileId }: { projectId: string; googleFileId: string }) =>
      api.drive.addGoogleFile(projectId, googleFileId),
    DRIVE_FILE_AREAS,
  );
}

/**
 * Un'apertura (anteprima intera, «Apri in Google Drive», download): solo
 * questi tre gesti la chiamano, mai una lettura. Ricarica anche le
 * citazioni: la scheda al passaggio di un gettone mostra le aperture.
 */
export function useRecordDriveOpen() {
  return useWrite(
    ({ fileId, via }: { fileId: string; via: DriveOpen["via"] }) =>
      api.drive.recordOpen(fileId, via),
    ["drive", "citations"],
  );
}

export function useRetryExtraction() {
  return useWrite((id: string) => api.drive.retryExtraction(id), DRIVE_AREAS);
}

/**
 * Collegare o scollegare l'account Google cambia cosa si vede di Google — i
 * file delle mie cartelle del Drive, Posta, Calendario e
 * scheda di preparazione: un «Reconnect» dal Calendario o dalla Home toglie
 * subito l'avviso di collegamento scaduto.
 */
const GOOGLE_AREAS = [...DRIVE_FILE_AREAS, "mail", "calendar", "meeting"] as const;

export function useConnectGoogle() {
  return useWrite(() => api.drive.connectGoogle(), GOOGLE_AREAS);
}

export function useDisconnectGoogle() {
  return useWrite(() => api.drive.disconnectGoogle(), GOOGLE_AREAS);
}

// --- Posta (area 6) -----------------------------------------------------------

/** Ogni scrittura della Posta ricarica la Posta (e le email della scheda di preparazione). */
const MAIL_AREAS = ["mail", "meeting"] as const;

/** Mentre una casella si allinea o un'email è in analisi la lettura si ripete da sola. */
const MAIL_REFRESH_MS = 1000;
const analysing = (rows: readonly Pick<MailThreadRow, "analysing">[] | null | undefined) =>
  !!rows?.some((r) => r.analysing);
const syncing = (boxes: readonly Pick<MailboxView, "sync">[] | null | undefined) =>
  !!boxes?.some((b) => b.sync === "syncing");

/** L'elenco della Posta per conversazione, coi filtri. */
export function useMailThreads(filters: MailThreadFilters = {}, { enabled = true } = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.mailThreads(me, filters),
    queryFn: () => api.mail.listMailThreads(filters),
    enabled,
    refetchInterval: (query) => (analysing(query.state.data) ? MAIL_REFRESH_MS : false),
  });
}

/** Una conversazione: i messaggi che vedo. Invisibile o inesistente → errore `not_found`. */
export function useMailThread(threadId: string | null) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.mailThread(me, threadId ?? ""),
    queryFn: () => api.mail.getMailThread(threadId!),
    enabled: threadId !== null,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.messages.some((m) => m.classification.state === "pending")
        ? MAIL_REFRESH_MS
        : false,
  });
}

/** Le mie caselle, con «vecchia» e «scaduta». */
export function useMailboxes() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.mailboxes(me),
    queryFn: () => api.mail.listMailboxes(),
    refetchInterval: (query) => (syncing(query.state.data) ? MAIL_REFRESH_MS : false),
  });
}

/** «Email importanti» della Home: alte e non lette. */
export function useImportantMail() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.importantMail(me),
    queryFn: () => api.mail.listImportantMail(),
  });
}

/** La ricerca nella posta (⌘K, da 2 caratteri). Mentre si scrive restano i risultati di prima. */
export function useMailSearch(q: string, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.mailSearch(me, q),
    queryFn: () => api.mail.searchMail(q),
    enabled: enabled && q.trim().length >= MIN_QUERY,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

export function useMarkMailRead() {
  return useWrite((threadId: string) => api.mail.markRead(threadId), MAIL_AREAS);
}

export function useMarkMailUnread() {
  return useWrite((threadId: string) => api.mail.markUnread(threadId), MAIL_AREAS);
}

/**
 * «Aggiorna ora»: appena la casella è «in allineamento» la Posta si rilegge
 * (la casella lo mostra); di nuovo quando l'allineamento finisce, così la
 * posta arrivata entra in elenco «in analisi»; e un'ultima volta quando la
 * sua classificazione è finita, così l'importanza arriva anche alle
 * «Email importanti», che non si rileggono da sole.
 */
export function useSyncMailbox() {
  const invalidate = useInvalidate(MAIL_AREAS);
  return useMutation({
    mutationFn: async (email: string) => {
      await api.mail.syncMailbox(email);
      void invalidate();
      await api.mail.whenMailSynced();
      void invalidate();
      await api.mail.whenMailIdle();
    },
    onSettled: invalidate,
  });
}

export function useSetProposalsEnabled() {
  return useWrite(
    ({ email, on }: { email: string; on: boolean }) => api.mail.setProposalsEnabled(email, on),
    MAIL_AREAS,
  );
}

/**
 * «Riproponi» un'email la cui analisi è fallita: si rilegge subito («in
 * analisi») e di nuovo a classificazione finita (vedi `useSyncMailbox`).
 */
export function useReproposeMessage() {
  const invalidate = useInvalidate(MAIL_AREAS);
  return useMutation({
    mutationFn: async (id: string) => {
      await api.mail.reproposeMessage(id);
      void invalidate();
      await api.mail.whenMailIdle();
    },
    onSettled: invalidate,
  });
}

// Le proposte condivise della posta. Una conferma crea task, richieste,
// decisioni e traguardi, e può aggiungere una persona al progetto: rilegge
// quelle aree oltre alla Posta. Le altre decisioni cambiano solo la Posta.

const MAIL_CONFIRM_AREAS = [
  ...MAIL_AREAS,
  ...TASK_AREAS,
  ...REQUEST_AREAS,
  ...DECISION_AREAS,
  ...MILESTONE_AREAS,
  ...PROJECT_AREAS,
] as const;

/** Le proposte che vedo, di un'email (`sourceId`) o per stato. */
export function useMailProposals(filters: MailProposalFilters = {}, { enabled = true } = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.mailProposals(me, filters),
    queryFn: () => api.mail.listMailProposals(filters),
    enabled,
  });
}

/** Una proposta, con `canConfirm`, `canHand`, gli incaricati fuori progetto e chi ha deciso. */
export function useMailProposal(id: string | null) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.mailProposal(me, id ?? ""),
    queryFn: () => api.mail.getMailProposal(id!),
    enabled: id !== null,
    retry: false,
  });
}

/** Le proposte della posta che aspettano me («Da decidere», `kind: "mailProposal"`). */
export function useMailProposalDecisions() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.mailDecisions(me),
    queryFn: () => api.mail.listMailDecisions(),
  });
}

/**
 * Decidere una proposta della posta ADESSO (vedi `useAnswerDecisionNow`): per
 * l'«Undo» di «Da decidere». La chiamata parte in questo istante, con la
 * sessione di chi decide, e alla fine si rileggono le aree che la conferma
 * cambia.
 */
export function useDecideMailProposalNow() {
  const invalidate = useInvalidate(MAIL_CONFIRM_AREAS);
  const settle = async <R,>(call: Promise<R>): Promise<R> => {
    try {
      return await call;
    } finally {
      await invalidate();
    }
  };
  return {
    confirm: (id: string, input: api.mail.ConfirmMailProposalInput) =>
      settle(api.mail.confirmMailProposal(id, input)),
    ignore: (id: string) => settle(api.mail.ignoreMailProposal(id)),
    hand: (id: string) => settle(api.mail.handMailProposal(id)),
    /** Rilegge la proposta dopo un `already_handled`: chi l'ha decisa, come, cosa è nato. */
    read: (id: string) => api.mail.getMailProposal(id),
  };
}

export function useConfirmMailProposal() {
  return useWrite(
    ({ id, ...input }: { id: string } & api.mail.ConfirmMailProposalInput) =>
      api.mail.confirmMailProposal(id, input),
    MAIL_CONFIRM_AREAS,
  );
}

export function useIgnoreMailProposal() {
  return useWrite((id: string) => api.mail.ignoreMailProposal(id), MAIL_AREAS);
}

export function useHandMailProposal() {
  return useWrite((id: string) => api.mail.handMailProposal(id), MAIL_AREAS);
}

export function useChooseMailProject() {
  return useWrite(
    ({ id, projectId }: { id: string; projectId: string }) =>
      api.mail.chooseProjectFor(id, projectId),
    MAIL_AREAS,
  );
}

export function useReassignMailProposal() {
  return useWrite(
    ({ id, projectId }: { id: string; projectId: string }) =>
      api.mail.reassignMailProposal(id, projectId),
    MAIL_AREAS,
  );
}

// Scrivere dalla Posta: bozze, invio con «Annulla», invio fallito, la bozza
// di Claude. Allo scadere dei 5 s un invio cambia la Posta di chi l'ha
// scritto E dei destinatari: la rilettura di allora vale per ogni persona
// (anche se nel frattempo si guarda come un'altra), non solo per chi ha
// premuto «Invia».

/** La bozza di una conversazione (o dell'email nuova) in una modalità: salvata o nuova. */
export function useMailDraft(
  threadId: string | null,
  mode: MailDraft["mode"],
  { enabled = true } = {},
) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.mailDraft(me, threadId, mode),
    queryFn: () => api.mail.getDraft(threadId, mode),
    enabled,
    retry: false,
  });
}

/** I limiti della casella (quelli di Gmail) e la finestra dell'«Annulla», per la UI. */
export const MAIL_LIMITS = {
  attachments: api.mail.MAIL_MAX_ATTACHMENTS,
  bytes: api.mail.MAIL_MAX_BYTES,
  undoMs: api.mail.MAIL_UNDO_MS,
} as const;

/**
 * Legge ADESSO la bozza di una modalità (non dalla cache): la casella la
 * prende all'apertura e passando fra Rispondi, Rispondi a tutti e Inoltra,
 * dopo aver salvato il corpo — così destinatari e oggetto sono rifatti e il
 * corpo resta [A 1].
 */
export function useLoadMailDraft() {
  const client = useQueryClient();
  const me = useSessionPersonId();
  return useCallback(
    (threadId: string | null, mode: MailDraft["mode"]) =>
      client.fetchQuery({
        queryKey: queryKeys.mailDraft(me, threadId, mode),
        queryFn: () => api.mail.getDraft(threadId, mode),
        staleTime: 0,
        retry: false,
      }),
    [client, me],
  );
}

/** Le mie bozze, dalla più recente (la riga «Bozza» in elenco). */
export function useMailDrafts() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.mailDrafts(me),
    queryFn: () => api.mail.listDrafts(),
  });
}

/** I destinatari suggeriti mentre si scrive (team, poi la mia posta). */
export function useRecipientSuggestions(q: string, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.mailRecipients(me, q),
    queryFn: () => api.mail.suggestRecipients(q),
    enabled: enabled && q.trim().length > 0,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

export function useSaveMailDraft() {
  return useWrite((draft: api.mail.MailDraftInput) => api.mail.saveDraft(draft), MAIL_AREAS);
}

/**
 * Salva la bozza SUBITO, fuori da React Query: per il cambio di persona
 * (`onBeforePersonaChange`), dove la sessione è ancora di chi scriveva solo
 * finché non si torna al ciclo degli eventi — `gate` la legge qui, in modo
 * sincrono, e una mutazione la leggerebbe dopo, a persona già cambiata. La
 * Posta della persona nuova si rilegge comunque da capo.
 */
export function saveMailDraftNow(draft: api.mail.MailDraftInput): Promise<unknown> {
  return api.mail.saveDraft(draft).catch(() => undefined);
}

export function useDiscardMailDraft() {
  return useWrite((id: string) => api.mail.discardDraft(id), MAIL_AREAS);
}

export function useAttachDriveFileToDraft() {
  return useWrite(
    ({ draftId, driveFileId }: { draftId: string; driveFileId: string }) =>
      api.mail.attachDriveFile(draftId, driveFileId),
    MAIL_AREAS,
  );
}

/** Rilegge la Posta di tutti quando un invio esce dai suoi 5 s. */
function useAfterSendWindow() {
  const client = useQueryClient();
  return (messageId: string) =>
    void api.mail.whenSendSettled(messageId).then(() =>
      client.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "as" && query.queryKey[2] === "mail",
      }),
    );
}

/**
 * «Invia» (e «Riprova»): risolve subito con `undoUntil`, per l'avviso
 * «Annulla»; la Posta si rilegge ora («Invio…») e allo scadere dei 5 s.
 */
export function useSendMailDraft() {
  const invalidate = useInvalidate(MAIL_AREAS);
  const afterWindow = useAfterSendWindow();
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await api.mail.sendDraft(id);
      afterWindow(result.messageId);
      return result;
    },
    onSettled: invalidate,
  });
}

export function useRetryMailSend() {
  const invalidate = useInvalidate(MAIL_AREAS);
  const afterWindow = useAfterSendWindow();
  return useMutation({
    mutationFn: async (messageId: string) => {
      const result = await api.mail.retrySend(messageId);
      afterWindow(result.messageId);
      return result;
    },
    onSettled: invalidate,
  });
}

/** «Annulla» entro i 5 s: la bozza torna (unita a una più recente, con gli allegati rimasti fuori); oltre: `too_late`. */
export function useUndoMailSend() {
  return useWrite((messageId: string) => api.mail.undoSend(messageId), MAIL_AREAS);
}

/** L'«Undo» di «Discard»: la bozza torna (unita a una più recente, con gli allegati rimasti fuori). */
export function useRestoreDiscardedMailDraft() {
  return useWrite(
    (snapshot: api.mail.MailDraftInput) => api.mail.restoreDiscardedDraft(snapshot),
    MAIL_AREAS,
  );
}

/** «Elimina» o «Modifica» un invio fallito: la bozza torna (unita a una più recente, se c'è). */
export function useDeleteFailedMailSend() {
  return useWrite((messageId: string) => api.mail.deleteFailedSend(messageId), MAIL_AREAS);
}

// --- Calendario (area 6) -------------------------------------------------------

/**
 * Le scritture del Calendario ricaricano il Calendario e la Posta (le
 * proposte del calendario stanno lì: una risposta o un progetto le cambiano)
 * e la scheda di preparazione (un progetto o un orario la accendono o spengono).
 */
const CALENDAR_AREAS = ["calendar", "mail", "meeting"] as const;

/**
 * Configurare una serie o allinearsi può far agire da sola una serie con
 * «Agisci da solo» (`settleAutomatically`): nascono traguardi e richieste.
 * Si rileggono anche task, richieste, traguardi e decisioni; «Da decidere»
 * della posta sta già in `mail`.
 */
const CALENDAR_WORK_AREAS = [
  ...CALENDAR_AREAS,
  ...TASK_AREAS,
  ...REQUEST_AREAS,
  ...MILESTONE_AREAS,
  ...DECISION_AREAS,
] as const;

/** Mentre un evento si salva o il calendario si allinea la lettura si ripete da sola. */
const CALENDAR_REFRESH_MS = 1000;
const saving = (events: readonly Pick<CalendarEventView, "save">[] | null | undefined) =>
  !!events?.some((e) => e.save?.state === "saving");

/**
 * La finestra che Stubwise legge da Google (`now − 30 → now + 60` giorni, a
 * giorni interi UTC): la griglia ne segna i bordi. Non è una lettura: è una
 * regola dell'orologio del prototipo.
 */
export const calendarReadWindow = (): { from: string; to: string } => api.calendar.calendarWindow();

/** Gli eventi che vedo nell'intervallo, dentro la finestra letta. */
export function useCalendarEvents(range: { from: string; to: string }, { enabled = true } = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.calendarEvents(me, range),
    queryFn: () => api.calendar.listEvents(range),
    enabled,
    refetchInterval: (query) => (saving(query.state.data) ? CALENDAR_REFRESH_MS : false),
  });
}

/** Un evento con la sua serie. Invisibile, inesistente o fuori finestra → errore `not_found`. */
export function useCalendarEvent(id: string | null) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.calendarEvent(me, id ?? ""),
    queryFn: () => api.calendar.getEvent(id!),
    enabled: id !== null,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.save?.state === "saving" ? CALENDAR_REFRESH_MS : false,
  });
}

/** Le serie ricorrenti che vedo, anche senza date nella finestra. */
export function useCalendarSeries() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.calendarSeries(me),
    queryFn: () => api.calendar.listSeries(),
  });
}

/** Il mio calendario col suo allineamento («vecchio», «scaduto»). */
export function useCalendars() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.calendars(me),
    queryFn: () => api.calendar.listCalendars(),
    refetchInterval: (query) =>
      query.state.data?.some((c) => c.sync === "syncing") ? CALENDAR_REFRESH_MS : false,
  });
}

/** Libero/occupato degli ospiti del team (mai titoli). */
export function useFreeBusy(personIds: readonly string[], from: string, to: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.freeBusy(me, personIds, from, to),
    queryFn: () => api.calendar.freeBusy([...personIds], from, to),
    enabled: personIds.length > 0,
  });
}

/** «Prossimi appuntamenti» della Home: da adesso a fine di domani. */
export function useUpcomingEvents() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.upcomingEvents(me),
    queryFn: () => api.calendar.listUpcomingEvents(),
  });
}

/**
 * La scheda di preparazione di un evento futuro o in corso: `null` se è
 * passato, senza progetto o se non sono membro; un evento che non vedo →
 * errore `not_found`.
 */
export function useMeetingPrep(eventId: string | null) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.meetingPrep(me, eventId ?? ""),
    queryFn: () => api.calendar.getMeetingPrep(eventId!),
    enabled: eventId !== null,
    retry: false,
  });
}

/** «Meeting summary» di una riunione registrata: `null` per chi non c'era. */
export function useMeetingSummary(eventId: string | null) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.meetingSummary(me, eventId ?? ""),
    queryFn: () => api.mail.getMeetingSummary(eventId!),
    enabled: eventId !== null,
  });
}

/** «Tasks from this meeting»: le task e le richieste nate, per chi le vede. */
export function useTasksBornFrom(eventId: string | null) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.tasksBornFrom(me, eventId ?? ""),
    queryFn: () => api.mail.tasksBornFrom(eventId!),
    enabled: eventId !== null,
  });
}

/** «Trova un orario»: il primo spazio libero per tutti nella giornata. */
export function useFindFreeSlot() {
  return useMutation({
    mutationFn: ({
      personIds,
      durationMin,
      from,
    }: {
      personIds: string[];
      durationMin: number;
      from: string;
    }) => api.calendar.findFirstFreeSlot(personIds, durationMin, from),
  });
}

/**
 * Una scrittura verso Google: si rilegge subito («Salvataggio…») e di nuovo
 * quando il salvataggio è confermato o fallito.
 */
function useCalendarSave<TVars, TData>(
  mutationFn: (vars: TVars) => Promise<TData>,
  areas: readonly string[] = CALENDAR_AREAS,
) {
  const invalidate = useInvalidate(areas);
  const client = useQueryClient();
  const me = useSessionPersonId();
  return useMutation({
    mutationFn: async (vars: TVars) => {
      const result = await mutationFn(vars);
      // L'evento scritto (in «Salvataggio…») entra SUBITO negli elenchi già
      // letti: la rilettura che segue può arrivare a salvataggio finito, e
      // il blocco deve comparire nel posto nuovo con la sua parola di stato.
      if (isEventView(result)) placeEvent(client, me, result);
      void invalidate();
      await api.calendar.whenCalendarIdle();
      return result;
    },
    onSettled: invalidate,
  });
}

function isEventView(x: unknown): x is CalendarEventView {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Partial<CalendarEventView>;
  return (
    typeof e.id === "string" &&
    typeof e.startsAt === "string" &&
    typeof e.endsAt === "string" &&
    typeof e.allDay === "boolean" &&
    typeof e.isOrganizer === "boolean" &&
    Array.isArray(e.attendees)
  );
}

/**
 * Mette (o sostituisce) l'evento negli elenchi letti degli intervalli che
 * tocca, con la stessa regola di `listEvents` (`spanOf`: un «tutto il
 * giorno» copre i giorni LOCALI della sua data).
 */
function placeEvent(client: ReturnType<typeof useQueryClient>, me: string, e: CalendarEventView) {
  const { from, to } = api.calendar.spanOf(e);
  for (const [key, list] of client.getQueriesData<CalendarEventView[]>({
    queryKey: ["as", me, "calendar", "events"],
  })) {
    if (!list) continue;
    const range = key[4] as { from: string; to: string } | undefined;
    const touches = !!range && from < Date.parse(range.to) && to > Date.parse(range.from);
    const rest = list.filter((x) => x.id !== e.id);
    const next = touches
      ? [...rest, e].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id))
      : rest;
    client.setQueryData(key, next);
  }
}

export function useCreateEvent() {
  return useCalendarSave((input: CalendarEventInput) => api.calendar.createEvent(input));
}

export function useUpdateEvent() {
  return useCalendarSave(
    ({ id, patch, scope }: { id: string; patch: CalendarEventPatch; scope?: CalendarScope }) =>
      api.calendar.updateEvent(id, patch, scope),
  );
}

export function useMoveEvent() {
  return useCalendarSave(
    ({
      id,
      startsAt,
      endsAt,
      scope,
      allDay,
    }: {
      id: string;
      startsAt: string;
      endsAt: string;
      scope?: CalendarScope;
      /** Cambia anche «tutto il giorno» (solo per una data). */
      allDay?: boolean;
    }) => api.calendar.moveEvent(id, startsAt, endsAt, scope, allDay),
  );
}

export function useRespondEvent() {
  return useCalendarSave(
    ({ id, rsvp, note, scope }: { id: string; rsvp: Rsvp; note?: string; scope?: CalendarScope }) =>
      api.calendar.respond(id, rsvp, note, scope),
  );
}

/** «Riprova» un salvataggio fallito. */
export function useRetryEventSave() {
  return useCalendarSave((id: string) => api.calendar.retrySave(id));
}

/** «Annulla la modifica»: torna la versione di Google. */
export function useRevertEvent() {
  return useWrite((id: string) => api.calendar.revertEvent(id), CALENDAR_AREAS);
}

export function useDeleteEvent() {
  return useWrite(
    ({ id, scope }: { id: string; scope?: CalendarScope }) => api.calendar.deleteEvent(id, scope),
    CALENDAR_AREAS,
  );
}

/** La correzione del progetto di un evento (vale per tutti). */
export function useSetEventProject() {
  return useWrite(
    ({ id, projectId }: { id: string; projectId: string | null }) =>
      api.calendar.setEventProject(id, projectId),
    CALENDAR_AREAS,
  );
}

/** La configurazione di una serie; accesa senza progetto → `choose_project_first`. */
export function useConfigureSeries() {
  return useWrite(
    ({ id, patch }: { id: string; patch: CalendarSeriesPatch }) =>
      api.calendar.configureSeries(id, patch),
    CALENDAR_WORK_AREAS,
  );
}

/** «Aggiorna ora»: si rilegge subito («Aggiornamento…») e ad allineamento finito. */
export function useSyncCalendar() {
  return useCalendarSave(() => api.calendar.syncCalendar(), CALENDAR_WORK_AREAS);
}

export type ClaudeMailDraftState =
  | { status: "idle" }
  | { status: "writing"; text: string }
  | { status: "done" | "stopped"; outcome: api.mail.ClaudeDraftOutcome }
  | { status: "failed"; error: unknown };

/**
 * «Chiedi a Claude» nella casella: `start` fa arrivare la bozza a pezzi
 * (`writing.text`, il testo fin lì), `stop` la ferma tenendo il testo. Si
 * ferma da sola cambiando persona o smontando la casella. Non salva e non
 * invia nulla: chi la usa mette il testo nel campo (`placeDraft`).
 */
export function useClaudeMailDraft() {
  const me = useSessionPersonId();
  const [state, setState] = useState<ClaudeMailDraftState>({ status: "idle" });
  const current = useRef<api.mail.ClaudeDraftStream | null>(null);

  const stop = useCallback(() => {
    current.current?.stop();
  }, []);

  const start = useCallback((request: MailDraftRequest) => {
    current.current?.stop();
    setState({ status: "writing", text: "" });
    const stream = api.mail.streamClaudeDraft(request, (text) => {
      if (current.current === stream) setState({ status: "writing", text });
    });
    current.current = stream;
    stream.result.then(
      (outcome) => {
        if (current.current === stream)
          setState({ status: outcome.complete ? "done" : "stopped", outcome });
      },
      (error: unknown) => {
        if (current.current === stream) setState({ status: "failed", error });
      },
    );
  }, []);

  const reset = useCallback(() => {
    current.current?.stop();
    current.current = null;
    setState({ status: "idle" });
  }, []);

  // Un'altra persona, o la casella che si chiude: la bozza di prima si ferma e sparisce.
  useEffect(() => reset, [me, reset]);

  return { state, start, stop, reset };
}

// --- Automations (area 7) -----------------------------------------------------

/**
 * Un'esecuzione avanza in coda dopo la scrittura che la avvia o la sblocca,
 * e crea task, traguardi, richieste, email e notifiche: le scritture
 * ricaricano anche quelle aree.
 */
const AUTOMATION_AREAS = [
  "automations",
  ...TASK_AREAS,
  ...MILESTONE_AREAS,
  ...REQUEST_AREAS,
  "mail",
] as const;

/** Mentre un'esecuzione è in corso la lettura si ripete da sola. */
const AUTOMATION_REFRESH_MS = 1000;
const runningIn = (runs: readonly Pick<AutomationRunRow, "status">[] | null | undefined) =>
  !!runs?.some((r) => r.status === "running");

/**
 * Una scrittura delle Automations: ricarica subito, e di nuovo quando le
 * esecuzioni che ha messo in moto si fermano (un'attesa, la fine).
 */
function useAutomationWrite<TVars, TData>(mutationFn: (vars: TVars) => Promise<TData>) {
  const invalidate = useInvalidate(AUTOMATION_AREAS);
  return useMutation({
    mutationFn,
    onSettled: async () => {
      await invalidate();
      void api.automations.whenAutomationsIdle().then(invalidate);
    },
  });
}

export function useAutomations(filter: AutomationListFilter = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.automations(me, filter),
    queryFn: () => api.automations.listAutomations(filter),
  });
}

/** Un'automazione con versioni, errori ed esecuzioni; invisibile o inesistente → `null`. */
export function useAutomation(id: string | null) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.automation(me, id ?? ""),
    queryFn: () => api.automations.getAutomation(id!),
    enabled: id !== null,
    refetchInterval: (query) => (runningIn(query.state.data?.runs) ? AUTOMATION_REFRESH_MS : false),
  });
}

export function useAutomationRuns(filter: AutomationRunFilter = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.automationRuns(me, filter),
    queryFn: () => api.automations.listRuns(filter),
    refetchInterval: (query) => (runningIn(query.state.data) ? AUTOMATION_REFRESH_MS : false),
  });
}

/** Un'esecuzione col registro; invisibile o inesistente → `null`. */
export function useAutomationRun(id: string | null) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.automationRun(me, id ?? ""),
    queryFn: () => api.automations.getRun(id!),
    enabled: id !== null,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? AUTOMATION_REFRESH_MS : false,
  });
}

export function useAutomationSources() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.automationSources(me),
    queryFn: () => api.automations.listSources(),
  });
}

export function useClientLinks() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.clientLinks(me),
    queryFn: () => api.automations.listClientLinks(),
  });
}

/** «Da decidere»: i passi da approvare e i progetti da scegliere che aspettano me. */
export function useMyAutomationApprovals() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.automationApprovals(me),
    queryFn: () => api.automations.listMyApprovals(),
  });
}

/** ⌘K: automazioni ed esecuzioni (da 2 caratteri). */
export function useAutomationSearch(q: string, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.automationSearch(me, q),
    queryFn: () => api.automations.searchAutomations(q),
    enabled: enabled && q.trim().length >= MIN_QUERY,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? keepPreviousData(previous) : undefined,
  });
}

export function useCreateAutomation() {
  return useAutomationWrite(
    (input: Parameters<typeof api.automations.createAutomation>[0]) =>
      api.automations.createAutomation(input),
  );
}

export function useSaveAutomationDraft() {
  return useAutomationWrite(
    ({ id, flow, meta }: { id: string; flow: AutomationFlow; meta?: AutomationMeta }) =>
      api.automations.saveDraft(id, flow, meta),
  );
}

export function usePublishAutomation() {
  return useAutomationWrite((id: string) => api.automations.publish(id));
}

export function useActivateAutomation() {
  return useAutomationWrite((id: string) => api.automations.activate(id));
}

export function usePauseAutomation() {
  return useAutomationWrite((id: string) => api.automations.pause(id));
}

export function useDeleteAutomationDraft() {
  return useAutomationWrite((id: string) => api.automations.deleteDraft(id));
}

export function useStartAutomation() {
  return useAutomationWrite(
    ({ id, event }: { id: string; event?: Record<string, unknown> }) =>
      api.automations.startManual(id, event),
  );
}

export function useSimulateSourceEvent() {
  return useAutomationWrite(
    ({ sourceId, sampleIndex }: { sourceId: string; sampleIndex: number }) =>
      api.automations.simulateSourceEvent(sourceId, sampleIndex),
  );
}

export function useApproveAutomationStep() {
  return useAutomationWrite(
    ({ runId, edited }: { runId: string; edited?: Record<string, string> }) =>
      api.automations.approve(runId, edited),
  );
}

export function useRejectAutomationStep() {
  return useAutomationWrite((runId: string) => api.automations.reject(runId));
}

export function useChooseAutomationProject() {
  return useAutomationWrite(
    ({ runId, projectId }: { runId: string; projectId: string }) =>
      api.automations.chooseProject(runId, projectId),
  );
}

export function useCancelAutomationRun() {
  return useAutomationWrite((runId: string) => api.automations.cancelRun(runId));
}

export function useRetryAutomationStep() {
  return useAutomationWrite((runId: string) => api.automations.retryStep(runId));
}

export function useSkipAutomationStep() {
  return useAutomationWrite((runId: string) => api.automations.skipStep(runId));
}

/** «Fai passare il tempo» (solo prototipo). */
export function useAdvanceAutomationTime() {
  return useAutomationWrite(({ runId, days }: { runId: string; days: number }) =>
    api.automations.advanceTime(runId, days),
  );
}

export function useConnectAutomationSource() {
  return useAutomationWrite((id: string) => api.automations.connectSource(id));
}

export function useDisconnectAutomationSource() {
  return useAutomationWrite((id: string) => api.automations.disconnectSource(id));
}

export function useSetClientLink() {
  return useAutomationWrite((link: ClientProjectLink) => api.automations.setClientLink(link));
}

export function useRemoveClientLink() {
  return useAutomationWrite((clientKey: string) => api.automations.removeClientLink(clientKey));
}

/** La risposta del cliente simulata in una conversazione della Posta (solo prototipo). */
export function useSimulateMailReply() {
  return useAutomationWrite(({ threadId, text }: { threadId: string; text: string }) =>
    api.mail.simulateReply(threadId, text),
  );
}
