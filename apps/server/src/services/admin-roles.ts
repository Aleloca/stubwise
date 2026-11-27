import { departmentGrantsOf, type DepartmentGrant } from "./department-access.js";
import { inviteProjects, invites, inviteWorkspaces, projectAccess, projectAccessRowCounts, projectMemberPermissions, projectMembers, projects, roles, users, workspaceProjects, workspaces, type Db } from "@stubwise/db";
import {
  effectiveInstancePermissions,
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
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { projectPermissionsFor, projectPermissionsMap, scopeProjectIds, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { instanceRoleChoicesFor, inviteIdOf, managedProjectIds, nameOf } from "./admin-people.js";
import { avatarUrlsFor } from "./avatars.js";
import { visiblePersonIds } from "./people-visibility.js";
import { actorProjectPermissions, heldOver, lastManagerProjectOf, listRoles, missingToGrant, RoleRuleError } from "./roles.js";
import { listWorkspaces } from "./workspaces.js";

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
  return await scopeProjectIds(db, seen);
}

/** `GET /api/admin/roles`. */
export async function adminRoleViews(db: Db, viewer: Viewer): Promise<AdminRoleView[]> {
  const all = await listRoles(db);
  const visiblePeople = await visiblePersonIds(db, viewer);
  const visibleProjects = new Set(await visibleProjectList(db, viewer));
  const seesPerson = (id: string) => visiblePeople === "all" || visiblePeople.includes(id);
  const instanceHolders = await db.select({ userId: users.id, roleId: users.instanceRoleId }).from(users).where(and(eq(users.isAgent, false)));
  // Chi ha un ruolo di progetto, e dove: membri espliciti e persone di workspace
  // (0238), una volta per persona e progetto. Le promesse: gli inviti ai
  // progetti e alle workspace (la stessa regola di `projectsOfRole`).
  const projectHolders = await db
    .selectDistinct({ userId: projectAccess.userId, projectId: projectAccess.projectId, roleId: projectAccess.roleId })
    .from(projectAccess)
    .where(projectAccessRowCounts);
  const promised = [
    ...(await db.selectDistinct({ roleId: inviteProjects.roleId, projectId: inviteProjects.projectId }).from(inviteProjects)),
    ...(await db
      .selectDistinct({ roleId: inviteWorkspaces.roleId, projectId: workspaceProjects.projectId })
      .from(inviteWorkspaces)
      .innerJoin(workspaceProjects, eq(workspaceProjects.workspaceId, inviteWorkspaces.workspaceId))),
  ];
  // Review (M6): i permessi di chi guarda progetto per progetto, letti UNA volta.
  const byProject = await actorProjectPermissions(db, viewer);
  const heldForNew = heldOver(byProject, []);
  const views: AdminRoleView[] = [];
  for (const role of all) {
    const isInstance = role.scope === "instance";
    const holdersAll = isInstance
      ? instanceHolders.filter((h) => h.roleId === role.id).map((h) => ({ personId: h.userId, projectId: null as string | null }))
      : projectHolders.filter((h) => h.roleId === role.id).map((h) => ({ personId: h.userId, projectId: h.projectId as string | null }));
    const holders = holdersAll.filter((h) => seesPerson(h.personId) && (h.projectId === null || visibleProjects.has(h.projectId)));
    const assigned = isInstance
      ? []
      : [...new Set([...holdersAll.map((h) => h.projectId!), ...promised.filter((p) => p.roleId === role.id).map((p) => p.projectId)])];
    const applies = !isInstance && assigned.length > 0;
    const held = isInstance ? viewer.instancePermissions : heldOver(byProject, assigned);
    const catalog: readonly string[] = isInstance ? INSTANCE_PERMISSIONS : PROJECT_PERMISSIONS;
    // Review (M4): un ruolo d'istanza vale per i suoi permessi EFFETTIVI (il full admin li ha tutti).
    const content: string[] = isInstance ? [...effectiveInstancePermissions(role.permissions)] : role.permissions;
    views.push({
      id: role.id,
      name: role.name,
      scope: role.scope,
      permissions: role.permissions,
      presetKey: role.presetKey,
      peopleCount: holders.length,
      holders,
      missing: missingToGrant(viewer, content, held),
      reach: isInstance ? "instance" : applies ? "projects" : "anywhere",
      notGivable: catalog.filter((p) => !content.includes(p) && missingToGrant(viewer, [p], held).length > 0),
      copyMissing: missingToGrant(viewer, content, isInstance ? viewer.instancePermissions : heldForNew),
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
  return rows.map((r) => roleChoiceOf(viewer, r, held));
}

const roleChoiceOf = (viewer: Viewer, r: { id: string; name: string; permissions: string[] }, held: ReadonlySet<string>): RoleChoice => ({
  roleId: r.id,
  name: r.name,
  permissionCount: r.permissions.length,
  missing: missingToGrant(viewer, r.permissions, held),
  block: null,
});

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
  // Workspace (D9): le workspace promesse, solo quelle che chi guarda vede.
  const seenWorkspaces = new Set((await listWorkspaces(db, viewer)).map((w) => w.id));
  const promisedWorkspaces = rows.length
    ? await db
        .select({ token: inviteWorkspaces.inviteToken, workspaceId: workspaces.id, name: workspaces.name, roleId: roles.id, roleName: roles.name })
        .from(inviteWorkspaces)
        .innerJoin(workspaces, eq(workspaces.id, inviteWorkspaces.workspaceId))
        .innerJoin(roles, eq(roles.id, inviteWorkspaces.roleId))
        .where(inArray(inviteWorkspaces.inviteToken, rows.map((r) => r.token)))
        .orderBy(asc(workspaces.name))
    : [];
  return rows.map((r) => ({
    id: inviteIdOf(r.token),
    email: r.email,
    instanceRole: r.roleId && r.roleName ? { id: r.roleId, name: r.roleName } : null,
    projects: grants.filter((g) => g.token === r.token && visible.has(g.projectId)).map(({ projectId, code, roleId, roleName }) => ({ projectId, code, roleId, roleName })),
    workspaces: promisedWorkspaces.filter((w) => w.token === r.token && seenWorkspaces.has(w.workspaceId)).map(({ workspaceId, name, roleId, roleName }) => ({ workspaceId, name, roleId, roleName })),
    invitedById: r.by,
    invitedByName: r.byEmail ? nameOf({ displayName: r.byName, email: r.byEmail }) : null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    expired: r.expiresAt.getTime() <= Date.now(),
  }));
}

/** Il token di un invito dal suo id opaco (la revoca da `DELETE /api/admin/invites/:id`), o null. */
export async function inviteTokenOf(db: Db, id: string): Promise<string | null> {
  // Review (M6): la stessa derivazione di `inviteIdOf`, nella WHERE.
  const [row] = await db
    .select({ token: invites.token })
    .from(invites)
    .where(sql`'i_' || left(encode(sha256(('invite:' || ${invites.token})::bytea), 'hex'), 32) = ${id}`);
  return row && inviteIdOf(row.token) === id ? row.token : null;
}

/** `GET /api/admin/invite-choices`: le scelte del dialogo, con la regola di `assertInviteGrants`. */
export async function inviteChoices(db: Db, viewer: Viewer): Promise<InviteChoices> {
  const projectIds = await visibleProjectList(db, viewer);
  const managed = await managedProjectIds(db, viewer, projectIds);
  const [userPreset] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.presetKey, "user"), eq(roles.scope, "instance")));
  const list = managed.size ? await db.select({ id: projects.id, code: projects.code, name: projects.name }).from(projects).where(inArray(projects.id, [...managed])).orderBy(asc(projects.code)) : [];
  // Review (M6): i ruoli e i permessi per progetto letti UNA volta.
  const projectRoles = await db.select({ id: roles.id, name: roles.name, permissions: roles.permissions }).from(roles).where(eq(roles.scope, "project")).orderBy(asc(roles.name));
  const perProject = await projectPermissionsMap(db, viewer);
  // Gli archiviati compresi: l'escalation di una workspace li giudica (come la scrittura).
  const perPermissionsAll = await projectPermissionsMap(db, viewer, { includeArchived: true });
  const projectsChoices = list.map((p) => {
    const held = new Set<string>(perProject[p.id] ?? []);
    return { projectId: p.id, code: p.code, name: p.name, roles: projectRoles.map((r) => roleChoiceOf(viewer, r, held)) };
  });
  // Workspace (lotto 4): dove chi invita gestisce le persone; i ruoli col giudizio
  // su TUTTI i progetti della workspace (una vuota: nessun progetto da giudicare).
  const [viewerPreset] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.presetKey, "viewer"), eq(roles.scope, "project")));
  const workspaceChoices = [];
  for (const w of (await listWorkspaces(db, viewer)).filter((x) => x.canManagePeople)) {
    const ids = (await db.select({ id: workspaceProjects.projectId }).from(workspaceProjects).where(eq(workspaceProjects.workspaceId, w.id))).map((r) => r.id);
    const held = new Set<string>(ids.length === 0 ? PROJECT_PERMISSIONS : PROJECT_PERMISSIONS.filter((perm) => ids.every((id) => (perPermissionsAll[id] ?? []).includes(perm as never))));
    workspaceChoices.push({ workspaceId: w.id, name: w.name, roles: projectRoles.map((r) => roleChoiceOf(viewer, r, held)), defaultRoleId: viewerPreset?.id ?? null });
  }
  return { instanceRoles: await instanceRoleChoicesFor(db, viewer), defaultInstanceRoleId: userPreset?.id ?? null, projects: projectsChoices, workspaces: workspaceChoices };
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
  return { kind: "grant", roleId: null, roleName: null, grantedById: g.by, grantedByName: g.byEmail ? nameOf({ displayName: g.byName, email: g.byEmail }) : null, at: g.at.toISOString(), origin, departmentId: null, departmentName: null, workspaceId: null, workspaceName: null };
}
const departmentSource = (g: DepartmentGrant): SourceView => ({ kind: "department", roleId: null, roleName: null, grantedById: null, grantedByName: null, at: null, origin: null, departmentId: g.departmentId, departmentName: g.departmentName, workspaceId: null, workspaceName: null });
const roleSource = (id: string, name: string): SourceView => ({ kind: "role", roleId: id, roleName: name, grantedById: null, grantedByName: null, at: null, origin: null, departmentId: null, departmentName: null, workspaceId: null, workspaceName: null });
/** Workspace (lotto 4): un permesso del ruolo di workspace. */
const workspaceSource = (w: { workspaceId: string; workspaceName: string; roleId: string; roleName: string }): SourceView => ({
  kind: "workspace",
  roleId: w.roleId,
  roleName: w.roleName,
  grantedById: null,
  grantedByName: null,
  at: null,
  origin: null,
  departmentId: null,
  departmentName: null,
  workspaceId: w.workspaceId,
  workspaceName: w.workspaceName,
});

