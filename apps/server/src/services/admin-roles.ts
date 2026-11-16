import { inviteProjects, invites, projectMemberPermissions, projectMembers, projects, roles, users, type Db } from "@stubwise/db";
import {
  INSTANCE_PERMISSIONS,
  PROJECT_PERMISSIONS,
  type AdminRoleView,
  type InviteChoices,
  type InviteView,
  type MemberPreview,
  type ProjectMembersView,
  type RoleChoice,
  type SourceView,
} from "@stubwise/shared";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { projectPermissionsFor, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { instanceRoleChoicesFor, inviteIdOf, managedProjectIds, nameOf } from "./admin-people.js";
import { avatarUrlsFor } from "./avatars.js";
import { visiblePersonIds } from "./people-visibility.js";
import { heldForProjectRole, lastManagerProjectOf, listRoles, missingToGrant, RoleRuleError } from "./roles.js";

/**
 * Area 9, F1 (aggiunta per R7 e R8): ruoli, inviti, membri e l'anteprima di
 * una bozza, coi campi calcolati su chi guarda. Ogni `missing` viene da
 * `missingToGrant` coi permessi «tenuti» che la scrittura corrispondente usa:
 * i permessi d'istanza per l'istanza, `heldForProjectRole` per il contenuto di
 * un ruolo di progetto, i permessi nel progetto per un'assegnazione.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
const SYSTEM_PRESET_KEYS: ReadonlySet<string> = new Set(["admin", "user"]);
const granters = alias(users, "granter");

async function visibleProjectList(db: Db, viewer: Viewer): Promise<string[]> {
  const seen = await visibleProjectIds(db, viewer);
  return seen === "all" ? (await db.select({ id: projects.id }).from(projects)).map((p) => p.id) : seen;
}

/** `GET /api/admin/roles`. */
export async function adminRoleViews(db: Db, viewer: Viewer): Promise<AdminRoleView[]> {
  const all = await listRoles(db);
  const visiblePeople = await visiblePersonIds(db, viewer);
  const visibleProjects = new Set(await visibleProjectList(db, viewer));
  const seesPerson = (id: string) => visiblePeople === "all" || visiblePeople.includes(id);
  const instanceHolders = await db.select({ userId: users.id, roleId: users.instanceRoleId }).from(users).where(and(eq(users.isAgent, false)));
  const projectHolders = await db.select({ userId: projectMembers.userId, projectId: projectMembers.projectId, roleId: projectMembers.roleId }).from(projectMembers);
  const promised = await db.selectDistinct({ roleId: inviteProjects.roleId }).from(inviteProjects);
  const heldForNew = await heldForProjectRole(db, viewer, null);
  const views: AdminRoleView[] = [];
  for (const role of all) {
    const isInstance = role.scope === "instance";
    const holdersAll = isInstance
      ? instanceHolders.filter((h) => h.roleId === role.id).map((h) => ({ personId: h.userId, projectId: null as string | null }))
      : projectHolders.filter((h) => h.roleId === role.id).map((h) => ({ personId: h.userId, projectId: h.projectId as string | null }));
    const holders = holdersAll.filter((h) => seesPerson(h.personId) && (h.projectId === null || visibleProjects.has(h.projectId)));
    const applies = !isInstance && (holdersAll.length > 0 || promised.some((p) => p.roleId === role.id));
    const held = isInstance ? viewer.instancePermissions : await heldForProjectRole(db, viewer, role.id);
    const catalog: readonly string[] = isInstance ? INSTANCE_PERMISSIONS : PROJECT_PERMISSIONS;
    views.push({
      id: role.id,
      name: role.name,
      scope: role.scope,
      permissions: role.permissions,
      presetKey: role.presetKey,
      peopleCount: holders.length,
      holders,
      missing: missingToGrant(viewer, role.permissions, held),
      reach: isInstance ? "instance" : applies ? "projects" : "anywhere",
      notGivable: catalog.filter((p) => !role.permissions.includes(p) && missingToGrant(viewer, [p], held).length > 0),
      copyMissing: missingToGrant(viewer, role.permissions, isInstance ? viewer.instancePermissions : heldForNew),
      affectedCount: holdersAll.length,
      fullAdminImplies: isInstance ? INSTANCE_PERMISSIONS.filter((p) => p !== "instance.full_admin") : [],
      deleteBlock: role.presetKey && SYSTEM_PRESET_KEYS.has(role.presetKey) ? "preset" : role.assignmentCount > 0 ? "in_use" : null,
      givesActivityView: role.permissions.includes("people.activity.view") || role.permissions.includes("instance.full_admin"),
    });
  }
  return views;
}

/** I ruoli di progetto con ciò che manca a chi guarda per darli NEL progetto (la regola di `putProjectMember`). */
async function projectRoleChoices(db: Db, viewer: Viewer, held: ReadonlySet<string>): Promise<RoleChoice[]> {
  const rows = await db.select({ id: roles.id, name: roles.name, permissions: roles.permissions }).from(roles).where(eq(roles.scope, "project")).orderBy(asc(roles.name));
  return rows.map((r) => ({ roleId: r.id, name: r.name, permissionCount: r.permissions.length, missing: missingToGrant(viewer, r.permissions, held) }));
}

/** `GET /api/admin/invites`: gli inviti pendenti, coi soli progetti visibili; l'id è opaco. */
export async function inviteViews(db: Db, viewer: Viewer): Promise<InviteView[]> {
  const visible = new Set(await visibleProjectList(db, viewer));
  const instanceRoles = alias(roles, "instance_role");
  const rows = await db
    .select({ token: invites.token, email: invites.email, createdAt: invites.createdAt, expiresAt: invites.expiresAt, roleId: instanceRoles.id, roleName: instanceRoles.name, by: invites.invitedByUserId, byName: granters.displayName, byEmail: granters.email })
    .from(invites)
    .leftJoin(instanceRoles, eq(instanceRoles.id, invites.instanceRoleId))
    .leftJoin(granters, eq(granters.id, invites.invitedByUserId))
    .orderBy(asc(invites.createdAt));
  const grants = rows.length
    ? await db
        .select({ token: inviteProjects.inviteToken, projectId: projects.id, code: projects.code, roleId: roles.id, roleName: roles.name })
        .from(inviteProjects)
        .innerJoin(projects, eq(projects.id, inviteProjects.projectId))
        .innerJoin(roles, eq(roles.id, inviteProjects.roleId))
        .where(inArray(inviteProjects.inviteToken, rows.map((r) => r.token)))
    : [];
  return rows.map((r) => ({
    id: inviteIdOf(r.token),
    email: r.email,
    instanceRole: r.roleId && r.roleName ? { id: r.roleId, name: r.roleName } : null,
    projects: grants.filter((g) => g.token === r.token && visible.has(g.projectId)).map(({ projectId, code, roleId, roleName }) => ({ projectId, code, roleId, roleName })),
    invitedById: r.by,
    invitedByName: r.byEmail ? nameOf({ displayName: r.byName, email: r.byEmail }) : null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    expired: r.expiresAt.getTime() <= Date.now(),
  }));
}

/** Il token di un invito dal suo id opaco (la revoca da `DELETE /api/admin/invites/:id`), o null. */
export async function inviteTokenOf(db: Db, id: string): Promise<string | null> {
  const rows = await db.select({ token: invites.token }).from(invites);
  return rows.find((r) => inviteIdOf(r.token) === id)?.token ?? null;
}

/** `GET /api/admin/invite-choices`: le scelte del dialogo, con la regola di `assertInviteGrants`. */
export async function inviteChoices(db: Db, viewer: Viewer): Promise<InviteChoices> {
  const projectIds = await visibleProjectList(db, viewer);
  const managed = await managedProjectIds(db, viewer, projectIds);
  const [userPreset] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.presetKey, "user"), eq(roles.scope, "instance")));
  const list = managed.size ? await db.select({ id: projects.id, code: projects.code, name: projects.name }).from(projects).where(inArray(projects.id, [...managed])).orderBy(asc(projects.code)) : [];
  const projectsChoices = [];
  for (const p of list) {
    const held = (await projectPermissionsFor(db, viewer, p.id)) ?? new Set<string>();
    projectsChoices.push({ projectId: p.id, code: p.code, name: p.name, roles: await projectRoleChoices(db, viewer, held) });
  }
  return { instanceRoles: await instanceRoleChoicesFor(db, viewer), defaultInstanceRoleId: userPreset?.id ?? null, projects: projectsChoices };
}

