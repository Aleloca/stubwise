import { ApiError } from "@stubwise/api-client";
import type { CreateInviteInput } from "../../admin/invites";
import type {
  AdminResult,
  ExtraPermission,
  InviteChoices,
  InviteView,
  ObservedAuthor,
  PeopleFilter,
  PersonDetail,
  PersonRow,
  RoleView,
  SecurityEvent,
  SourceView,
} from "../../admin/types";
import { appClient, session } from "./client";
import { eventKindOf } from "./meSecurity";
import { instanceOrigin } from "./supportWidgets";

// People, inviti e Roles nella build app (area 9, F1, R7) sulle letture
// CALCOLATE del server (`GET /api/admin/...`, 72): azioni consentite col
// motivo, ciò che manca per dare un ruolo, portata, blocchi. Il client non li
// deduce (permissions.md): qui si traducono le forme e si compongono i link.
// Le scritture passano dalle rotte di sempre (`/api/users`, `/api/roles`,
// `/api/auth/invites`, le identità git).

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero). */
export interface AdminPeopleApi {
  people(): Promise<Any[]>;
  person(id: string): Promise<Any>;
  roles(): Promise<Any[]>;
  invites(): Promise<Any[]>;
  inviteChoices(): Promise<Any>;
  revokeInvite(id: string): Promise<void>;
  createInvite(body: {
    email: string;
    instanceRoleId: string;
    projects: { projectId: string; roleId: string }[];
  }): Promise<{ id: string; token: string; expiresAt: string }>;
  setInstanceRole(userId: string, roleId: string): Promise<void>;
  passwordReset(userId: string): Promise<{ token: string; expiresAt: string }>;
  resetSecondFactor(userId: string): Promise<void>;
  deactivate(userId: string, reassign: Record<string, string | null>): Promise<void>;
  reactivate(userId: string): Promise<void>;
  changeEmail(userId: string, email: string): Promise<void>;
  securityEvents(userId: string): Promise<{ events: Any[] }>;
  observedAuthors(): Promise<Any[]>;
  linkGitIdentity(userId: string, email: string): Promise<void>;
  unlinkGitIdentity(userId: string, email: string): Promise<void>;
  setBitbucket(userId: string, username: string | null): Promise<void>;
  createRole(body: { name: string; scope: string; permissions: string[] }): Promise<{ id: string }>;
  duplicateRole(roleId: string): Promise<{ id: string }>;
  updateRole(roleId: string, patch: { name?: string; permissions?: string[] }): Promise<void>;
  deleteRole(roleId: string): Promise<void>;
  /** Le fonti dei permessi di chi guarda (`access.whatCan`, calcolate dal server). */
  myPermissions(): Promise<{
    instance: { permission: string; reasons: { kind: string; roleId?: string | null }[] }[];
    projects: {
      permissions: { permission: string; reasons: { kind: string; roleId?: string | null }[] }[];
    }[];
  }>;
  origin(): Promise<string>;
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!)
    .join("")
    .slice(0, 2)
    .toUpperCase();

/**
 * La fonte PIATTA del server come l'unione del prototipo; `null` per un tipo
 * che il client non conosce (review F1, I3: mai «full admin» per ripiego, che
 * affermerebbe un permesso che non c'è). Chi la usa la salta: `sourcesOf`.
 */
export function sourceOf(s: Any): SourceView | null {
  if (s.kind === "role")
    return { kind: "role", roleId: s.roleId ?? "", roleName: s.roleName ?? "" };
  if (s.kind === "grant")
    return {
      kind: "grant",
      grantedById: s.grantedById ?? null,
      grantedByName: s.grantedByName ?? null,
      at: s.at ?? "",
      origin: s.origin ?? (s.grantedById ? "given" : "seed"),
    };
  if (s.kind === "department")
    return {
      kind: "department",
      departmentId: s.departmentId ?? "",
      departmentName: s.departmentName ?? "",
    };
  if (s.kind === "full_admin") return { kind: "full_admin" };
  return null;
}

/** Le fonti conosciute, nell'ordine del server. */
export const sourcesOf = (list: Any[] | undefined): SourceView[] =>
  (list ?? []).map(sourceOf).filter((s): s is SourceView => s !== null);

/**
 * I blocchi del server nelle parole del prototipo: il server ha UN codice,
 * `last_manager`; il prototipo lo chiama `last_members_manager`.
 */
