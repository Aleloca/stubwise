import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import * as api from "./api";
import type {
  DayArrangement,
  FilterCriteria,
  HomeBlockRef,
  PersonalHome,
  Project,
  ProjectStatus,
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
  timeline: (personId: string, projectId: string) =>
    ["as", personId, "timeline", projectId] as const,
  notifications: (personId: string) => ["as", personId, "notifications"] as const,
  search: (personId: string, q: string) => ["as", personId, "search", q] as const,
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
 * richieste nuove dove può creare task). Finché carica: nessuno.
 */
export function useWaitingOnMe(): Set<string> {
  const me = useSessionPersonId();
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
export function useTasks(criteria?: FilterCriteria, { enabled = true }: { enabled?: boolean } = {}) {
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

export function useRequest(id: string) {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.request(me, id), queryFn: () => api.getRequest(id) });
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

export function useTimeline(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.timeline(me, projectId),
    queryFn: () => api.listTimeline(projectId),
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

export function useSetPinned() {
  const client = useQueryClient();
  const me = useSessionPersonId();
  return useMutation({
    mutationFn: ({ projectId, pinned }: { projectId: string; pinned: boolean }) =>
      api.setPinned(projectId, pinned),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pinned(me) }),
  });
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
const REQUEST_AREAS = ["requests", "request", "waitingOnMe", "tasks", "task", "pulse"] as const;
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
    ["activity", "tasks", "task"],
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

export function useStartRefine() {
  return useWrite(api.startRefine, REQUEST_AREAS);
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

export function useSetPersonalHome() {
  const me = useSessionPersonId();
  return useOptimistic(
    (blocks: HomeBlockRef[]) => api.setPersonalHome(blocks),
    ["personalHome"],
    (blocks, _area, old): PersonalHome => ({
      personId: me,
      seenDepartmentUpdates: {},
      ...(old as PersonalHome | null),
      blocks,
    }),
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
    PROJECT_AREAS,
  );
}

export function useSetStallThresholds() {
  return useWrite(
    ({ projectId, thresholds }: { projectId: string; thresholds: Project["stallThresholds"] }) =>
      api.setStallThresholds(projectId, thresholds),
    PROJECT_AREAS,
  );
}