/** Chi accede a un progetto per workspace, col ruolo di workspace (una riga per persona e workspace). */
async function workspaceAccessIn(db: Db, projectId: string, userId?: string) {
  const wsRoles = alias(roles, "ws_role");
  return db
    .select({
      personId: users.id,
      email: users.email,
      displayName: users.displayName,
      deactivatedAt: users.deactivatedAt,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      roleId: wsRoles.id,
      roleName: wsRoles.name,
      rolePermissions: wsRoles.permissions,
    })
    .from(projectAccess)
    .innerJoin(users, eq(users.id, projectAccess.userId))
    .innerJoin(workspaces, eq(workspaces.id, projectAccess.workspaceId))
    .innerJoin(wsRoles, eq(wsRoles.id, projectAccess.roleId))
    .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.source, "workspace"), eq(users.isAgent, false), ...(userId ? [eq(projectAccess.userId, userId)] : [])))
    .orderBy(asc(users.email));
}

/** I permessi in più del ruolo di un membro, ognuno con le sue fonti (concessione, reparto). */
function extraOf(
  rolePermissions: readonly string[],
  grants: { permission: string; by: string | null; at: Date; byName: string | null; byEmail: string | null }[],
  fromDepartments: readonly DepartmentGrant[],
) {
  const out = new Map<string, { permission: string; sources: SourceView[]; granted: boolean }>();
  for (const g of grants) {
    if (rolePermissions.includes(g.permission)) continue;
    const e = out.get(g.permission) ?? { permission: g.permission, sources: [], granted: true };
    e.sources.push(grantSource(g));
    e.granted = true;
    out.set(g.permission, e);
  }
  for (const g of fromDepartments) {
    if (rolePermissions.includes(g.permission)) continue;
    const e = out.get(g.permission) ?? { permission: g.permission, sources: [], granted: false };
    e.sources.push(departmentSource(g));
    out.set(g.permission, e);
  }
  return PROJECT_PERMISSIONS.filter((p) => out.has(p)).map((p) => out.get(p)!);
}