export const blockOf = (b: string | null | undefined): string | null =>
  b === "last_manager" ? "last_members_manager" : (b ?? null);

export const extraOf = (e: Any): ExtraPermission => ({
  permission: e.permission,
  sources: sourcesOf(e.sources),
  granted: !!e.granted,
});

/** Il server ha risposto senza token di reset: un errore che si vede (review F1, M6). */
class ResetLinkUnavailable extends Error {}

/** Un rifiuto del server nelle parole dell'Amministrazione del prototipo. */
export function refusalOf(error: unknown): Extract<AdminResult, { ok: false }> {
  if (error instanceof ResetLinkUnavailable)
    return { ok: false, error: "invalid", reason: "reset_link_unavailable" };
  if (!(error instanceof ApiError)) throw error;
  const code = error.code ?? "";
  if (code === "reauth_required") return { ok: false, error: "reauth_required" };
  if (code === "escalation") {
    const details = error.details as { permission?: string; missing?: string[] } | undefined;
    const missing = details?.missing ?? (details?.permission ? [details.permission] : []);
    return { ok: false, error: "escalation", missing };
  }
  if (error.status === 404) return { ok: false, error: "not_found" };
  if (error.status === 403 && (code === "forbidden" || code === ""))
    return { ok: false, error: "forbidden" };
  // I rifiuti di regola col loro codice (`self`, `last_full_admin`, `in_use`…).
  if (code === "cannot_deactivate_self" || code === "cannot_change_own_email") {
    return { ok: false, error: "invalid", reason: "self" };
  }
  if (code === "email_already_exists")
    return { ok: false, error: "invalid", reason: "email_taken" };
  if (code) return { ok: false, error: "invalid", reason: code };
  throw error;
}

const statuses = (f: PeopleFilter) => f.statuses ?? [];

