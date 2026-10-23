import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";

export const queryKeys = {
  projects: ["projects"] as const,
  project: (code: string) => ["project", code] as const,
  pinned: ["pinned"] as const,
  notifications: ["notifications"] as const,
  search: (q: string) => ["search", q] as const,
};

export function useProjects() {
  return useQuery({ queryKey: queryKeys.projects, queryFn: api.listProjects });
}

export function useProject(code: string) {
  return useQuery({ queryKey: queryKeys.project(code), queryFn: () => api.getProjectByCode(code) });
}

/** I progetti fissati, nell'ordine in cui sono stati fissati. */
export function usePinnedProjects() {
  return useQuery({
    queryKey: queryKeys.pinned,
    queryFn: async () => {
      const [ids, projects] = await Promise.all([api.listPinnedProjectIds(), api.listProjects()]);
      return ids.flatMap((id) => projects.filter((p) => p.id === id));
    },
  });
}

export function useNotifications() {
  return useQuery({ queryKey: queryKeys.notifications, queryFn: api.listNotifications });
}

export function useSearch(q: string) {
  return useQuery({
    queryKey: queryKeys.search(q),
    queryFn: () => api.search(q),
    enabled: q.trim().length > 0,
    // Mentre arriva la ricerca nuova restano i risultati di prima: niente sfarfallio.
    placeholderData: keepPreviousData,
  });
}

export function useSetPinned() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, pinned }: { projectId: string; pinned: boolean }) =>
      api.setPinned(projectId, pinned),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pinned }),
  });
}

export function useMarkNotification() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      change,
    }: {
      id: string;
      change: { read?: boolean; archived?: boolean; snoozedUntil?: string | null };
    }) => api.markNotification(id, change),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.notifications }),
  });
}
