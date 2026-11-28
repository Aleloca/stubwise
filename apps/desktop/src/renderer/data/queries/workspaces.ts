import { useQuery } from "@tanstack/react-query";
import * as api from "@backend/api";
import { featureIntegrated } from "../integration";
import { queryKeys, useSessionPersonId } from "../queries";
import type { WorkspaceOperation } from "../workspaces/types";
import { useAdminWrite } from "./admin";

// Le workspace (shape `workspaces.md`). Nella build app restano «in arrivo»
// finché il server non ha le rotte (`featureIntegrated("workspaces")`):
// nessuna lettura parte, e chi le mostra lo chiede a `workspacesAvailable`.
// Una scrittura cambia chi vede cosa: si rilegge tutto (`useAdminWrite`).

export type * from "../workspaces/types";

/** Le workspace ci sono in questa build (nel prototipo sì; nella build app quando il server le ha). */
export const workspacesAvailable = (): boolean => featureIntegrated("workspaces");

/** La colonna di All projects: le workspace che chi guarda vede. */
export function useWorkspaces() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "workspaces"),
    queryFn: () => api.workspaces.listWorkspaces(),
    enabled: workspacesAvailable(),
  });
}

/** La workspace della pagina filtrata (`?workspace=<slug>`). */
export function useWorkspace(slug: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "workspace", slug ?? ""),
    queryFn: () => api.workspaces.getWorkspace(slug!),
    enabled: workspacesAvailable() && !!slug && slug !== "none",
    retry: false,
  });
}

/** La workspace di un progetto (Settings → General, New project, ⌘K). */
export function useWorkspaceOfProject(projectId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "workspaceOfProject", projectId ?? ""),
    queryFn: () => api.workspaces.workspaceOfProject(projectId!),
    enabled: workspacesAvailable() && !!projectId,
  });
}

/** La scheda People di una workspace. */
export function useWorkspaceMembers(workspaceId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "workspaceMembers", workspaceId ?? ""),
    queryFn: () => api.workspaces.listWorkspaceMembers(workspaceId!),
    enabled: workspacesAvailable() && !!workspaceId,
  });
}

/**
 * L'effetto di un'operazione prima di salvarla: chi comincia e chi smette di
 * vedere, e cosa la bloccherebbe. Fra un'operazione e l'altra resta la
 * risposta di prima (la riga dell'effetto non lampeggia).
 */
export function useWorkspaceEffect(op: WorkspaceOperation | null) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "workspaceEffect", op),
    queryFn: () => api.workspaces.previewWorkspace(op!),
    enabled: workspacesAvailable() && op !== null,
    placeholderData: (previous) => previous,
    retry: false,
  });
}

const write = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  function useIt() {
    return useAdminWrite((args: A) => fn(...args));
  };

export const useCreateWorkspace = write(api.workspaces.createWorkspace);
export const useRenameWorkspace = write(api.workspaces.renameWorkspace);
export const useDeleteWorkspace = write(api.workspaces.deleteWorkspace);
export const useSetProjectWorkspace = write(api.workspaces.setProjectWorkspace);
export const useAddWorkspaceMember = write(api.workspaces.addWorkspaceMember);
export const useSetWorkspaceMemberRole = write(api.workspaces.setWorkspaceMemberRole);
export const useRemoveWorkspaceMember = write(api.workspaces.removeWorkspaceMember);