export function createRealAdminPeople(api: AdminPeopleApi) {
  async function attempt<T extends object = object>(
    call: () => Promise<T | void>,
  ): Promise<AdminResult<T>> {
    try {
      const r = await call();
      return { ok: true, ...(r ?? ({} as T)) } as AdminResult<T>;
    } catch (error) {
      return refusalOf(error);
    }
  }

  return {
    async listPeople(filter: PeopleFilter = {}): Promise<PersonRow[]> {
      const q = filter.q?.trim().toLowerCase() ?? "";
      return (await api.people())
        .map(
          (r): PersonRow => ({
            personId: r.personId,
            name: r.name,
            email: r.email,
            avatar: initialsOf(r.name || r.email),
            instanceRole: r.instanceRole ?? null,
            departments: r.departments ?? [],
            projects: r.projects ?? [],
            status: r.status,
            deactivatedAt: r.deactivatedAt ?? null,
            invite: r.invite ? { ...r.invite, invitedByName: r.invite.invitedByName ?? "" } : null,
          }),
        )
        .filter(
          (r) =>
            (!q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)) &&
            (!filter.departmentIds?.length ||
              r.departments.some((d) => filter.departmentIds!.includes(d.id))) &&
            (!filter.instanceRoleIds?.length ||
              (r.instanceRole !== null && filter.instanceRoleIds.includes(r.instanceRole.id))) &&
            (!statuses(filter).length || statuses(filter).includes(r.status)),
        );
    },

    async getPerson(personId: string): Promise<PersonDetail> {
      let d: Any;
      try {
        d = await api.person(personId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) throw new Error("not_found");
        throw error;
      }
      return {
        ...d,
        avatar: initialsOf(d.name || d.email),
        projects: (d.projects ?? []).map((p: Any) => ({
          ...p,
          extra: (p.extra ?? []).map(extraOf),
        })),
        identities: d.identities ?? { gitEmails: [], bitbucketUsername: null },
        openTasks: d.openTasks ?? [],
        addableTo: d.addableTo ?? [],
        actions: Object.fromEntries(
          Object.entries((d.actions ?? {}) as Record<string, string | null>).map(([k, v]) => [
            k,
            blockOf(v),
          ]),
        ),
        instanceRoleChoices: (d.instanceRoleChoices ?? []).map((c: Any) => ({
          ...c,
          block: blockOf(c.block),
        })),
      } as PersonDetail;
    },

    async listSecurityEvents(
      personId: string,
    ): Promise<(SecurityEvent & { byName: string | null })[]> {
      const { events } = await api.securityEvents(personId);
      return events.map((e) => ({
        id: e.id,
        personId,
        kind: eventKindOf(e.kind) as SecurityEvent["kind"],
        at: e.createdAt,
        byId: null,
        byName: e.actorEmail ?? null,
      }));
    },

    async listObservedAuthors(): Promise<ObservedAuthor[]> {
      // Il server dice email, nome visto e ultima volta: i conteggi per
      // progetto del prototipo non ci sono (restano vuoti).
      return (await api.observedAuthors())
        .filter((a) => a.linkedUserId === null)
        .map((a) => ({ name: a.email, commits: 0, projectCodes: [], lastAt: a.lastSeenAt }));
    },

    setInstanceRole: (personId: string, roleId: string) =>
      attempt(() => api.setInstanceRole(personId, roleId)),

    async createPasswordResetLink(
      personId: string,
    ): Promise<AdminResult<{ link: string; expiresAt: string }>> {
      return attempt(async () => {
        const r = await api.passwordReset(personId);
        // Review F1, M6: senza token non c'è link (mai `/reset-password/null`).
        if (!r.token) throw new ResetLinkUnavailable();
        // Il link della web «app» dal token (Task 10b del server).
        return {
          link: `${await api.origin()}/app/#/reset-password/${r.token}`,
          expiresAt: r.expiresAt,
        };
      });
    },

    resetSecondFactor: (personId: string) => attempt(() => api.resetSecondFactor(personId)),

    async deactivatePerson(
      personId: string,
      reassignTo: Record<string, string | null> = {},
    ): Promise<AdminResult<{ reassigned: number }>> {
      try {
        await api.deactivate(personId, reassignTo);
        // Il server risponde 204: quante ne ha spostate si conta dalle righe.
        return {
          ok: true,
          reassigned: Object.values(reassignTo).filter((to) => to !== null).length,
        };
      } catch (error) {
        if (error instanceof ApiError && error.code === "invalid_reassignment") {
          const taskId = (error.details as { taskId?: string } | undefined)?.taskId;
          return {
            ok: false,
            error: "invalid",
            reason: "invalid_reassignment",
            ...(taskId ? { taskId } : {}),
          };
        }
        return refusalOf(error);
      }
    },

    reactivatePerson: (personId: string) => attempt(() => api.reactivate(personId)),
    changeEmail: (personId: string, email: string) =>
      attempt(() => api.changeEmail(personId, email.trim())),
    linkGitIdentity: (personId: string, identity: string) =>
      attempt(() => api.linkGitIdentity(personId, identity.trim())),
    unlinkGitIdentity: (personId: string, identity: string) =>
      attempt(() => api.unlinkGitIdentity(personId, identity)),
    setBitbucketUsername: (personId: string, username: string | null) =>
      attempt(() => api.setBitbucket(personId, username?.trim() ? username.trim() : null)),

    async listInvites(): Promise<InviteView[]> {
      return (await api.invites()).map((i) => ({ ...i, invitedByName: i.invitedByName ?? "" }));
    },

    async getInviteChoices(): Promise<InviteChoices> {
      return api.inviteChoices();
    },

    async createInvite(
      input: CreateInviteInput,
    ): Promise<AdminResult<{ inviteId: string; link: string; expiresAt: string }>> {
      return attempt(async () => {
        const r = await api.createInvite({
          email: input.email.trim(),
          instanceRoleId: input.instanceRoleId,
          projects: input.projects,
        });
        // Review F1, I2: l'id opaco lo dà il server; il token resta solo nel link.
        return {
          inviteId: r.id,
          link: `${await api.origin()}/app/#/register/${r.token}`,
          expiresAt: r.expiresAt,
        };
      });
    },

    revokeInvite: (id: string) => attempt(() => api.revokeInvite(id)),

    async listRoles(): Promise<RoleView[]> {
      return (await api.roles()).map((r) => ({
        ...r,
        key: r.presetKey ?? r.id,
        preset: r.presetKey !== null && r.presetKey !== undefined,
      }));
    },

    async createRole(input: {
      name: string;
      scope: "instance" | "project";
      from?: string;
    }): Promise<AdminResult<{ roleId: string }>> {
      return attempt(async () => {
        const base = input.from ? (await api.roles()).find((r) => r.id === input.from) : undefined;
        const r = await api.createRole({
          name: input.name.trim(),
          scope: input.scope,
          permissions: base?.permissions ?? [],
        });
        return { roleId: r.id };
      });
    },

    duplicateRole: (roleId: string) =>
      attempt(async () => ({ roleId: (await api.duplicateRole(roleId)).id })),
    updateRole: (roleId: string, patch: { name?: string; permissions?: string[] }) =>
      attempt(() => api.updateRole(roleId, patch)),
    deleteRole: (roleId: string) => attempt(() => api.deleteRole(roleId)),

    /**
     * Cosa perde chi guarda salvando il ruolo così: i permessi che gli vengono
     * SOLO da quel ruolo (le fonti le calcola il server, `access.whatCan`) e
     * che la versione nuova non ha più.
     */
    async viewerLosesIf(roleId: string, nextPermissions: string[]): Promise<string[]> {
      const mine = await api.myPermissions();
      const next = new Set(nextPermissions);
      const lost = new Set<string>();
      for (const p of [...mine.instance, ...mine.projects.flatMap((x) => x.permissions)]) {
        const onlyThisRole =
          p.reasons.length > 0 && p.reasons.every((r) => r.kind === "role" && r.roleId === roleId);
        if (onlyThisRole && !next.has(p.permission)) lost.add(p.permission);
      }
      return [...lost];
    },
  };
}

