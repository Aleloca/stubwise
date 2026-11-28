import { departmentGrantsOf, type DepartmentGrant } from "./department-access.js";
import { projectAccess, projectAccessPermissionsSql, projectAccessRowCounts, projectMemberPermissions, projectMembers, projects, roles, users, workspaces, type Db } from "@stubwise/db";
import {
  effectiveInstancePermissions,
  effectiveProjectPermissions,
  INSTANCE_PERMISSIONS,
  PROJECT_PERMISSIONS,
  type AccessReason,
  type InstancePermission,
  type PermissionWithReasons,
  type ProjectPermission,
  type WhatCanResponse,
  type WhoCanPerson,
  type WhoCanResponse,
} from "@stubwise/shared";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { projectPermissionsFor, scopeProjectIds, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { visiblePersonIds } from "./people-visibility.js";
import { RoleRuleError } from "./roles.js";

/**
 * Area 9, F1 (design 1.7, D-11): «Chi può farlo?» e «Cosa può fare?».
 *
 * L'avere o no un permesso viene dalle STESSE funzioni di `can()`:
 * `effectiveInstancePermissions` per l'istanza, `memberPermissionsSql` +
 * `effectiveProjectPermissions` per un progetto (docs/invariants/permissions.md,
 * «I permessi effettivi in un progetto sono UNA funzione»). I motivi li
 * affiancano, e un test d'accordo prova che `who-can` ⇔ `can()` su ogni coppia.
 * Le persone disattivate non compaiono; chi guarda vede solo le persone che vede
 * in `/api/people` e i progetti che vede.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type AnyPermission = InstancePermission | ProjectPermission;

const INSTANCE_SET: ReadonlySet<string> = new Set(INSTANCE_PERMISSIONS);
const PROJECT_SET: ReadonlySet<string> = new Set(PROJECT_PERMISSIONS);
export const isInstancePermission = (p: string): p is InstancePermission => INSTANCE_SET.has(p);
export const isKnownPermission = (p: string): p is AnyPermission => INSTANCE_SET.has(p) || PROJECT_SET.has(p);

const reason = (kind: AccessReason["kind"], extra: Partial<AccessReason> = {}): AccessReason => ({
  kind,
  roleId: null,
  roleName: null,
  byUserId: null,
  at: null,
  departmentId: null,
  departmentName: null,
  workspaceId: null,
  workspaceName: null,
  ...extra,
});

const instanceRoles = alias(roles, "instance_role");
const memberRoles = alias(roles, "member_role");

interface Person {
  id: string;
  email: string;
  displayName: string | null;
  instanceRoleId: string;
  instanceRoleName: string;
  instanceRolePermissions: string[];
}

const personColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  instanceRoleId: instanceRoles.id,
  instanceRoleName: instanceRoles.name,
  instanceRolePermissions: instanceRoles.permissions,
};

/** I permessi d'istanza di una persona, coi motivi. */
function instanceWithReasons(person: Person): PermissionWithReasons[] {
  const effective = effectiveInstancePermissions(person.instanceRolePermissions);
  const fullAdmin = person.instanceRolePermissions.includes("instance.full_admin");
  return INSTANCE_PERMISSIONS.filter((p) => effective.has(p)).map((permission) => ({
    permission,
    reasons: [
      ...(fullAdmin && permission !== "instance.full_admin" ? [reason("full_admin")] : []),
      ...(person.instanceRolePermissions.includes(permission)
        ? [reason("role", { roleId: person.instanceRoleId, roleName: person.instanceRoleName })]
        : []),
    ],
  }));
}

interface Membership {
  projectId: string;
  userId: string;
  roleId: string | null;
  roleName: string | null;
  rolePermissions: string[] | null;
  /** Ruolo ∪ personali, da `memberPermissionsSql`: null se non membro. */
  memberPermissions: string[] | null;
  /** Workspace (lotto 4): i ruoli di workspace della persona in questo progetto, per il motivo «workspace». */
  workspaceRoles: { workspaceId: string; workspaceName: string; roleId: string; roleName: string; permissions: string[] }[];
}

/** I permessi di progetto di una persona in un progetto, coi motivi. */
function projectWithReasons(
  person: Person,
  membership: Membership | undefined,
  grants: { permission: string; grantedByUserId: string | null; grantedAt: Date }[],
  departmentGrants: readonly DepartmentGrant[] = [],
): PermissionWithReasons[] | null {
  const effective = effectiveProjectPermissions(
    effectiveInstancePermissions(person.instanceRolePermissions),
    membership?.memberPermissions ?? null,
  );
  if (!effective) return null;
  const fullAdmin = person.instanceRolePermissions.includes("instance.full_admin");
  return PROJECT_PERMISSIONS.filter((p) => effective.has(p)).map((permission) => ({
    permission,
    reasons: [
      ...(fullAdmin ? [reason("full_admin")] : []),
      ...(membership?.rolePermissions?.includes(permission)
        ? [reason("role", { roleId: membership.roleId, roleName: membership.roleName })]
        : []),
      ...grants
        .filter((g) => g.permission === permission)
        .map((g) => reason("grant", { byUserId: g.grantedByUserId, at: g.grantedAt.toISOString() })),
      // Workspace (lotto 4): «dalla workspace <nome>», col ruolo di workspace.
      ...(membership?.workspaceRoles ?? [])
        .filter((w) => w.permissions.includes(permission))
        .map((w) => reason("workspace", { workspaceId: w.workspaceId, workspaceName: w.workspaceName, roleId: w.roleId, roleName: w.roleName })),
      // Area 9, F8: «via <reparto>», solo se è membro (un reparto non rende
      // membri); membro anche per workspace (0239, D10).
      ...(membership?.memberPermissions
        ? departmentGrants.filter((g) => g.permission === permission).map((g) => reason("department", { departmentId: g.departmentId, departmentName: g.departmentName }))
        : []),
    ],
  }));
}

/**
 * Chi accede ai progetti (membri espliciti e, 0239, persone di workspace), una
 * riga per persona e progetto: i permessi effettivi sono l'unione delle fonti;
 * il ruolo (`role*`) è quello del membro ESPLICITO, null per chi accede solo
 * per workspace (il motivo «workspace» lo aggiunge il lotto 4 delle workspace).
 */
async function memberships(db: Db, projectIds: readonly string[], userIds?: readonly string[]): Promise<Membership[]> {
  if (projectIds.length === 0) return [];
  const access = db
    .selectDistinct({ projectId: projectAccess.projectId, userId: projectAccess.userId })
    .from(projectAccess)
    .where(and(inArray(projectAccess.projectId, [...projectIds]), projectAccessRowCounts, ...(userIds ? [inArray(projectAccess.userId, [...userIds])] : [])))
    .as("ma");
  const rows = await db
    .select({
      projectId: access.projectId,
      userId: access.userId,
      roleId: memberRoles.id,
      roleName: memberRoles.name,
      rolePermissions: memberRoles.permissions,
      memberPermissions: projectAccessPermissionsSql(access.projectId, access.userId),
    })
    .from(access)
    .leftJoin(projectMembers, and(eq(projectMembers.projectId, access.projectId), eq(projectMembers.userId, access.userId)))
    .leftJoin(memberRoles, eq(memberRoles.id, projectMembers.roleId));
  const viaWorkspace = await db
    .select({
      projectId: projectAccess.projectId,
      userId: projectAccess.userId,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      roleId: memberRoles.id,
      roleName: memberRoles.name,
      permissions: memberRoles.permissions,
    })
    .from(projectAccess)
    .innerJoin(workspaces, eq(workspaces.id, projectAccess.workspaceId))
    .innerJoin(memberRoles, eq(memberRoles.id, projectAccess.roleId))
    .where(
      and(
        eq(projectAccess.source, "workspace"),
        inArray(projectAccess.projectId, [...projectIds]),
        projectAccessRowCounts,
        ...(userIds ? [inArray(projectAccess.userId, [...userIds])] : []),
      ),
    );
  return rows.map((r) => ({
    ...r,
    workspaceRoles: viaWorkspace
      .filter((w) => w.projectId === r.projectId && w.userId === r.userId)
      .map(({ workspaceId, workspaceName, roleId, roleName, permissions }) => ({ workspaceId, workspaceName, roleId, roleName, permissions })),
  }));
}

async function grantsOf(db: Db, projectIds: readonly string[], userIds?: readonly string[]) {
  if (projectIds.length === 0) return [];
  return db
    .select()
    .from(projectMemberPermissions)
    .where(
      and(
        inArray(projectMemberPermissions.projectId, [...projectIds]),
        ...(userIds ? [inArray(projectMemberPermissions.userId, [...userIds])] : []),
      ),
    );
}

const wrongScope = () =>
  new RoleRuleError(422, "wrong_scope", "An instance permission takes no project, a project permission needs one");
const notFound = (what: string) => new RoleRuleError(404, "not_found", `${what} not found`);

/** Le righe per persona, in una passata (prima un `filter` per ogni persona). */
function groupByUser<T extends { userId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.userId);
    if (list) list.push(r);
    else out.set(r.userId, [r]);
  }
  return out;
}

