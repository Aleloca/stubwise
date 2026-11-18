import type {
  AdminResult,
  MemberDraft,
  MemberPreview,
  ProjectMembersView,
} from "../../admin/types";
import { blockOf, extraOf, refusalOf, sourceOf, sourcesOf } from "./adminPeople";
import { appClient } from "./client";

// Progetto → Settings → Members nella build app (area 9, F1, R8) sulle letture
// CALCOLATE del server (`GET …/members/view`, `POST …/members/:userId/preview`,
// 72): i ruoli con ciò che manca, i permessi che si possono dare, il giudizio
// della bozza (escalation, ultimo gestore) a ogni clic. Il client non li
// deduce. Le scritture sono `PUT …/members/:userId { roleId, permissions? }`
// (l'insieme completo dei permessi dati a mano; assente = invariato) e il
// `DELETE` del membro.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.projects`). */
export interface MembersApi {
  view(projectId: string): Promise<Any>;
  preview(projectId: string, userId: string, draft: MemberDraft): Promise<Any>;
  put(
    projectId: string,
    userId: string,
    body: { roleId: string; permissions?: string[] },
  ): Promise<void>;
  remove(projectId: string, userId: string): Promise<void>;
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!)
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** I rifiuti di Members: `last_manager` del server è `last_members_manager` del prototipo. */
function memberRefusal(error: unknown): Extract<AdminResult, { ok: false }> {
  const r = refusalOf(error);
  if (r.error === "invalid" && r.reason === "last_manager") {
    return { ok: false, error: "invalid", reason: "last_members_manager" };
  }
  return r;
}

export function createRealMembers(api: MembersApi) {
  async function attempt(call: () => Promise<unknown>): Promise<AdminResult> {
    try {
      await call();
      return { ok: true };
    } catch (error) {
      return memberRefusal(error);
    }
  }

  /** La riga di un membro, per partire dai suoi permessi dati a mano. */
  async function memberOf(projectId: string, personId: string) {
    const v = await api.view(projectId);
    return (v.members as Any[]).find((m) => m.personId === personId) as Any | undefined;
  }

  return {
    async listProjectMembers(projectId: string): Promise<ProjectMembersView> {
      const v = await api.view(projectId).catch((error: unknown) => {
        if ((error as { status?: number }).status === 404) throw new Error("not_found");
        throw error;
      });
      return {
        ...v,
        members: (v.members as Any[]).map((m) => ({
          personId: m.personId,
          name: m.name,
          email: m.email,
          avatar: initialsOf(m.name || m.email),
          status: m.status,
          role: {
            id: m.role.id,
            key: m.role.id,
            scope: "project",
            name: m.role.name,
            preset: false,
            permissions: m.role.permissions ?? [],
          },
          extra: (m.extra ?? []).map(extraOf),
          granted: m.granted ?? [],
        })),
      } as ProjectMembersView;
    },

    async previewMember(
      projectId: string,
      personId: string,
      draft: MemberDraft,
    ): Promise<MemberPreview> {
      const p = await api.preview(projectId, personId, draft);
      return {
        ...p,
        permissions: (p.permissions ?? []).map((x: Any) => ({
          permission: x.permission,
          sources: sourcesOf(x.sources),
        })),
        // Una fonte sconosciuta si salta (review F1, I3), con la sua riga.
        removing: (p.removing ?? []).flatMap((x: Any) => {
          const source = sourceOf(x.source);
          return source ? [{ permission: x.permission, source }] : [];
        }),
        roleChoices: p.roleChoices ?? [],
        missing: p.missing ?? [],
        block: blockOf(p.block),
        removeBlock: blockOf(p.removeBlock),
        viewerLoses: p.viewerLoses ?? [],
      } as MemberPreview;
    },

    saveMember: (projectId: string, personId: string, draft: MemberDraft) =>
      attempt(() =>
        api.put(projectId, personId, { roleId: draft.roleId, permissions: draft.granted }),
      ),

    addMember: (projectId: string, personId: string, roleId: string) =>
      attempt(() => api.put(projectId, personId, { roleId })),

    // Senza `permissions` il server lascia com'erano quelli dati a mano.
    setMemberRole: (projectId: string, personId: string, roleId: string) =>
      attempt(() => api.put(projectId, personId, { roleId })),

    removeMember: (projectId: string, personId: string) =>
      attempt(() => api.remove(projectId, personId)),

    async grantMemberPermission(
      projectId: string,
      personId: string,
      permission: string,
    ): Promise<AdminResult> {
      const m = await memberOf(projectId, personId);
      if (!m) return { ok: false, error: "not_found" };
      const granted = [...new Set([...(m.granted ?? []), permission])];
      return attempt(() =>
        api.put(projectId, personId, { roleId: m.role.id, permissions: granted }),
      );
    },

    async revokeMemberPermission(
      projectId: string,
      personId: string,
      permission: string,
    ): Promise<AdminResult> {
      const m = await memberOf(projectId, personId);
      if (!m) return { ok: false, error: "not_found" };
      const granted = (m.granted ?? []).filter((p: string) => p !== permission);
      return attempt(() =>
        api.put(projectId, personId, { roleId: m.role.id, permissions: granted }),
      );
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: MembersApi = {
  view: (projectId) => appClient().projects.membersView(projectId),
  preview: (projectId, userId, draft) =>
    appClient().projects.previewMember(projectId, userId, draft),
  put: async (projectId, userId, body) => {
    await appClient().projects.putMember(projectId, userId, body);
  },
  remove: (projectId, userId) => appClient().projects.removeMember(projectId, userId),
};

/** SOLO TEST: le rotte vere. */
export const liveMembersApiForTest = liveApi;

export const liveMembers = createRealMembers(liveApi);