interface MemberState {
  personId: string;
  email: string;
  displayName: string | null;
  deactivatedAt: Date | null;
  roleId: string;
  roleName: string;
  rolePermissions: string[];
}

async function membersOf(db: Db, projectId: string): Promise<MemberState[]> {
  const memberRoles = alias(roles, "member_role");
  return db
    .select({ personId: users.id, email: users.email, displayName: users.displayName, deactivatedAt: users.deactivatedAt, roleId: memberRoles.id, roleName: memberRoles.name, rolePermissions: memberRoles.permissions })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .innerJoin(memberRoles, eq(memberRoles.id, projectMembers.roleId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(users.email));
}

async function grantsIn(db: Db, projectId: string, userId?: string) {
  return db
    .select({ userId: projectMemberPermissions.userId, permission: projectMemberPermissions.permission, by: projectMemberPermissions.grantedByUserId, at: projectMemberPermissions.grantedAt, byName: granters.displayName, byEmail: granters.email })
    .from(projectMemberPermissions)
    .leftJoin(granters, eq(granters.id, projectMemberPermissions.grantedByUserId))
    .where(and(eq(projectMemberPermissions.projectId, projectId), ...(userId ? [eq(projectMemberPermissions.userId, userId)] : [])));
}

function grantSource(g: { by: string | null; at: Date; byName: string | null; byEmail: string | null }, origin: "given" | "seed" | "draft" = g.by ? "given" : "seed"): SourceView {
  return { kind: "grant", roleId: null, roleName: null, grantedById: g.by, grantedByName: g.byEmail ? nameOf({ displayName: g.byName, email: g.byEmail }) : null, at: g.at.toISOString(), origin, departmentId: null, departmentName: null };
}
const roleSource = (id: string, name: string): SourceView => ({ kind: "role", roleId: id, roleName: name, grantedById: null, grantedByName: null, at: null, origin: null, departmentId: null, departmentName: null });

/** `GET /api/projects/:projectId/members/view`. Progetto invisibile: 404 (lo fa la rotta, `config.access`). */
export async function projectMembersView(db: Db, viewer: Viewer, projectId: string): Promise<ProjectMembersView> {
  const held = (await projectPermissionsFor(db, viewer, projectId)) ?? new Set<string>();
  const canManage = held.has("project.members.manage");
  const members = await membersOf(db, projectId);
  const grants = await grantsIn(db, projectId);
  const avatars = await avatarUrlsFor(db, members.map((m) => m.personId));
  const memberIds = new Set(members.map((m) => m.personId));
  const addable = canManage
    ? (await db.select({ id: users.id, permissions: roles.permissions }).from(users).innerJoin(roles, eq(roles.id, users.instanceRoleId)).where(and(eq(users.isAgent, false), isNull(users.deactivatedAt))))
        .filter((u) => !memberIds.has(u.id) && !u.permissions.includes("instance.full_admin"))
        .map((u) => u.id)
    : [];
  const visiblePeople = await visiblePersonIds(db, viewer);
  const addableVisible = visiblePeople === "all" ? addable : addable.filter((id) => visiblePeople.includes(id));
  return {
    projectId,
    members: members.map((m) => {
      const mine = grants.filter((g) => g.userId === m.personId);
      return {
        personId: m.personId,
        name: nameOf(m),
        email: m.email,
        avatarUrl: avatars.get(m.personId) ?? null,
        status: m.deactivatedAt ? ("deactivated" as const) : ("active" as const),
        role: { id: m.roleId, name: m.roleName, permissions: m.rolePermissions },
        extra: mine.filter((g) => !m.rolePermissions.includes(g.permission)).map((g) => ({ permission: g.permission, sources: [grantSource(g)], granted: true })),
        granted: mine.map((g) => g.permission),
      };
    }),
    fullAdminNote: true,
    canManage,
    roleChoices: canManage ? await projectRoleChoices(db, viewer, held) : [],
    grantable: PROJECT_PERMISSIONS.map((permission) => ({ permission, allowed: canManage && missingToGrant(viewer, [permission], held).length === 0 })),
    // Le persone aggiungibili entrano senza reparti con permessi (F8): niente manca.
    addable: addableVisible,
    addableMissing: Object.fromEntries(addableVisible.map((id) => [id, [] as string[]])),
  };
}

/**
 * `POST /api/projects/:projectId/members/:userId/preview`: il giudizio di una
 * bozza (ruolo + permessi dati a mano), lo stesso che `putProjectMember`
 * applica salvando: escalation sul ruolo e sugli AGGIUNTI, l'ultimo gestore.
 */
export async function previewMember(db: Db, viewer: Viewer, projectId: string, userId: string, draft: { roleId: string; granted: string[] }): Promise<MemberPreview> {
  const held = (await projectPermissionsFor(db, viewer, projectId)) ?? new Set<string>();
  const [role] = await db.select({ id: roles.id, name: roles.name, permissions: roles.permissions, scope: roles.scope }).from(roles).where(eq(roles.id, draft.roleId));
  if (!role || role.scope !== "project") throw new RoleRuleError(404, "role_not_found", "Role not found");
  const [target] = await db.select({ id: users.id, deactivatedAt: users.deactivatedAt }).from(users).where(eq(users.id, userId));
  if (!target) throw new RoleRuleError(404, "user_not_found", "User not found");
  const saved = await grantsIn(db, projectId, userId);
  const had = new Set(saved.map((g) => g.permission));
  const wanted = [...new Set(draft.granted)].filter((p) => (PROJECT_PERMISSIONS as readonly string[]).includes(p));
  const added = wanted.filter((p) => !had.has(p));
  const sourcesOf = new Map<string, SourceView[]>();
  const push = (p: string, s: SourceView) => sourcesOf.set(p, [...(sourcesOf.get(p) ?? []), s]);
  for (const p of role.permissions) push(p, roleSource(role.id, role.name));
  for (const p of wanted) {
    const g = saved.find((x) => x.permission === p);
    push(p, g ? grantSource(g) : grantSource({ by: viewer.id, at: new Date(), byName: null, byEmail: null }, "draft"));
  }
  const after = new Set([...role.permissions, ...wanted]);
  // L'ultimo gestore: la bozza toglie la gestione dei membri all'ultimo gestore attivo?
  const losesManage = !after.has("project.members.manage") && !target.deactivatedAt && (await lastManagerProjectOf(db, userId, [projectId])) !== null;
  const viewerHas = viewer.id === userId ? [...held].filter((p) => !after.has(p) && !viewer.instancePermissions.has("instance.full_admin")) : [];
  return {
    permissions: PROJECT_PERMISSIONS.filter((p) => sourcesOf.has(p)).map((p) => ({ permission: p, sources: sourcesOf.get(p)! })),
    removing: saved.filter((g) => !wanted.includes(g.permission)).map((g) => ({ permission: g.permission, source: grantSource(g) })),
    roleChoices: await projectRoleChoices(db, viewer, held),
    missing: [...new Set([...missingToGrant(viewer, role.permissions, held), ...missingToGrant(viewer, added, held)])],
    block: losesManage ? "last_members_manager" : null,
    removeBlock: !target.deactivatedAt && (await lastManagerProjectOf(db, userId, [projectId])) !== null ? "last_members_manager" : null,
    viewerLoses: viewerHas,
  };
}