export async function whoCan(db: Db, viewer: Viewer, permission: AnyPermission, projectId: string | null): Promise<WhoCanResponse> {
  const instance = isInstancePermission(permission);
  if (instance === (projectId !== null)) throw wrongScope();
  if (projectId !== null && (await projectPermissionsFor(db, viewer, projectId)) === null) throw notFound("Project");

  const visible = await visiblePersonIds(db, viewer);
  const people = await db
    .select(personColumns)
    .from(users)
    .innerJoin(instanceRoles, eq(instanceRoles.id, users.instanceRoleId))
    .where(and(eq(users.isAgent, false), isNull(users.deactivatedAt), ...(visible === "all" ? [] : [inArray(users.id, visible)])))
    .orderBy(asc(users.email));

  const rows: WhoCanPerson[] = [];
  if (instance) {
    for (const person of people) {
      const entry = instanceWithReasons(person).find((p) => p.permission === permission);
      if (entry) rows.push({ userId: person.id, email: person.email, displayName: person.displayName, reasons: entry.reasons });
    }
  } else {
    const byUser = new Map((await memberships(db, [projectId!])).map((m) => [m.userId, m]));
    const grants = groupByUser(await grantsOf(db, [projectId!]));
    // I reparti dei soli MEMBRI (rimandi, lotto 4): «via <reparto>» vale solo
    // per chi è membro (`projectWithReasons`), quindi gli altri non servono.
    const fromDepartments = groupByUser(await departmentGrantsOf(db, people.filter((p) => byUser.has(p.id)).map((p) => p.id)));
    for (const person of people) {
      const entry = projectWithReasons(person, byUser.get(person.id), grants.get(person.id) ?? [], fromDepartments.get(person.id) ?? [])?.find(
        (p) => p.permission === permission,
      );
      if (entry) rows.push({ userId: person.id, email: person.email, displayName: person.displayName, reasons: entry.reasons });
    }
  }

  // Claude non ha una riga: non ha permessi suoi (agisce con quelli di chi
  // assegna o conferma), e il server non gliene applica nessuno.
  return { permission, projectId, people: rows, agent: { actsFor: "confirmer" } };
}