/** `GET /api/projects/:projectId/members/view`. Progetto invisibile: 404 (lo fa la rotta, `config.access`). */
export async function projectMembersView(db: Db, viewer: Viewer, projectId: string): Promise<ProjectMembersView> {
  const held = (await projectPermissionsFor(db, viewer, projectId)) ?? new Set<string>();
  const canManage = held.has("project.members.manage");
  const members = await membersOf(db, projectId);
  const grants = await grantsIn(db, projectId);
  // Workspace (lotto 4): chi lo vede dalla workspace; chi è SOLO lì ha una riga sua.
  const viaWorkspace = await workspaceAccessIn(db, projectId);
  const workspaceOnly = viaWorkspace.filter((w, i) => !members.some((m) => m.personId === w.personId) && viaWorkspace.findIndex((x) => x.personId === w.personId) === i);
  const fromDepartments = await departmentGrantsOf(db, [...members.map((m) => m.personId), ...workspaceOnly.map((w) => w.personId)]);
  const avatars = await avatarUrlsFor(db, [...members.map((m) => m.personId), ...workspaceOnly.map((w) => w.personId)]);
  const workspaceOf = (personId: string) => {
    const w = viaWorkspace.find((x) => x.personId === personId);
    return w ? { workspaceId: w.workspaceId, workspaceName: w.workspaceName, roleName: w.roleName } : null;
  };
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
        // I permessi in più del ruolo, con le fonti: le concessioni e (F8) i reparti.
        extra: extraOf(
          m.rolePermissions,
          mine,
          fromDepartments.filter((g) => g.userId === m.personId),
        ),
        granted: mine.map((g) => g.permission),
        workspace: workspaceOf(m.personId),
        explicit: true,
      };
    }).concat(
      workspaceOnly.map((w) => ({
        personId: w.personId,
        name: nameOf(w),
        email: w.email,
        avatarUrl: avatars.get(w.personId) ?? null,
        status: w.deactivatedAt ? ("deactivated" as const) : ("active" as const),
        // Lo vede SOLO dalla workspace: il ruolo è quello di workspace.
        role: { id: w.roleId, name: w.roleName, permissions: w.rolePermissions },
        extra: extraOf(w.rolePermissions, [], fromDepartments.filter((g) => g.userId === w.personId)),
        granted: [],
        workspace: { workspaceId: w.workspaceId, workspaceName: w.workspaceName, roleName: w.roleName },
        explicit: false,
      })),
    ),
    fullAdminNote: true,
    canManage,
    roleChoices: canManage ? await projectRoleChoices(db, viewer, held) : [],
    grantable: PROJECT_PERMISSIONS.map((permission) => ({ permission, allowed: canManage && missingToGrant(viewer, [permission], held).length === 0 })),
    addable: addableVisible,
    // Area 9, F8 (F8-4 = a): chi entra porta i permessi dei suoi reparti; quelli che
    // chi guarda non ha qui spengono la persona (lo stesso rifiuto del salvataggio).
    addableMissing: await (async () => {
      // Revisione del lotto 4 (M-3): chi vede già il progetto dalla workspace ha già lì i suoi reparti
      // (`putProjectMember`, `alreadyIn`): aggiungerlo come override non li porta.
      const alreadyIn = new Set(workspaceOnly.map((w) => w.personId));
      const brought = (await departmentGrantsOf(db, addableVisible)).filter((g) => !alreadyIn.has(g.userId));
      return Object.fromEntries(addableVisible.map((id) => [id, missingToGrant(viewer, [...new Set(brought.filter((g) => g.userId === id).map((g) => g.permission))], held)]));
    })(),
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
  // Review (M1): gli stessi rifiuti del salvataggio — Claude non esiste come
  // membro (404, come la rotta), un permesso sconosciuto è 422, e un
  // disattivato non entra (`block: user_deactivated`, la 422 del PUT).
  const [target] = await db.select({ id: users.id, deactivatedAt: users.deactivatedAt, isAgent: users.isAgent }).from(users).where(eq(users.id, userId));
  if (!target || target.isAgent) throw new RoleRuleError(404, "user_not_found", "User not found");
  const unknown = [...new Set(draft.granted)].filter((p) => !(PROJECT_PERMISSIONS as readonly string[]).includes(p));
  if (unknown.length > 0) throw new RoleRuleError(422, "unknown_permission", `Not a project permission: ${unknown[0]}`, { permission: unknown[0]! });
  const saved = await grantsIn(db, projectId, userId);
  const had = new Set(saved.map((g) => g.permission));
  const wanted = [...new Set(draft.granted)];
  const added = wanted.filter((p) => !had.has(p));
  const sourcesOf = new Map<string, SourceView[]>();
  const push = (p: string, s: SourceView) => sourcesOf.set(p, [...(sourcesOf.get(p) ?? []), s]);
  for (const p of role.permissions) push(p, roleSource(role.id, role.name));
  for (const p of wanted) {
    const g = saved.find((x) => x.permission === p);
    push(p, g ? grantSource(g) : grantSource({ by: viewer.id, at: new Date(), byName: null, byEmail: null }, "draft"));
  }
  // Area 9, F8: i permessi dei reparti della persona, che valgono qui se è (o diventa) membro.
  const fromDepartments = await departmentGrantsOf(db, [userId]);
  for (const g of fromDepartments) push(g.permission, departmentSource(g));
  // Chi accede già al progetto (membro esplicito o per workspace, 0238): i suoi
  // reparti valgono già qui, e il ruolo di workspace resta comunque (D1, l'unione).
  const access = await db
    .select({ source: projectAccess.source, permissions: roles.permissions })
    .from(projectAccess)
    .innerJoin(roles, eq(roles.id, projectAccess.roleId))
    .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, userId), projectAccessRowCounts));
  // Workspace (lotto 4): la fonte `workspace` dei permessi del ruolo di workspace.
  for (const w of await workspaceAccessIn(db, projectId, userId)) for (const p of w.rolePermissions) push(p, workspaceSource(w));
  const isMember = access.length > 0;
  const fromWorkspace = access.filter((a) => a.source === "workspace").flatMap((a) => a.permissions);
  const viaWorkspace = access.some((a) => a.source === "workspace");
  const keepsManageWithoutRow =
    viaWorkspace && (fromWorkspace.includes("project.members.manage") || fromDepartments.some((g) => g.permission === "project.members.manage"));
  const after = new Set([...role.permissions, ...wanted, ...fromDepartments.map((g) => g.permission), ...fromWorkspace]);
  // L'ultimo gestore: la bozza toglie la gestione dei membri all'ultimo gestore attivo?
  const losesManage = !after.has("project.members.manage") && !target.deactivatedAt && (await lastManagerProjectOf(db, userId, [projectId])) !== null;
  const viewerHas = viewer.id === userId ? [...held].filter((p) => !after.has(p) && !viewer.instancePermissions.has("instance.full_admin")) : [];
  return {
    permissions: PROJECT_PERMISSIONS.filter((p) => sourcesOf.has(p)).map((p) => ({ permission: p, sources: sourcesOf.get(p)! })),
    removing: saved.filter((g) => !wanted.includes(g.permission)).map((g) => ({ permission: g.permission, source: grantSource(g) })),
    roleChoices: await projectRoleChoices(db, viewer, held),
    missing: [
      ...new Set([
        ...missingToGrant(viewer, role.permissions, held),
        ...missingToGrant(viewer, added, held),
        // F8-4 = a: chi ENTRA porta i permessi dei suoi reparti (lo stesso rifiuto di `putProjectMember`).
        ...(isMember ? [] : missingToGrant(viewer, fromDepartments.map((g) => g.permission), held)),
      ]),
    ],
    // Un codice solo, quello della scrittura (M7).
    block: target.deactivatedAt ? "user_deactivated" : losesManage ? "last_manager" : null,
    // Togliere il membro ESPLICITO lascia ciò che viene dalla workspace (0238):
    // se lì resta gestore, la rimozione non toglie l'ultimo gestore.
    removeBlock:
      !target.deactivatedAt && !keepsManageWithoutRow && (await lastManagerProjectOf(db, userId, [projectId])) !== null ? "last_manager" : null,
    viewerLoses: viewerHas,
  };
}
