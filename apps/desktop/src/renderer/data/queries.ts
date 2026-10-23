import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import * as api from "./api";
import type { FilterCriteria } from "./types";
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

export function useMilestones(projectId?: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.milestones(me, projectId),
    queryFn: () => api.listMilestones(projectId),
  });
}

export function useTasks(criteria?: FilterCriteria) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.tasks(me, criteria),
    queryFn: () => api.listTasks(criteria),
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

export function useStalled(criteria?: FilterCriteria) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.stalled(me, criteria),
    queryFn: () => api.listStalled(criteria),
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
