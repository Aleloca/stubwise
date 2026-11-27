import {
  workspaceCandidatesSchema,
  workspaceEffectSchema,
  workspaceListSchema,
  workspaceMemberPreviewSchema,
  workspaceViewSchema,
} from "@stubwise/shared";
import type {
  Reader,
  WorkspaceCandidates,
  WorkspaceEffect,
  WorkspaceEffectRequest,
  WorkspaceList,
  WorkspaceMemberPreview,
  WorkspaceView,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * Le workspace (`docs/plans/2026-11-27-workspace-design.md` §2.2): raggruppamenti
 * di progetti per visibilità. Le viste le calcola il server per chi guarda
 * (progetti visibili, persone conosciute, `canManage`/`canManagePeople`). I
 * rifiuti: 403 `escalation` (`missing`), 409 `last_manager`, 403
 * `reauth_required` sulle scritture che aprono un accesso (PUT di progetti e
 * persone, D11), 404 `not_found` per una workspace che chi guarda non vede.
 */
export function createWorkspacesEndpoints(request: ApiRequest) {
  return {
    /**
     * L'elenco e `canManage` (I3, additivo): chi guarda può CREARE workspace.
     * Sta sull'elenco, così vale anche vuoto; un server di prima non lo manda
     * (`false`).
     */
    list(): Promise<Reader<WorkspaceList>> {
      return request("GET", "/api/workspaces", undefined, workspaceListSchema);
    },
    get(id: string): Promise<Reader<WorkspaceView>> {
      return request("GET", `/api/workspaces/${seg(id)}`, undefined, workspaceViewSchema);
    },
    create(body: { name: string; projectIds?: string[] }): Promise<Reader<WorkspaceView>> {
      return request("POST", "/api/workspaces", body, workspaceViewSchema);
    },
    update(id: string, patch: { name?: string }): Promise<Reader<WorkspaceView>> {
      return request("PATCH", `/api/workspaces/${seg(id)}`, patch, workspaceViewSchema);
    },
    /** 204. I progetti restano, fuori da ogni workspace. */
    remove(id: string): Promise<void> {
      return request("DELETE", `/api/workspaces/${seg(id)}`);
    },
    /** Mette il progetto nella workspace; se stava in un'altra, lo sposta. Riconferma (D11). */
    putProject(id: string, projectId: string): Promise<Reader<WorkspaceView>> {
      return request("PUT", `/api/workspaces/${seg(id)}/projects/${seg(projectId)}`, undefined, workspaceViewSchema);
    },
    /** 204: il progetto esce dalla workspace. */
    removeProject(id: string, projectId: string): Promise<void> {
      return request("DELETE", `/api/workspaces/${seg(id)}/projects/${seg(projectId)}`);
    },
    /** L'anteprima di un ingresso o di un cambio di ruolo, con la regola della scrittura. */
    previewMember(id: string, userId: string, body: { roleId?: string }): Promise<Reader<WorkspaceMemberPreview>> {
      return request("POST", `/api/workspaces/${seg(id)}/members/${seg(userId)}/preview`, body, workspaceMemberPreviewSchema);
    },
    /** Entra o cambia ruolo (senza `roleId`: Viewer, D3). Riconferma (D11). */
    putMember(id: string, userId: string, body: { roleId?: string }): Promise<Reader<WorkspaceView>> {
      return request("PUT", `/api/workspaces/${seg(id)}/members/${seg(userId)}`, body, workspaceViewSchema);
    },
    /** 204. `alsoProjects`: toglie anche i ruoli per progetto nella workspace (D12). */
    removeMember(id: string, userId: string, alsoProjects = false): Promise<void> {
      return request(
        "DELETE",
        `/api/workspaces/${seg(id)}/members/${seg(userId)}${toQuery({ alsoProjects: alsoProjects ? "true" : undefined })}`,
      );
    },
    /**
     * Chi si può invitare (lotto 5): le persone attive che chi gestisce vede,
     * fuori chi c'è già, i full admin e Claude; `missing` non vuoto = da
     * spegnere. I ruoli col giudizio su tutti i progetti; `defaultRoleId` è il
     * Viewer. 403 a chi non gestisce le persone (D4).
     */
    candidates(id: string): Promise<Reader<WorkspaceCandidates>> {
      return request("GET", `/api/workspaces/${seg(id)}/candidates`, undefined, workspaceCandidatesSchema);
    },
    /** Chi comincia e chi smette di vedere ogni progetto, e cosa bloccherebbe. Non scrive. */
    effect(body: WorkspaceEffectRequest): Promise<Reader<WorkspaceEffect>> {
      return request("POST", "/api/workspaces/effect", body, workspaceEffectSchema);
    },
  };
}
