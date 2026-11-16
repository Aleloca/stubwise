import { memberPermissionsSql, projectMemberPermissions, projectMembers, projects, roles, users, type Db } from "@stubwise/db";
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
import { projectPermissionsFor, visibleProjectIds } from "../auth/access.js";
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
}

/** I permessi di progetto di una persona in un progetto, coi motivi. */
function projectWithReasons(
  person: Person,
  membership: Membership | undefined,
  grants: { permission: string; grantedByUserId: string | null; grantedAt: Date }[],
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
    ],
  }));
}

async function memberships(db: Db, projectIds: readonly string[], userIds?: readonly string[]): Promise<Membership[]> {
  if (projectIds.length === 0) return [];
  return db
    .select({
      projectId: projectMembers.projectId,
      userId: projectMembers.userId,
      roleId: memberRoles.id,
      roleName: memberRoles.name,
      rolePermissions: memberRoles.permissions,
      memberPermissions: memberPermissionsSql(memberRoles.permissions, projectMembers.projectId, projectMembers.userId),
    })
    .from(projectMembers)
    .innerJoin(memberRoles, eq(memberRoles.id, projectMembers.roleId))
    .where(and(inArray(projectMembers.projectId, [...projectIds]), ...(userIds ? [inArray(projectMembers.userId, [...userIds])] : [])));
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
    const grants = await grantsOf(db, [projectId!]);
    for (const person of people) {
      const entry = projectWithReasons(person, byUser.get(person.id), grants.filter((g) => g.userId === person.id))?.find(
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
    projectIds = seen === "all" ? (await db.select({ id: projects.id }).from(projects)).map((p) => p.id) : seen;
  }
  const names = projectIds.length
    ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds)).orderBy(asc(projects.name))
    : [];
  const byProject = new Map((await memberships(db, projectIds, [userId])).map((m) => [m.projectId, m]));
  const grants = await grantsOf(db, projectIds, [userId]);

  const perProject: WhatCanResponse["projects"] = [];
  for (const { id, name } of names) {
    const permissions = projectWithReasons(person, byProject.get(id), grants.filter((g) => g.projectId === id));
    if (permissions) perProject.push({ projectId: id, projectName: name, permissions });
  }
  return { userId, instance: instanceWithReasons(person), projects: perProject };
}