export async function whatCan(db: Db, viewer: Viewer, userId: string, projectId: string | null): Promise<WhatCanResponse> {
  const visible = await visiblePersonIds(db, viewer);
  if (visible !== "all" && !visible.includes(userId)) throw notFound("User");
  const [person] = await db
    .select(personColumns)
    .from(users)
    .innerJoin(instanceRoles, eq(instanceRoles.id, users.instanceRoleId))
    .where(and(eq(users.id, userId), eq(users.isAgent, false), isNull(users.deactivatedAt)));
  if (!person) throw notFound("User");

  let projectIds: string[];
  if (projectId !== null) {
    if ((await projectPermissionsFor(db, viewer, projectId)) === null) throw notFound("Project");
    projectIds = [projectId];
  } else {
    const seen = await visibleProjectIds(db, viewer);
    projectIds = await scopeProjectIds(db, seen);
  }
  const names = projectIds.length
    ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds)).orderBy(asc(projects.name))
    : [];
  const byProject = new Map((await memberships(db, projectIds, [userId])).map((m) => [m.projectId, m]));
  const grants = await grantsOf(db, projectIds, [userId]);
  const fromDepartments = await departmentGrantsOf(db, [userId]);

  const perProject: WhatCanResponse["projects"] = [];
  for (const { id, name } of names) {
    const permissions = projectWithReasons(person, byProject.get(id), grants.filter((g) => g.projectId === id), fromDepartments);
    // Workspace (lotto 4): la workspace da cui la persona vede il progetto, se c'è.
    if (permissions) perProject.push({ projectId: id, projectName: name, workspaceName: byProject.get(id)?.workspaceRoles[0]?.workspaceName ?? null, permissions });
  }
  return { userId, instance: instanceWithReasons(person), projects: perProject };
}

