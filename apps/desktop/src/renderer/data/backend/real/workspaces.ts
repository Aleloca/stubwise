import type * as Fake from "../../api";
import type {
  AdminRefusal,
  AdminResult,
  PersonRef,
  WorkspaceEffect,
  WorkspaceList,
  WorkspaceMemberRow,
  WorkspaceMembersView,
  WorkspaceOperation,
  WorkspaceView,
} from "../../workspaces/types";
import { refusalOf } from "./adminPeople";
import { appClient } from "./client";
import { notIntegratedSync } from "./notIntegrated";
import { listProjects } from "./projects";

// Le workspace nella build app (shape `workspaces.md`), sopra le rotte di
// `docs/plans/2026-11-27-workspace-design.md` §2.2 (`/api/workspaces`). Il
// server calcola le viste per chi guarda (progetti visibili, persone
// conosciute, `canManage`); qui si danno alla UI le stesse forme del
// prototipo. Le differenze di forma, dette una volta:
// - una workspace non ha uno slug: l'indirizzo usa l'id (`?workspace=<id>`);
// - l'effetto del server conosce `addProject`, `removeProject`,
//   `deleteWorkspace` e `removeMember`: «Add projects…» chiede l'effetto di
//   ogni progetto e li somma; invitare e cambiare ruolo passano dall'anteprima
//   del membro (`members/:userId/preview`); una workspace nuova non ha ancora
//   nessuno, quindi «create» non apre accessi (l'effetto è vuoto);
// - i ruoli per progetto in più di una persona e le scelte di ruolo con
//   l'escalation vengono dalla vista dei membri di ogni progetto della
//   workspace (`projects/:id/members/view`), che li calcola il server.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.workspaces` e `client.projects.membersView`). */
export interface WorkspacesApi {
  list(): Promise<Any[]>;
  get(id: string): Promise<Any>;
  create(body: { name: string; projectIds?: string[] }): Promise<Any>;
  update(id: string, patch: { name?: string }): Promise<Any>;
  remove(id: string): Promise<void>;
  putProject(id: string, projectId: string): Promise<Any>;
  removeProject(id: string, projectId: string): Promise<void>;
  previewMember(id: string, userId: string, body: { roleId?: string }): Promise<Any>;
  putMember(id: string, userId: string, body: { roleId?: string }): Promise<Any>;
  removeMember(id: string, userId: string, alsoProjects?: boolean): Promise<void>;
  effect(body: Any): Promise<Any>;
  membersView(projectId: string): Promise<Any>;
  projects(): Promise<{ id: string; code: string; name: string }[]>;
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!)
    .join("")
    .toUpperCase();

const ref = (p: { userId: string; name: string }): PersonRef => ({ personId: p.userId, name: p.name });
const byName = (a: PersonRef, b: PersonRef) => a.name.localeCompare(b.name);

