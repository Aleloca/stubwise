import { departmentGrantsOf, type DepartmentGrant } from "./department-access.js";
import { createHash } from "node:crypto";
import {
  departmentMembers,
  departmentRoles,
  departments,
  gitIdentities,
  invites,
  projectAccess,
  projectAccessPermissionsSql,
  projectMemberPermissions,
  projectMembers,
  projects,
  roles,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import {
  effectiveInstancePermissions,
  effectiveProjectPermissions,
  type ExtraPermission,
  type PersonDetail,
  type PersonRow,
  type RoleChoice,
} from "@stubwise/shared";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { scopeProjectIds, visibleProjectIds } from "../auth/access.js";
import { hasSecondFactor } from "../auth/second-factor/reset.js";
import type { SessionUser } from "../auth/session.js";
import { avatarUrlsFor } from "./avatars.js";
import { visiblePersonIds } from "./people-visibility.js";
import { isLastActiveFullAdmin, lastManagerProjectOf, missingToGrant, RoleRuleError } from "./roles.js";

/**
 * Area 9, F1 (aggiunta per R7): le letture CALCOLATE di People. Ogni campo che
 * dice «si può» o «manca» viene dalle stesse funzioni delle scritture
 * (`missingToGrant`, `isLastActiveFullAdmin`, `lastManagerProjectOf`), così il
 * client non deduce niente e la lettura non diverge dalla scrittura.
 * Persone e progetti che chi guarda non vede non compaiono (R-G5).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

/**
 * L'id OPACO di un invito: il token è il segreto della registrazione (lo vede
 * solo chi crea l'invito, una volta), quindi nelle viste non esce mai. Uno
 * sha256 di 32 byte casuali non si inverte.
 */
export const inviteIdOf = (token: string) => `i_${createHash("sha256").update(`invite:${token}`).digest("hex").slice(0, 32)}`;

export const nameOf = (u: { displayName: string | null; email: string }) => u.displayName ?? u.email.split("@")[0]!;
const inviters = alias(users, "inviter");
const instanceRoles = alias(roles, "instance_role");
const memberRoles = alias(roles, "member_role");

/**
 * Le persone che chi guarda vede NELL'AMMINISTRAZIONE: chi gestisce le
 * persone (`users.manage`) le vede tutte, perché agisce su chiunque (D-2);
 * gli altri con la regola di `/api/people`.
 */
export async function adminVisiblePersonIds(db: Db, viewer: Viewer): Promise<"all" | string[]> {
  return viewer.instancePermissions.has("users.manage") ? "all" : visiblePersonIds(db, viewer);
}

async function visibleProjectList(db: Db, viewer: Viewer): Promise<string[]> {
  const seen = await visibleProjectIds(db, viewer);
  return await scopeProjectIds(db, seen);
}

async function departmentsOf(db: Db, userIds: readonly string[]) {
  if (userIds.length === 0) return new Map<string, { id: string; name: string; colorToken: string }[]>();
  const rows = await db
    .select({ userId: departmentMembers.userId, id: departments.id, name: departments.name, colorToken: departments.colorToken })
    .from(departmentMembers)
    .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
    .where(inArray(departmentMembers.userId, [...userIds]))
    .orderBy(asc(departments.name));
  const map = new Map<string, { id: string; name: string; colorToken: string }[]>();
  for (const r of rows) map.set(r.userId, [...(map.get(r.userId) ?? []), { id: r.id, name: r.name, colorToken: r.colorToken }]);
  return map;
}

/** `GET /api/admin/people`: le persone visibili, più gli inviti pendenti a chi può invitare. */
export async function listPeopleRows(db: Db, viewer: Viewer): Promise<PersonRow[]> {
  const visible = await adminVisiblePersonIds(db, viewer);
  const people = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      deactivatedAt: users.deactivatedAt,
      roleId: instanceRoles.id,
      roleName: instanceRoles.name,
    })
    .from(users)
    .leftJoin(instanceRoles, eq(instanceRoles.id, users.instanceRoleId))
    .where(and(eq(users.isAgent, false), ...(visible === "all" ? [] : [inArray(users.id, visible)])))
    .orderBy(asc(users.email));
  const ids = people.map((p) => p.id);
  const projectIds = await visibleProjectList(db, viewer);
  const memberships =
    ids.length && projectIds.length
      ? await db
          .select({ userId: projectMembers.userId, code: projects.code, role: memberRoles.name })
          .from(projectMembers)
          .innerJoin(projects, eq(projects.id, projectMembers.projectId))
          .innerJoin(memberRoles, eq(memberRoles.id, projectMembers.roleId))
          .where(and(inArray(projectMembers.userId, ids), inArray(projectMembers.projectId, projectIds)))
          .orderBy(asc(projects.code))
      : [];
  const depts = await departmentsOf(db, ids);
  const avatars = await avatarUrlsFor(db, ids);
  const rows: PersonRow[] = people.map((p) => ({
    personId: p.id,
    name: nameOf(p),
    email: p.email,
    avatarUrl: avatars.get(p.id) ?? null,
    instanceRole: p.roleId && p.roleName ? { id: p.roleId, name: p.roleName } : null,
    departments: depts.get(p.id) ?? [],
    projects: memberships.filter((m) => m.userId === p.id).map((m) => ({ code: m.code, role: m.role })),
    status: p.deactivatedAt ? "deactivated" : "active",
    deactivatedAt: p.deactivatedAt?.toISOString() ?? null,
    invite: null,
  }));
  if (viewer.instancePermissions.has("users.invite")) {
    const pending = await db
      .select({
        token: invites.token,
        email: invites.email,
        expiresAt: invites.expiresAt,
        roleId: instanceRoles.id,
        roleName: instanceRoles.name,
        inviterName: inviters.displayName,
        inviterEmail: inviters.email,
      })
      .from(invites)
      .leftJoin(instanceRoles, eq(instanceRoles.id, invites.instanceRoleId))
      .leftJoin(inviters, eq(inviters.id, invites.invitedByUserId))
      .orderBy(asc(invites.email));
    for (const i of pending) {
      rows.push({
        personId: inviteIdOf(i.token),
        name: i.email.split("@")[0]!,
        email: i.email,
        avatarUrl: null,
        instanceRole: i.roleId && i.roleName ? { id: i.roleId, name: i.roleName } : null,
        departments: [],
        projects: [],
        status: "invited",
        deactivatedAt: null,
        invite: {
          id: inviteIdOf(i.token),
          expiresAt: i.expiresAt.toISOString(),
          expired: i.expiresAt.getTime() <= Date.now(),
          invitedByName: i.inviterEmail ? nameOf({ displayName: i.inviterName, email: i.inviterEmail }) : null,
        },
      });
    }
  }
  return rows;
}