const seg = encodeURIComponent;

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: AdminPeopleApi = {
  people: () => appClient().admin.people() as Promise<Any[]>,
  person: (id) => appClient().admin.person(id),
  roles: () => appClient().admin.roles() as Promise<Any[]>,
  invites: () => appClient().admin.invites() as Promise<Any[]>,
  inviteChoices: () => appClient().admin.inviteChoices(),
  revokeInvite: (id) => appClient().admin.revokeInvite(id),
  createInvite: (body) =>
    appClient().request("POST", "/api/auth/invites", body) as Promise<{
      id: string;
      token: string;
      expiresAt: string;
    }>,
  setInstanceRole: async (userId, roleId) => {
    await appClient().request("PATCH", `/api/users/${seg(userId)}/instance-role`, { roleId });
  },
  passwordReset: (userId) =>
    appClient().users.passwordReset(userId) as Promise<{ token: string; expiresAt: string }>,
  resetSecondFactor: async (userId) => {
    await appClient().request("DELETE", `/api/users/${seg(userId)}/second-factor`);
  },
  deactivate: (userId, reassign) => appClient().users.deactivate(userId, reassign),
  reactivate: (userId) => appClient().users.reactivate(userId),
  changeEmail: async (userId, email) => {
    await appClient().users.changeEmail(userId, email);
  },
  securityEvents: (userId) =>
    appClient().request("GET", `/api/users/${seg(userId)}/security-events`) as Promise<{
      events: Any[];
    }>,
  observedAuthors: () => appClient().request("GET", "/api/git/observed-authors") as Promise<Any[]>,
  linkGitIdentity: async (userId, email) => {
    await appClient().request("POST", `/api/users/${seg(userId)}/git-identities`, { email });
  },
  unlinkGitIdentity: async (userId, email) => {
    await appClient().request("DELETE", `/api/users/${seg(userId)}/git-identities/${seg(email)}`);
  },
  setBitbucket: async (userId, username) => {
    if (username === null)
      await appClient().request("DELETE", `/api/users/${seg(userId)}/bitbucket`);
    else await appClient().request("PUT", `/api/users/${seg(userId)}/bitbucket`, { username });
  },
  createRole: (body) => appClient().request("POST", "/api/roles", body) as Promise<{ id: string }>,
  duplicateRole: (roleId) =>
    appClient().request("POST", `/api/roles/${seg(roleId)}/duplicate`, {}) as Promise<{
      id: string;
    }>,
  updateRole: async (roleId, patch) => {
    await appClient().request("PATCH", `/api/roles/${seg(roleId)}`, patch);
  },
  deleteRole: async (roleId) => {
    await appClient().request("DELETE", `/api/roles/${seg(roleId)}`);
  },
  // Review F1, M1: senza persona in sessione non si chiede niente (un
  // `userId` vuoto non è nessuno): «cosa perdi» resta senza risposta.
  myPermissions: async () => {
    const userId = session.personId;
    if (!userId) throw new Error("no_session");
    return (await appClient().access.whatCan({ userId })) as Any;
  },
  origin: instanceOrigin,
};

/** SOLO TEST: le rotte vere, per controllarne i percorsi. */
export const liveAdminPeopleApiForTest = liveApi;

export const liveAdminPeople = createRealAdminPeople(liveApi);