export function createRealWorkspaces(api: WorkspacesApi) {
  async function attempt<T extends object = object>(call: () => Promise<T | void>): Promise<AdminResult<T>> {
    try {
      const r = await call();
      return { ok: true, ...(r ?? ({} as T)) } as AdminResult<T>;
    } catch (error) {
      return refusalOf(error);
    }
  }

  async function codes(): Promise<Map<string, { code: string; name: string }>> {
    return new Map((await api.projects()).map((p) => [p.id, { code: p.code, name: p.name }]));
  }

  /** L'effetto del server nella forma della UI (codici al posto degli id, ordinati). */
  function toEffect(raw: Any, byId: Map<string, { code: string }>): WorkspaceEffect {
    const codeOf = (id: string | null) => (id ? (byId.get(id)?.code ?? "") : "");
    const escalation = new Map<string, string[]>();
    for (const e of raw.escalation ?? []) {
      const code = codeOf(e.projectId);
      escalation.set(code, [...(escalation.get(code) ?? []), e.permission]);
    }
    return {
      projects: (raw.projects ?? [])
        .map((p: Any) => ({
          projectId: p.projectId,
          code: codeOf(p.projectId),
          startSeeing: p.startSeeing.map(ref).sort(byName),
          stopSeeing: p.stopSeeing.map(ref).sort(byName),
        }))
        .sort((a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code)),
      lastManager: (raw.lastManager ?? []).map(codeOf).filter(Boolean),
      escalation: [...escalation].map(([code, missing]) => ({ code, missing })),
      notManaged: [],
    };
  }

  /** Somma degli effetti di più progetti (lo stesso progetto non compare due volte). */
  const merge = (effects: WorkspaceEffect[]): WorkspaceEffect => ({
    projects: effects.flatMap((e) => e.projects).sort((a, b) => a.code.localeCompare(b.code)),
    lastManager: [...new Set(effects.flatMap((e) => e.lastManager))],
    escalation: effects.flatMap((e) => e.escalation),
    notManaged: [],
  });

  const workspaces: typeof Fake.workspaces = {
    async listWorkspaces(): Promise<WorkspaceList> {
      const [items, projects] = await Promise.all([api.list(), api.projects()]);
      const open = new Set(projects.map((p) => p.id));
      const workspaceOfProject: Record<string, string> = {};
      for (const w of items) for (const p of w.projectIds as string[]) workspaceOfProject[p] = w.id;
      return {
        workspaces: items
          .map((w: Any) => ({
            id: w.id,
            slug: w.id,
            name: w.name,
            projectCount: (w.projectIds as string[]).filter((p) => open.has(p)).length,
            isMember: w.isMember,
          }))
          .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
        noWorkspaceCount: projects.filter((p) => !workspaceOfProject[p.id]).length,
        workspaceOfProject,
        // Creare chiede `workspaces.manage`: lo dice una qualunque workspace, o
        // (nessuna ancora) il server al primo tentativo.
        canManage: items.length === 0 ? true : items.some((w: Any) => w.canManage),
      };
    },

    async getWorkspace(slug: string): Promise<WorkspaceView> {
      const w = await api.get(slug);
      return {
        id: w.id,
        slug: w.id,
        name: w.name,
        projectIds: w.projectIds,
        peopleCount: w.people.length,
        canManage: w.canManage,
        canManagePeople: !!w.canManagePeople,
      };
    },

    async workspaceOfProject(projectId: string) {
      const items = await api.list();
      const w = items.find((x: Any) => (x.projectIds as string[]).includes(projectId));
      return {
        workspace: w ? { id: w.id, slug: w.id, name: w.name } : null,
        canChange: w ? !!w.canManage : items.some((x: Any) => x.canManage),
      };
    },

    async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMembersView> {
      const w = await api.get(workspaceId);
      const byId = await codes();
      const projectIds: string[] = w.projectIds;
      // La vista dei membri di ogni progetto: i ruoli per progetto in più e le
      // scelte di ruolo con ciò che manca a chi guarda, calcolate dal server.
      const views = await Promise.all(projectIds.map((p) => api.membersView(p).catch(() => null)));
      const roleOf = new Map<string, Map<string, string>>();
      const addable = new Map<string, string>();
      type Choice = { roleId: string; name: string; permissionCount: number; missing: Set<string>; missingIn: string[] };
      const choices = new Map<string, Choice>();
      projectIds.forEach((projectId, i) => {
        const v = views[i];
        if (!v) return;
        for (const m of v.members ?? []) {
          const map = roleOf.get(m.personId) ?? new Map<string, string>();
          map.set(projectId, m.role.name);
          roleOf.set(m.personId, map);
        }
        for (const c of v.roleChoices ?? []) {
          const entry: Choice = choices.get(c.roleId) ?? {
            roleId: c.roleId,
            name: c.name,
            permissionCount: c.permissionCount,
            missing: new Set<string>(),
            missingIn: [],
          };
          for (const m of c.missing ?? []) entry.missing.add(m);
          if ((c.missing ?? []).length > 0) entry.missingIn.push(byId.get(projectId)?.code ?? "");
          choices.set(c.roleId, entry);
        }
      });
      const inside = new Set((w.people as Any[]).map((p) => p.userId));
      for (const v of views) {
        for (const m of v?.members ?? []) {
          if (!inside.has(m.personId) && m.status === "active") addable.set(m.personId, m.name);
        }
      }
      const members: WorkspaceMemberRow[] = (w.people as Any[])
        .map((p) => {
          const own = roleOf.get(p.userId) ?? new Map<string, string>();
          const projects = projectIds
            .map((projectId) => ({
              projectId,
              code: byId.get(projectId)?.code ?? "",
              name: byId.get(projectId)?.name ?? "",
              roles: [
                ...(own.has(projectId) ? [{ roleName: own.get(projectId)!, source: "member" as const }] : []),
                { roleName: p.roleName, source: "workspace" as const },
              ],
            }))
            .sort((a, b) => a.code.localeCompare(b.code));
          return {
            personId: p.userId,
            name: p.name,
            email: "",
            avatar: initialsOf(p.name),
            status: "active" as const,
            roleId: p.roleId,
            roleName: p.roleName,
            projectRoles: projects.flatMap((x) =>
              own.has(x.projectId) ? [{ projectId: x.projectId, code: x.code, roleName: own.get(x.projectId)! }] : [],
            ),
            projects,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const roleChoices = [...choices.values()].map((c) => ({
        roleId: c.roleId,
        name: c.name,
        permissionCount: c.permissionCount,
        missing: [...c.missing],
        missingIn: c.missingIn,
      }));
      return {
        workspaceId,
        members,
        canManage: !!w.canManagePeople,
        roleChoices,
        // D3: il server dà Viewer senza `roleId`; qui lo si trova per nome fra le scelte.
        defaultRoleId: roleChoices.find((c) => c.name === "Viewer")?.roleId ?? roleChoices[0]?.roleId ?? "",
        addable: [...addable].map(([personId, name]) => ({ personId, name })).sort(byName),
        fullAdmins: [],
      };
    },

    async previewWorkspace(op: WorkspaceOperation): Promise<WorkspaceEffect> {
      const byId = await codes();
      switch (op.kind) {
        case "create":
          // Una workspace nuova non ha ancora persone: non apre accessi.
          return { projects: [], lastManager: [], escalation: [], notManaged: [] };
        case "addProject":
          return toEffect(await api.effect({ kind: "addProject", workspaceId: op.workspaceId, projectId: op.projectId }), byId);
        case "addProjects":
          return merge(
            await Promise.all(
              op.projectIds.map(async (projectId) =>
                toEffect(await api.effect({ kind: "addProject", workspaceId: op.workspaceId, projectId }), byId),
              ),
            ),
          );
        case "removeProject": {
          const items = await api.list();
          const w = items.find((x: Any) => (x.projectIds as string[]).includes(op.projectId));
          if (!w) return { projects: [], lastManager: [], escalation: [], notManaged: [] };
          return toEffect(await api.effect({ kind: "removeProject", workspaceId: w.id, projectId: op.projectId }), byId);
        }
        case "delete":
          return toEffect(await api.effect({ kind: "deleteWorkspace", workspaceId: op.workspaceId }), byId);
        case "removeMember":
          return toEffect(
            await api.effect({
              kind: "removeMember",
              workspaceId: op.workspaceId,
              userId: op.personId,
              alsoProjects: op.alsoFromProjects,
            }),
            byId,
          );
        case "addMember":
        case "setMemberRole": {
          // L'anteprima del membro: dove guadagna qualcosa, la persona comincia a vedere (o vede di più).
          const [preview, w] = await Promise.all([
            api.previewMember(op.workspaceId, op.personId, { roleId: op.roleId }),
            api.get(op.workspaceId),
          ]);
          const name = (w.people as Any[]).find((p) => p.userId === op.personId)?.name ?? "";
          const person = { personId: op.personId, name };
          return toEffect(
            {
              projects:
                op.kind === "addMember"
                  ? (preview.projects as Any[])
                      .filter((p) => p.gains.length > 0)
                      .map((p) => ({ projectId: p.projectId, startSeeing: [{ userId: person.personId, name }], stopSeeing: [] }))
                  : [],
              lastManager: preview.lastManager?.blocked && preview.lastManager.projectId ? [preview.lastManager.projectId] : [],
              escalation: preview.escalation ?? [],
            },
            byId,
          );
        }
      }
    },

    async createWorkspace(name: string, projectIds: readonly string[] = []) {
      try {
        const w = await api.create({ name: name.trim(), ...(projectIds.length > 0 ? { projectIds: [...projectIds] } : {}) });
        return { ok: true as const, slug: w.id as string };
      } catch (error) {
        return refusalOf(error) as AdminRefusal;
      }
    },

    async renameWorkspace(workspaceId: string, name: string) {
      try {
        const w = await api.update(workspaceId, { name: name.trim() });
        return { ok: true as const, slug: w.id as string };
      } catch (error) {
        return refusalOf(error) as AdminRefusal;
      }
    },

    deleteWorkspace: (workspaceId: string) => attempt(() => api.remove(workspaceId)),

    async setProjectWorkspace(projectId: string, workspaceId: string | null): Promise<AdminResult> {
      if (workspaceId !== null) return attempt(async () => void (await api.putProject(workspaceId, projectId)));
      const items = await api.list();
      const w = items.find((x: Any) => (x.projectIds as string[]).includes(projectId));
      if (!w) return { ok: false, error: "invalid", reason: "unchanged" };
      return attempt(() => api.removeProject(w.id, projectId));
    },

    addWorkspaceMember: (workspaceId: string, personId: string, roleId?: string) =>
      attempt(async () => void (await api.putMember(workspaceId, personId, roleId ? { roleId } : {}))),

    setWorkspaceMemberRole: (workspaceId: string, personId: string, roleId: string) =>
      attempt(async () => void (await api.putMember(workspaceId, personId, { roleId }))),

    removeWorkspaceMember: (workspaceId: string, personId: string, alsoFromProjects = false) =>
      attempt(() => api.removeMember(workspaceId, personId, alsoFromProjects)),

    // ⌘K del prototipo: nella build app la ricerca è del server.
    workspacesForSearch: () => ({ workspaces: [], nameOfProject: new Map() }),
    // Le forme sincrone del catalogo di Claude del prototipo: nella build app
    // le azioni di Claude le esegue il server.
    setProjectWorkspaceAs: notIntegratedSync("workspaces.setProjectWorkspaceAs"),
    addWorkspaceMemberAs: notIntegratedSync("workspaces.addWorkspaceMemberAs"),
    removeWorkspaceMemberAs: notIntegratedSync("workspaces.removeWorkspaceMemberAs"),
  } as typeof Fake.workspaces;

  return workspaces;
}

export const workspaces: typeof Fake.workspaces = createRealWorkspaces({
  list: () => appClient().workspaces.list(),
  get: (id) => appClient().workspaces.get(id),
  create: (body) => appClient().workspaces.create(body),
  update: (id, patch) => appClient().workspaces.update(id, patch),
  remove: (id) => appClient().workspaces.remove(id),
  putProject: (id, projectId) => appClient().workspaces.putProject(id, projectId),
  removeProject: (id, projectId) => appClient().workspaces.removeProject(id, projectId),
  previewMember: (id, userId, body) => appClient().workspaces.previewMember(id, userId, body),
  putMember: (id, userId, body) => appClient().workspaces.putMember(id, userId, body),
  removeMember: (id, userId, alsoProjects) => appClient().workspaces.removeMember(id, userId, alsoProjects),
  effect: (body) => appClient().workspaces.effect(body),
  membersView: (projectId) => appClient().projects.membersView(projectId),
  projects: async () => (await listProjects()).map((p) => ({ id: p.id, code: p.code, name: p.name })),
});