/**
 * «You'd lose» (rimandi, lotto 5; registro, M1 di 46 sulla review di F1):
 * cosa perderebbe DAVVERO chi guarda se il ruolo `roleId` avesse
 * `nextPermissions`. La regola del prototipo (`viewerLosesIf`,
 * `data/admin/roles.ts`): si confrontano i permessi EFFETTIVI di chi guarda
 * prima e dopo, all'istanza e in ogni progetto di cui è membro — ruolo,
 * concessioni personali, reparti, full admin —, quindi un permesso che resta
 * da un'altra fonte non è perso. Prima i permessi tolti dal ruolo, poi il
 * resto (un permesso che se ne va con `instance.full_admin`). Lettura pura.
 */
export async function viewerLosesIf(db: Db, viewer: Viewer, roleId: string, nextPermissions: readonly string[]): Promise<string[]> {
  const [role] = await db.select({ id: roles.id, permissions: roles.permissions }).from(roles).where(eq(roles.id, roleId));
  if (!role) throw new RoleRuleError(404, "not_found", "Role not found");
  const [me] = await db
    .select({ instanceRoleId: users.instanceRoleId, instanceRolePermissions: instanceRoles.permissions })
    .from(users)
    .innerJoin(instanceRoles, eq(instanceRoles.id, users.instanceRoleId))
    .where(eq(users.id, viewer.id));
  if (!me) return [];
  const swap = (id: string | null, perms: readonly string[] | null) => (id === roleId ? nextPermissions : (perms ?? []));
  const instBefore = effectiveInstancePermissions(me.instanceRolePermissions);
  const instAfter = effectiveInstancePermissions(swap(me.instanceRoleId, me.instanceRolePermissions));
  const lost = new Set<string>();
  for (const p of instBefore) if (!instAfter.has(p)) lost.add(p);

  // Una riga per FONTE (0239): il ruolo esplicito e quello di workspace, che
  // possono essere entrambi il ruolo che cambia.
  const rows = await db
    .select({ projectId: projectAccess.projectId, roleId: projectAccess.roleId, rolePermissions: memberRoles.permissions })
    .from(projectAccess)
    .innerJoin(memberRoles, eq(memberRoles.id, projectAccess.roleId))
    .where(and(eq(projectAccess.userId, viewer.id), projectAccessRowCounts));
  const projectIds = [...new Set(rows.map((m) => m.projectId))];
  const grants = groupByUser(await grantsOf(db, projectIds, [viewer.id])).get(viewer.id) ?? [];
  const fromDepartments = (await departmentGrantsOf(db, [viewer.id])).map((g) => g.permission);
  for (const projectId of projectIds) {
    const mine = rows.filter((r) => r.projectId === projectId);
    // Dopo: i ruoli nuovi (se è questo) più le fonti che non dipendono dal ruolo.
    const others = [...grants.filter((g) => g.projectId === projectId).map((g) => g.permission), ...fromDepartments];
    const before = effectiveProjectPermissions(instBefore, [...mine.flatMap((m) => m.rolePermissions), ...others]) ?? new Set();
    const after = effectiveProjectPermissions(instAfter, [...mine.flatMap((m) => swap(m.roleId, m.rolePermissions)), ...others]) ?? new Set();
    for (const p of before) if (!after.has(p)) lost.add(p);
  }
  const removed = role.permissions.filter((p) => !nextPermissions.includes(p));
  return [...removed.filter((p) => lost.has(p)), ...[...lost].filter((p) => !removed.includes(p))];
}