/** I ruoli d'istanza con ciò che manca a chi guarda per darli (la regola di `setInstanceRole`). */
export async function instanceRoleChoicesFor(db: Db, viewer: Viewer, opts: { lastFullAdmin?: boolean } = {}): Promise<RoleChoice[]> {
  const rows = await db.select({ id: roles.id, name: roles.name, permissions: roles.permissions }).from(roles).where(eq(roles.scope, "instance")).orderBy(asc(roles.name));
  return rows.map((r) => {
    const effective = effectiveInstancePermissions(r.permissions);
    return {
      roleId: r.id,
      name: r.name,
      permissionCount: r.permissions.length,
      missing: missingToGrant(viewer, effective),
      // Review (M3): per SCELTA, non per azione — all'ultimo full admin si può
      // dare un altro ruolo col full admin, non uno senza (`assertFullAdminRemains`).
      block: opts.lastFullAdmin && !effective.has("instance.full_admin") ? "last_full_admin" : null,
    };
  });
}

/** `GET /api/admin/people/:id`. Persona invisibile o Claude: 404, come se non esistesse. */
export async function personDetail(db: Db, viewer: Viewer, personId: string, opts: { browserOk?: boolean } = {}): Promise<PersonDetail> {
  const visible = await adminVisiblePersonIds(db, viewer);
  if (visible !== "all" && !visible.includes(personId)) throw new RoleRuleError(404, "user_not_found", "User not found");
  const [p] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      deactivatedAt: users.deactivatedAt,
      bitbucketUsername: users.bitbucketUsername,
      roleId: instanceRoles.id,
      roleName: instanceRoles.name,
      rolePermissions: instanceRoles.permissions,
    })
    .from(users)
    .leftJoin(instanceRoles, eq(instanceRoles.id, users.instanceRoleId))
    .where(and(eq(users.id, personId), eq(users.isAgent, false)));
  if (!p) throw new RoleRuleError(404, "user_not_found", "User not found");

  const isSelf = p.id === viewer.id;
  const targetInstance = effectiveInstancePermissions(p.rolePermissions ?? []);
  const isFullAdmin = targetInstance.has("instance.full_admin");
  const viewerFullAdmin = viewer.instancePermissions.has("instance.full_admin");
  const deactivated = p.deactivatedAt !== null;
  // Review (I1): se una persona ha il secondo fattore lo sa solo chi gestisce le
  // persone o lei stessa — sennò chi vede un full admin saprebbe se è senza.
  const manage = viewer.instancePermissions.has("users.manage");
  const secondFactor = manage || isSelf ? await hasSecondFactor(db, p.id) : null;

  // I progetti: quelli di lei che chi guarda vede, coi permessi dati a mano.
  const projectIds = await visibleProjectList(db, viewer);
  const all = await db
    .select({
      projectId: projectMembers.projectId,
      code: projects.code,
      name: projects.name,
      roleId: memberRoles.id,
      roleName: memberRoles.name,
      rolePermissions: memberRoles.permissions,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .innerJoin(memberRoles, eq(memberRoles.id, projectMembers.roleId))
    .where(eq(projectMembers.userId, p.id))
    .orderBy(asc(projects.code));
  const seen = all.filter((m) => projectIds.includes(m.projectId));
  const grants = seen.length
    ? await db
        .select({ projectId: projectMemberPermissions.projectId, permission: projectMemberPermissions.permission, by: projectMemberPermissions.grantedByUserId, at: projectMemberPermissions.grantedAt, byName: inviters.displayName, byEmail: inviters.email })
        .from(projectMemberPermissions)
        .leftJoin(inviters, eq(inviters.id, projectMemberPermissions.grantedByUserId))
        .where(and(eq(projectMemberPermissions.userId, p.id), inArray(projectMemberPermissions.projectId, seen.map((m) => m.projectId))))
    : [];
  const viewerManages = await managedProjectIds(db, viewer, projectIds);
  // Area 9, F8: i permessi dei suoi reparti, in ogni progetto di cui è membro.
  const fromDepartments = await departmentGrantsOf(db, [p.id]);
  const projectsView = seen.map((m) => ({
    projectId: m.projectId,
    code: m.code,
    name: m.name,
    role: { id: m.roleId, name: m.roleName },
    extra: [
      ...grants
        .filter((g) => g.projectId === m.projectId && !m.rolePermissions.includes(g.permission))
        .map(
          (g): ExtraPermission => ({
            permission: g.permission,
            sources: [
              grantSource(g),
              ...fromDepartments.filter((d) => d.permission === g.permission).map(departmentSource),
            ],
            granted: true,
          }),
        ),
      ...[...new Set(fromDepartments.map((d) => d.permission))]
        .filter((perm) => !m.rolePermissions.includes(perm) && !grants.some((g) => g.projectId === m.projectId && g.permission === perm))
        .map(
          (perm): ExtraPermission => ({
            permission: perm,
            sources: fromDepartments.filter((d) => d.permission === perm).map(departmentSource),
            granted: false,
          }),
        ),
    ],
    canManage: viewerManages.has(m.projectId),
  }));
  const memberOf = new Set(all.map((m) => m.projectId));
  const addableTo =
    !deactivated && !isFullAdmin
      ? (await db.select({ id: projects.id, code: projects.code, name: projects.name }).from(projects).orderBy(asc(projects.code)))
          .filter((pr) => viewerManages.has(pr.id) && !memberOf.has(pr.id))
          .map((pr) => ({ projectId: pr.id, code: pr.code, name: pr.name }))
      : [];

  const depts = await db
    .select({ id: departments.id, name: departments.name, colorToken: departments.colorToken, permissions: departmentRoles.permissions })
    .from(departmentMembers)
    .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
    .leftJoin(departmentRoles, and(eq(departmentRoles.departmentId, departments.id), eq(departmentRoles.userId, p.id)))
    .where(eq(departmentMembers.userId, p.id))
    .orderBy(asc(departments.name));
  const gitEmails = (await db.select({ email: gitIdentities.email }).from(gitIdentities).where(eq(gitIdentities.userId, p.id)).orderBy(asc(gitIdentities.email))).map((g) => g.email);

  // Le azioni: `null` = si può, sennò il motivo. Le stesse guardie delle rotte.
  const gate = (extra: () => string | null): string | null => (!manage ? "forbidden" : isSelf ? "self" : extra());
  // Solo per chi gestisce le persone: agli altri le azioni sono già `forbidden` (M6).
  const lastAdmin = manage && isFullAdmin ? await isLastActiveFullAdmin(db, p.id) : false;
  const lastManager = manage && !deactivated ? await lastManagerProjectOf(db, p.id) : null;
  const actions = {
    setInstanceRole: gate(() => null),
    // Review (M2): la rotta vuole il browser o il desktop riconfermato.
    resetPassword: gate(() => (deactivated ? "status" : opts.browserOk === false ? "browser_only" : null)),
    changeEmail: gate(() => null),
    resetSecondFactor: gate(() => (secondFactor ? null : "no_second_factor")),
    // Un codice solo, quello della scrittura (M7): `last_manager`.
    deactivate: gate(() => (deactivated ? "status" : lastAdmin ? "last_full_admin" : lastManager ? "last_manager" : null)),
    reactivate: gate(() => (deactivated ? null : "status")),
    identities: manage ? null : "forbidden",
  };

  const openTasks = manage && !deactivated ? await openTasksOf(db, viewer, p.id, projectIds, visible) : [];
  const avatars = await avatarUrlsFor(db, [p.id]);
  return {
    personId: p.id,
    name: nameOf(p),
    email: p.email,
    avatarUrl: avatars.get(p.id) ?? null,
    status: deactivated ? "deactivated" : "active",
    deactivatedAt: p.deactivatedAt?.toISOString() ?? null,
    isSelf,
    isFullAdmin,
    hasSecondFactor: secondFactor,
    peer: viewerFullAdmin && isFullAdmin && !isSelf,
    instanceRole: p.roleId && p.roleName ? { id: p.roleId, name: p.roleName } : null,
    projects: projectsView,
    alsoInHiddenProjects: all.length > seen.length,
    addableTo,
    departments: depts.map((d) => ({ id: d.id, name: d.name, colorToken: d.colorToken, managesHome: (d.permissions ?? []).includes("department.home.manage") })),
    identities: { gitEmails, bitbucketUsername: p.bitbucketUsername },
    actions,
    instanceRoleChoices: manage ? await instanceRoleChoicesFor(db, viewer, { lastFullAdmin: lastAdmin }) : [],
    openTasks,
  };
}

/** Area 9, F8: un permesso dato dal reparto della persona. */
function departmentSource(g: DepartmentGrant) {
  return {
    kind: "department" as const,
    roleId: null,
    roleName: null,
    grantedById: null,
    grantedByName: null,
    at: null,
    origin: null,
    departmentId: g.departmentId,
    departmentName: g.departmentName,
  };
}

function grantSource(g: { by: string | null; at: Date; byName: string | null; byEmail: string | null }) {
  return {
    kind: "grant" as const,
    roleId: null,
    roleName: null,
    grantedById: g.by,
    grantedByName: g.byEmail ? nameOf({ displayName: g.byName, email: g.byEmail }) : null,
    at: g.at.toISOString(),
    origin: (g.by ? "given" : "seed") as "given" | "seed",
    departmentId: null,
    departmentName: null,
  };
}

/** I progetti (fra i visibili) dove chi guarda gestisce i membri. */
export async function managedProjectIds(db: Db, viewer: Viewer, projectIds: readonly string[]): Promise<Set<string>> {
  if (viewer.instancePermissions.has("instance.full_admin")) return new Set(projectIds);
  if (projectIds.length === 0) return new Set();
  // L'unione delle fonti (workspace compresa, 0238).
  const rows = await db
    .select({ projectId: projects.id, permissions: projectAccessPermissionsSql(projects.id, sql`${viewer.id}::uuid`) })
    .from(projects)
    .where(inArray(projects.id, [...projectIds]));
  const instance = new Set(viewer.instancePermissions);
  return new Set(rows.filter((r) => effectiveProjectPermissions(instance, r.permissions)?.has("project.members.manage")).map((r) => r.projectId));
}

/**
 * Le task aperte di lei nei progetti visibili, coi destinatari ammessi della
 * riassegnazione alla disattivazione: attivi, non Claude, che vedono il
 * progetto (membri o full admin) — la regola di `canReceive` in
 * `user-deactivation.ts` — e che chi guarda vede.
 */
async function openTasksOf(db: Db, viewer: Viewer, userId: string, projectIds: readonly string[], visible: "all" | string[]) {
  if (projectIds.length === 0) return [];
  const open = await db
    .select({ id: tickets.id, number: tickets.number, title: tickets.title, projectId: tickets.projectId, code: projects.code })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(and(eq(tickets.assigneeId, userId), isNull(tickets.closedAt), inArray(tickets.projectId, [...projectIds])))
    .orderBy(asc(projects.code), asc(tickets.number));
  if (open.length === 0) return [];
  const candidates = await db
    .select({ id: users.id, rolePermissions: instanceRoles.permissions })
    .from(users)
    .innerJoin(instanceRoles, eq(instanceRoles.id, users.instanceRoleId))
    .where(and(eq(users.isAgent, false), isNull(users.deactivatedAt), ...(visible === "all" ? [] : [inArray(users.id, visible)])));
  // Membri espliciti e persone di workspace (0238), la regola di `canReceive`.
  const members = await db
    .selectDistinct({ projectId: projectAccess.projectId, userId: projectAccess.userId })
    .from(projectAccess)
    .where(inArray(projectAccess.projectId, [...new Set(open.map((t) => t.projectId))]));
  return open.map((t) => ({
    taskId: t.id,
    code: `${t.code}-${t.number}`,
    title: t.title,
    projectId: t.projectId,
    reassignTo: candidates
      .filter((c) => c.id !== userId && (c.rolePermissions.includes("instance.full_admin") || members.some((m) => m.projectId === t.projectId && m.userId === c.id)))
      .map((c) => c.id),
  }));
}
