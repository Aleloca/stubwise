import {
  keepPreviousData,
  QueryClient,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "./api";
import { resolveHome } from "../domain/home";
import type {
  Attachment,
  CitationRef,
  ConversationEvent,
  ConversationFilter,
  DayArrangement,
  DecisionDraft,
  DepartmentHome,
  FilterCriteria,
  HomeBlockRef,
  MilestoneInput,
  MilestonePatch,
  Person,
  PersonalHome,
  Project,
  ProjectRequest,
  ProjectStatus,
  RefinePatch,
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
  mentions: (personId: string, kind: "objects" | "people", q: string) =>
    ["as", personId, "mentions", kind, q] as const,
  peopleActivity: (personId: string, date: string, departmentId?: string) =>
    ["as", personId, "peopleActivity", date, departmentId ?? null] as const,
  dailyReports: (personId: string, date: string) => ["as", personId, "dailyReports", date] as const,
};

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
 * una task cambiata sposta liste, board, ferme, polso e cronologia.
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
] as const;

const DECISION_AREAS = ["decisionLog", "timeline"] as const;
/** Un traguardo cambiato sposta avanzamenti, polso, cronologia e le task che lo portano. */
const MILESTONE_AREAS = ["milestones", "tasks", "task", "pulse", "timeline"] as const;

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

/** Una proposta confermata scrive task e richieste; una risposta o un piano il registro. */
const PROPOSAL_AREAS = [
  ...CONVERSATION_CHANGE_AREAS,
  ...TASK_AREAS,
  ...REQUEST_AREAS,
  ...DECISION_AREAS,
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
