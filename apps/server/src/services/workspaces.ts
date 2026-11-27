import {
  inviteWorkspaces,
  projectAccess,
  projectAccessPermissionsSql,
  projectAccessRowCounts,
  projectAccessSql,
  projectMembers,
  projects,
  roles,
  users,
  workspaceMembers,
  workspaceProjects,
  workspaces,
  type Db,
} from "@stubwise/db";
import type { WorkspaceCandidates, WorkspaceEffect, WorkspaceEffectRequest, WorkspaceMemberPreview, WorkspaceView } from "@stubwise/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { projectPermissionsMap, scopeIncludes, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { personObject, recordChange } from "./change-log.js";
import { departmentGrantsForEntering, departmentGrantsOf } from "./department-access.js";
import { visiblePersonIds } from "./people-visibility.js";
import { instancePermissionsOfUser, publishNotification } from "@stubwise/notifications";
import { peopleKnownTo } from "./people-known.js";
import { keepingManagersIn, managersLostBy, RoleRuleError } from "./roles.js";

/**
 * WORKSPACE, il servizio (lotto 3, `docs/plans/2026-11-27-workspace-design.md`
 * §1.6 e §2, decisioni D1–D19). Una workspace raggruppa PROGETTI per
 * VISIBILITÀ: le sue persone vedono ogni suo progetto col ruolo di workspace
 * (un ruolo di PROGETTO), letto da `project_access`. Le regole, in un posto:
 *
 * - **struttura** (creare, rinominare, eliminare): `workspaces.manage` (la rotta);
 *   mettere, togliere o spostare un progetto chiede anche
 *   `project.members.manage` in quel progetto (D4);
 * - **persone**: `workspaces.manage` E `project.members.manage` in OGNI progetto
 *   della workspace, più l'anti-escalation (`judgeWorkspaceGrant`);
 * - **nessuna escalation sul DARE**: chi entra in un progetto ci porta il ruolo
 *   di workspace e, se non vi accedeva già, i suoi reparti (D10, F8-4 = a);
 *   chi agisce deve averli lì, archiviati compresi; un full admin passa;
 * - **`last_manager`** dopo ogni scrittura, su tutti i progetti toccati (D18);
 * - **Claude** non entra (400 `system_user`), un disattivato nemmeno (422);
 * - la revoca è a LETTURA: si toccano solo le righe di workspace.
 *
 * Le anteprime (`memberPreview`, `accessEffect`) FANNO la scrittura in una
 * transazione annullata: dicono quello che la scrittura farà.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;
export type WorkspaceActor = Pick<SessionUser, "id" | "email" | "instancePermissions">;

const MANAGE_MEMBERS = "project.members.manage";

const isFullAdmin = (actor: Pick<SessionUser, "instancePermissions">) => actor.instancePermissions.has("instance.full_admin");
const canManageStructure = (actor: Pick<SessionUser, "instancePermissions">) =>
  isFullAdmin(actor) || actor.instancePermissions.has("workspaces.manage");

const notFound = () => new RoleRuleError(404, "not_found", "Workspace not found");
const forbidden = (message = "Missing a permission for this workspace") => new RoleRuleError(403, "forbidden", message);
const personName = sql<string>`coalesce(nullif(${users.displayName}, ''), split_part(${users.email}, '@', 1))`;

// ── Letture ──────────────────────────────────────────────────────────────

/** I permessi di chi agisce in OGNI progetto, archiviati compresi (l'escalation non li salta). */
async function heldByProject(db: DbOrTx, actor: Pick<SessionUser, "id" | "instancePermissions">): Promise<Record<string, readonly string[]>> {
  return projectPermissionsMap(db as Db, actor, { includeArchived: true });
}

async function projectIdsOf(db: DbOrTx, workspaceId: string): Promise<string[]> {
  return (await db.select({ id: workspaceProjects.projectId }).from(workspaceProjects).where(eq(workspaceProjects.workspaceId, workspaceId)).orderBy(asc(workspaceProjects.position), asc(workspaceProjects.projectId))).map((r) => r.id);
}

async function membersOf(db: DbOrTx, workspaceId: string, opts: { lockRoles?: boolean } = {}) {
  const query = db
    .select({ userId: workspaceMembers.userId, roleId: workspaceMembers.roleId, roleName: roles.name, rolePermissions: roles.permissions })
    .from(workspaceMembers)
    .innerJoin(roles, eq(roles.id, workspaceMembers.roleId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  // Revisione del lotto 3 (I-3): i ruoli dei membri FOR SHARE (solo quelle righe) prima dei lock dei membri.
  return opts.lockRoles ? query.for("share", { of: roles }) : query;
}

/**
 * Chi agisce gestisce le persone (D4, come l'ha accettata il maintainer):
 * `workspaces.manage` E `project.members.manage` in OGNI progetto della
 * workspace (una vuota: il solo `workspaces.manage`). L'anti-escalation sta
 * sopra, in `judgeWorkspaceGrant`.
 */
function managesPeople(actor: Pick<SessionUser, "id" | "instancePermissions">, projectIds: readonly string[], held: Record<string, readonly string[]>): boolean {
  if (isFullAdmin(actor)) return true;
  if (!canManageStructure(actor)) return false;
  return projectIds.every((id) => (held[id] ?? []).includes(MANAGE_MEMBERS));
}

/** Le workspace che chi guarda vede (D5), nella forma per lui (r.1414). */
export async function listWorkspaces(db: Db, viewer: Pick<SessionUser, "id" | "instancePermissions">, onlyId?: string): Promise<WorkspaceView[]> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(onlyId ? eq(workspaces.id, onlyId) : undefined)
    .orderBy(sql`lower(${workspaces.name})`, asc(workspaces.id));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const projectRows = await db.select({ workspaceId: workspaceProjects.workspaceId, projectId: workspaceProjects.projectId, position: workspaceProjects.position }).from(workspaceProjects).where(inArray(workspaceProjects.workspaceId, ids)).orderBy(asc(workspaceProjects.position), asc(workspaceProjects.projectId));
  const memberRows = await db
    .select({ workspaceId: workspaceMembers.workspaceId, userId: workspaceMembers.userId, roleId: workspaceMembers.roleId, roleName: roles.name, name: personName, email: users.email, deactivatedAt: users.deactivatedAt })
    .from(workspaceMembers)
    .innerJoin(roles, eq(roles.id, workspaceMembers.roleId))
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(inArray(workspaceMembers.workspaceId, ids))
    .orderBy(asc(users.email));
  const visible = await visibleProjectIds(db, viewer);
  const held = await heldByProject(db, viewer);
  const known = await peopleKnownTo(db, viewer, memberRows.map((m) => m.userId));
  const manage = canManageStructure(viewer);
  const out: WorkspaceView[] = [];
  for (const w of rows) {
    const all = projectRows.filter((p) => p.workspaceId === w.id).map((p) => p.projectId);
    const seen = all.filter((id) => scopeIncludes(visible, id));
    const people = memberRows.filter((m) => m.workspaceId === w.id);
    const isMember = people.some((m) => m.userId === viewer.id);
    if (!manage && !isMember && seen.length === 0) continue;
    out.push({
      id: w.id,
      name: w.name,
      colorToken: w.colorToken as WorkspaceView["colorToken"],
      projectIds: seen,
      people: people
        .filter((m) => known === "all" || known.has(m.userId))
        .map((m) => ({ userId: m.userId, name: m.name, roleId: m.roleId, roleName: m.roleName, email: m.email, status: m.deactivatedAt ? ("deactivated" as const) : ("active" as const) })),
      isMember,
      canManage: manage,
      canManagePeople: managesPeople(viewer, all, held),
    });
  }
  return out;
}

/** Una workspace che chi guarda vede, o 404 (come un progetto). */
export async function getWorkspace(db: Db, viewer: WorkspaceActor, id: string): Promise<WorkspaceView> {
  const [view] = await listWorkspaces(db, viewer, id);
  if (!view) throw notFound();
  return view;
}

// ── Il giudizio dell'escalation ─────────────────────────────────────────

export interface WorkspaceGrant {
  userId: string;
  /** I permessi del ruolo di workspace che arriva. */
  rolePermissions: readonly string[];
  projectIds: readonly string[];
}

/**
 * LA regola dell'escalation delle workspace: per ogni persona e ogni progetto
 * dove arriva, i permessi del ruolo di workspace più (se prima non vi accedeva)
 * quelli dei suoi reparti, che chi agisce deve avere lì (archiviati compresi).
 * La usano anteprime e scritture.
 */
export async function judgeWorkspaceGrant(db: DbOrTx, actor: WorkspaceActor, grants: readonly WorkspaceGrant[]): Promise<{ projectId: string; permission: string }[]> {
  if (isFullAdmin(actor) || grants.length === 0) return [];
  const held = await heldByProject(db, actor);
  const missing: { projectId: string; permission: string }[] = [];
  for (const grant of grants) {
    const departments = (await departmentGrantsForEntering(db as Db, grant.userId)).map((g) => g.permission);
    for (const projectId of grant.projectIds) {
      const already = await accesses(db, projectId, grant.userId);
      const arriving = new Set([...grant.rolePermissions, ...(already ? [] : departments)]);
      for (const permission of arriving) if (!(held[projectId] ?? []).includes(permission)) missing.push({ projectId, permission });
    }
  }
  return missing;
}

async function accesses(db: DbOrTx, projectId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ ok: projectAccessSql(sql`${projectId}::uuid`, sql`${userId}::uuid`) }).from(sql`(select 1) as one`);
  return row?.ok === true;
}

function escalationError(missing: readonly { projectId: string; permission: string }[]): RoleRuleError {
  return new RoleRuleError(403, "escalation", "You cannot grant permissions you don't hold in every project of this workspace", {
    permission: missing[0]!.permission,
    missing: [...new Set(missing.map((m) => m.permission))],
    projectId: missing[0]!.projectId,
  });
}

// ── Struttura ────────────────────────────────────────────────────────────

async function lockedWorkspace(tx: Tx, id: string) {
  const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update");
  if (!row) throw notFound();
  return row;
}

const workspaceObject = (w: { id: string; name: string }) => ({ type: "workspace", id: w.id, label: w.name });

export async function createWorkspace(db: Db, actor: WorkspaceActor, input: { name: string; colorToken?: string | undefined; projectIds?: readonly string[] | undefined }): Promise<WorkspaceView> {
  if (!canManageStructure(actor)) throw forbidden();
  const id = await db.transaction(async (tx) => {
    const [w] = await tx.insert(workspaces).values({ name: input.name.trim(), colorToken: input.colorToken ?? "--dept-1", createdByUserId: actor.id }).returning();
    await recordChange(tx, { type: "workspace.created", actor, projectId: null, data: { object: workspaceObject(w!) } });
    for (const projectId of [...new Set(input.projectIds ?? [])]) await placeProject(tx, actor, w!, projectId);
    return w!.id;
  });
  return getWorkspace(db, actor, id);
}

export async function updateWorkspace(db: Db, actor: WorkspaceActor, id: string, input: { name?: string | undefined; colorToken?: string | undefined }): Promise<WorkspaceView> {
  if (!canManageStructure(actor)) throw forbidden();
  await db.transaction(async (tx) => {
    const w = await lockedWorkspace(tx, id);
    const name = input.name?.trim() ?? w.name;
    await tx.update(workspaces).set({ name, ...(input.colorToken ? { colorToken: input.colorToken } : {}) }).where(eq(workspaces.id, id));
    await recordChange(tx, { type: "workspace.updated", actor, projectId: null, data: { object: workspaceObject({ id, name }), ...(name !== w.name ? { before: w.name, after: name } : {}) } });
  });
  return getWorkspace(db, actor, id);
}

/** Elimina una workspace: i progetti restano senza, le persone perdono ciò che vedevano per lei (a lettura). */
export async function deleteWorkspace(db: Db, actor: WorkspaceActor, id: string): Promise<void> {
  if (!canManageStructure(actor)) throw forbidden();
  await db.transaction(async (tx) => {
    const w = await lockedWorkspace(tx, id);
    await keepingManagersIn(tx, await projectIdsOf(tx, id), async () => {
      await tx.delete(workspaces).where(eq(workspaces.id, id));
    });
    await recordChange(tx, { type: "workspace.deleted", actor, projectId: null, data: { object: workspaceObject(w) } });
  });
}

/**
 * Mette un progetto nella workspace (o lo SPOSTA da un'altra: D2, una riga
 * sola). Chi agisce gestisce i membri del progetto (D4), può dare alle persone
 * della workspace il loro ruolo lì (escalation), e il progetto non perde il
 * suo ultimo gestore uscendo dalla workspace di prima.
 */
async function placeProject(tx: Tx, actor: WorkspaceActor, w: { id: string; name: string }, projectId: string): Promise<void> {
  const held = await heldByProject(tx, actor);
  const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!project || (!isFullAdmin(actor) && held[projectId] === undefined)) throw new RoleRuleError(404, "not_found", "Project not found");
  if (!isFullAdmin(actor) && !(held[projectId] ?? []).includes(MANAGE_MEMBERS)) throw forbidden("You don't manage this project's members");
  const [current] = await tx
    .select({ workspaceId: workspaceProjects.workspaceId, name: workspaces.name })
    .from(workspaceProjects)
    .innerJoin(workspaces, eq(workspaces.id, workspaceProjects.workspaceId))
    .where(eq(workspaceProjects.projectId, projectId))
    .for("update");
  if (current?.workspaceId === w.id) return;
  const members = await membersOf(tx, w.id, { lockRoles: true });
  const missing = await judgeWorkspaceGrant(tx, actor, members.map((m) => ({ userId: m.userId, rolePermissions: m.rolePermissions, projectIds: [projectId] })));
  if (missing.length > 0) throw escalationError(missing);
  await keepingManagersIn(tx, [projectId], async () => {
    if (current) await tx.delete(workspaceProjects).where(eq(workspaceProjects.projectId, projectId));
    await tx.insert(workspaceProjects).values({ workspaceId: w.id, projectId });
  });
  if (current) {
    await recordChange(tx, { type: "workspace.project_removed", actor, projectId, data: { object: workspaceObject({ id: current.workspaceId, name: current.name }), params: { workspaceName: current.name } } });
  }
  await recordChange(tx, { type: "workspace.project_added", actor, projectId, data: { object: workspaceObject(w), params: { workspaceName: w.name } } });
}

export async function addProject(db: Db, actor: WorkspaceActor, workspaceId: string, projectId: string): Promise<WorkspaceView> {
  if (!canManageStructure(actor)) throw forbidden();
  await db.transaction(async (tx) => placeProject(tx, actor, await lockedWorkspace(tx, workspaceId), projectId));
  return getWorkspace(db, actor, workspaceId);
}

export async function removeProject(db: Db, actor: WorkspaceActor, workspaceId: string, projectId: string): Promise<void> {
  if (!canManageStructure(actor)) throw forbidden();
  await db.transaction(async (tx) => {
    const w = await lockedWorkspace(tx, workspaceId);
    // Revisione del lotto 3 (I-4): la riga bloccata, e la delete su QUELLA riga (uno spostamento concorrente non si toglie per sbaglio).
    const [row] = await tx.select().from(workspaceProjects).where(and(eq(workspaceProjects.workspaceId, workspaceId), eq(workspaceProjects.projectId, projectId))).for("update");
    const held = await heldByProject(tx, actor);
    if (!row || (!isFullAdmin(actor) && held[projectId] === undefined)) throw new RoleRuleError(404, "not_found", "Project not found");
    if (!isFullAdmin(actor) && !(held[projectId] ?? []).includes(MANAGE_MEMBERS)) throw forbidden("You don't manage this project's members");
    await keepingManagersIn(tx, [projectId], async () => {
      const removed = await tx
        .delete(workspaceProjects)
        .where(and(eq(workspaceProjects.workspaceId, workspaceId), eq(workspaceProjects.projectId, projectId)))
        .returning({ id: workspaceProjects.projectId });
      if (removed.length === 0) throw new RoleRuleError(404, "not_found", "Project not found");
    });
    await recordChange(tx, { type: "workspace.project_removed", actor, projectId, data: { object: workspaceObject(w), params: { workspaceName: w.name } } });
  });
}

// ── Persone ──────────────────────────────────────────────────────────────

/** Il ruolo di workspace: quello chiesto (di PROGETTO), o il preset Viewer (D3); mai un ripiego. */
async function resolveRole(db: DbOrTx, roleId: string | undefined) {
  // Revisione del lotto 3 (I-3): FOR SHARE, come `sharedRole`: un `updateRole` concorrente
  // aspetta, e il giudizio dell'escalation vale sui permessi che resteranno.
  const [role] = roleId
    ? await db.select({ id: roles.id, name: roles.name, scope: roles.scope, permissions: roles.permissions }).from(roles).where(eq(roles.id, roleId)).for("share")
    : await db.select({ id: roles.id, name: roles.name, scope: roles.scope, permissions: roles.permissions }).from(roles).where(eq(roles.presetKey, "viewer")).for("share");
  if (!role) throw roleId ? new RoleRuleError(404, "role_not_found", "Role not found") : new RoleRuleError(400, "role_required", "The Viewer preset is gone: choose a role");
  if (role.scope !== "project") throw new RoleRuleError(422, "invalid_role", "A workspace role is a project role");
  return role;
}

async function targetPerson(db: DbOrTx, userId: string) {
  const [u] = await db.select({ id: users.id, email: users.email, isAgent: users.isAgent, deactivatedAt: users.deactivatedAt }).from(users).where(eq(users.id, userId));
  if (!u) throw new RoleRuleError(404, "user_not_found", "User not found");
  if (u.isAgent) throw new RoleRuleError(400, "system_user", "Claude doesn't join workspaces");
  if (u.deactivatedAt) throw new RoleRuleError(422, "user_deactivated", "This person is deactivated");
  return u;
}

async function assertManagesPeople(tx: DbOrTx, actor: WorkspaceActor, projectIds: readonly string[]) {
  if (!managesPeople(actor, projectIds, await heldByProject(tx, actor))) throw forbidden("You don't manage the members of every project in this workspace");
}

/** Mette una persona nella workspace, o ne cambia il ruolo. */
export async function putMember(db: Db, actor: WorkspaceActor, workspaceId: string, userId: string, input: { roleId?: string | undefined }): Promise<WorkspaceView> {
  // M1 (revisione d'insieme): una workspace che chi agisce non vede è 404,
  // come per l'anteprima e i candidati: un 403 direbbe che esiste.
  await getWorkspace(db, actor, workspaceId);
  await db.transaction(async (tx) => {
    const w = await lockedWorkspace(tx, workspaceId);
    const projectIds = await projectIdsOf(tx, workspaceId);
    await assertManagesPeople(tx, actor, projectIds);
    const person = await targetPerson(tx, userId);
    const role = await resolveRole(tx, input.roleId);
    const [before] = await tx
      .select({ roleId: workspaceMembers.roleId, roleName: roles.name })
      .from(workspaceMembers)
      .innerJoin(roles, eq(roles.id, workspaceMembers.roleId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .for("update");
    if (before?.roleId === role.id) return;
    const missing = await judgeWorkspaceGrant(tx, actor, [{ userId, rolePermissions: role.permissions, projectIds }]);
    if (missing.length > 0) throw escalationError(missing);
    // Abbassare un ruolo può togliere l'ultimo gestore (D18).
    await keepingManagersIn(tx, projectIds, async () => {
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId, userId, roleId: role.id, addedByUserId: actor.id })
        .onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.userId], set: { roleId: role.id } });
    });
    if (before) {
      await recordChange(tx, { type: "workspace.member_role_changed", actor, projectId: null, data: { object: personObject(person), before: before.roleName, after: role.name, params: { workspaceName: w.name } } });
    } else {
      const entryId = await recordChange(tx, { type: "workspace.member_added", actor, projectId: null, data: { object: personObject(person), params: { workspaceName: w.name, roleName: role.name } } });
      await publishWorkspaceJoined(tx, { workspace: w, userId, roleId: role.id, roleName: role.name, actorUserId: actor.id, changeLogEntryId: entryId });
    }
  });
  return getWorkspace(db, actor, workspaceId);
}

/**
 * Toglie una persona dalla workspace. D12: i suoi override (membri ESPLICITI
 * dei progetti della workspace) restano, salvo `alsoProjects`.
 */
export async function removeMember(db: Db, actor: WorkspaceActor, workspaceId: string, userId: string, opts: { alsoProjects?: boolean | undefined } = {}): Promise<void> {
  // M1 (revisione d'insieme): una workspace che chi agisce non vede è 404,
  // come per l'anteprima e i candidati: un 403 direbbe che esiste.
  await getWorkspace(db, actor, workspaceId);
  await db.transaction(async (tx) => {
    const w = await lockedWorkspace(tx, workspaceId);
    const projectIds = await projectIdsOf(tx, workspaceId);
    await assertManagesPeople(tx, actor, projectIds);
    const [row] = await tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    if (!row) throw new RoleRuleError(404, "not_found", "Not in this workspace");
    const [person] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId));
    const explicit = opts.alsoProjects && projectIds.length > 0
      ? (await tx.select({ projectId: projectMembers.projectId }).from(projectMembers).where(and(eq(projectMembers.userId, userId), inArray(projectMembers.projectId, projectIds)))).map((r) => r.projectId)
      : [];
    await keepingManagersIn(tx, projectIds, async () => {
      await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
      if (explicit.length > 0) await tx.delete(projectMembers).where(and(eq(projectMembers.userId, userId), inArray(projectMembers.projectId, explicit)));
    });
    await recordChange(tx, { type: "workspace.member_removed", actor, projectId: null, data: { object: personObject(person!), params: { workspaceName: w.name, alsoProjects: String(opts.alsoProjects === true) } } });
    // L'uscita dai progetti lascia la voce di sempre: è la memoria «chi lo conosceva» (`peopleKnownTo`).
    for (const projectId of explicit) await recordChange(tx, { type: "member.removed", actor, projectId, data: { object: personObject(person!) } });
  });
}

/**
 * D13: chi ENTRA in una workspace riceve UNA card `member.added` (nessun kind
 * nuovo: la discesa d'immagine non rompe `/api/inbox`), col nome della
 * workspace al posto del progetto; i progetti li deriva l'inbox. Un avviso del
 * catalogo vive in un progetto: la card si appoggia al PRIMO progetto aperto
 * della workspace (`mandatoryOnly`: solo alla persona, mai a chi gestisce quel
 * progetto), e ne segue la visibilità. Una workspace senza progetti aperti non
 * dà accesso a niente: nessuna card. Mai a chi ha agito né a Claude. Un
 * progetto aggiunto a una workspace non manda card.
 */
async function publishWorkspaceJoined(
  tx: Tx,
  input: { workspace: { id: string; name: string }; userId: string; roleId: string; roleName: string; actorUserId: string; changeLogEntryId: string },
): Promise<void> {
  const [added] = await tx.select({ email: users.email, displayName: users.displayName, isAgent: users.isAgent }).from(users).where(eq(users.id, input.userId));
  if (!added || added.isAgent || input.userId === input.actorUserId) return;
  const [actor] = await tx.select({ email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, input.actorUserId));
  const [anchor] = await tx
    .select({ id: projects.id })
    .from(workspaceProjects)
    .innerJoin(projects, eq(projects.id, workspaceProjects.projectId))
    .where(and(eq(workspaceProjects.workspaceId, input.workspace.id), sql`${projects.archivedAt} is null`))
    .orderBy(asc(workspaceProjects.position), asc(workspaceProjects.projectId))
    .limit(1);
  if (!anchor) return;
  const [via] = (await tx.execute(sql`select nullif(current_setting('stubwise.via_claude_action_id', true), '') as id`)) as unknown as { id: string | null }[];
  await publishNotification(
    tx,
    {
      kind: "member.added",
      projectId: anchor.id,
      projectCode: input.workspace.name,
      projectName: input.workspace.name,
      workspaceId: input.workspace.id,
      workspaceName: input.workspace.name,
      addedUserId: input.userId,
      addedName: added.displayName || added.email,
      roleName: input.roleName,
      roleId: input.roleId,
      actorUserId: input.actorUserId,
      actorName: actor ? actor.displayName || actor.email : null,
      viaClaude: (via?.id ?? null) !== null,
      changeLogEntryId: input.changeLogEntryId,
    },
    { projectId: anchor.id, mandatory: [{ userId: input.userId, reason: "added" }], mandatoryOnly: true, exclude: [input.actorUserId] },
  );
}

// ── Anteprime (la scrittura, annullata) ──────────────────────────────────

class Rollback extends Error {}

async function rolledBack<T>(db: Db, run: (tx: Tx) => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await db.transaction(async (tx) => {
      value = await run(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return value as T;
}

/** Il progetto di un errore, solo a chi lo vede (r.1414). */
function shownProject(projectId: string | null, visible: Awaited<ReturnType<typeof visibleProjectIds>>, held: Record<string, readonly string[]>): string | null {
  return projectId && (scopeIncludes(visible, projectId) || held[projectId] !== undefined) ? projectId : null;
}

/** `POST /:id/members/preview`: cosa guadagna la persona, cosa chi agisce non può dare, se toglie un gestore. */
export async function memberPreview(db: Db, actor: WorkspaceActor, workspaceId: string, userId: string, input: { roleId?: string | undefined }): Promise<WorkspaceMemberPreview> {
  await getWorkspace(db, actor, workspaceId);
  const projectIds = await projectIdsOf(db, workspaceId);
  await assertManagesPeople(db, actor, projectIds);
  const visible = await visibleProjectIds(db, actor);
  const held = await heldByProject(db, actor);
  try {
    await targetPerson(db, userId);
  } catch (error) {
    if (error instanceof RoleRuleError && (error.code === "system_user" || error.code === "user_deactivated")) return { projects: [], escalation: [], lastManager: { blocked: false, projectId: null }, block: error.code };
    throw error;
  }
  let role;
  try {
    role = await resolveRole(db, input.roleId);
  } catch (error) {
    if (error instanceof RoleRuleError && error.code === "role_required") return { projects: [], escalation: [], lastManager: { blocked: false, projectId: null }, block: "role_required" };
    throw error;
  }
  // Revisione del lotto 3 (M-2): lo stesso ruolo di adesso non dà niente (la scrittura non fa niente).
  const [current] = await db.select({ roleId: workspaceMembers.roleId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  const escalation =
    current?.roleId === role.id
      ? []
      : (await judgeWorkspaceGrant(db, actor, [{ userId, rolePermissions: role.permissions, projectIds }])).map((m) => ({ projectId: shownProject(m.projectId, visible, held), permission: m.permission }));
  const result = await rolledBack(db, async (tx) => {
    // Revisione del lotto 3 (I-2): lo stesso ordine dei lock della scrittura (workspace, ruolo, membri).
    await lockedWorkspace(tx, workspaceId);
    await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, role.id)).for("share");
    const before = new Map<string, Set<string>>();
    for (const projectId of projectIds) before.set(projectId, new Set(await permissionsIn(tx, projectId, userId)));
    const lost = await managersLostBy(tx, projectIds, async () => {
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId, userId, roleId: role.id, addedByUserId: actor.id })
        .onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.userId], set: { roleId: role.id } });
    });
    const gains: { projectId: string; gains: string[] }[] = [];
    for (const projectId of projectIds) {
      if (!scopeIncludes(visible, projectId) && held[projectId] === undefined) continue;
      const after = await permissionsIn(tx, projectId, userId);
      gains.push({ projectId, gains: after.filter((p) => !before.get(projectId)!.has(p)) });
    }
    return { gains, lost };
  });
  return {
    projects: result.gains,
    escalation,
    lastManager: { blocked: result.lost.length > 0, projectId: shownProject(result.lost[0] ?? null, visible, held) },
    block: null,
  };
}

async function permissionsIn(db: DbOrTx, projectId: string, userId: string): Promise<string[]> {
  const [row] = await db.select({ p: projectAccessPermissionsSql(sql`${projectId}::uuid`, sql`${userId}::uuid`) }).from(sql`(select 1) as one`);
  return [...new Set(row?.p ?? [])];
}

/** Chi vede un progetto, fuori dai full admin (che vedono sempre). */
async function seers(db: DbOrTx, projectIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map(projectIds.map((id) => [id, new Set<string>()]));
  if (projectIds.length === 0) return out;
  const rows = await db.selectDistinct({ projectId: projectAccess.projectId, userId: projectAccess.userId }).from(projectAccess).where(and(inArray(projectAccess.projectId, [...projectIds]), projectAccessRowCounts));
  for (const r of rows) out.get(r.projectId)!.add(r.userId);
  return out;
}

/**
 * `POST /api/workspaces/effect` (`workspaceAccessEffect`): l'effetto di un
 * cambio di struttura. Si FA la scrittura senza i suoi rifiuti in una
 * transazione annullata, e si confronta chi vede prima e dopo; `lastManager` è
 * la regola della scrittura, `escalation` il suo giudizio. Solo i progetti che
 * chi chiede vede; le persone che non conosce non compaiono (r.1414).
 */
export async function accessEffect(db: Db, actor: WorkspaceActor, request: WorkspaceEffectRequest): Promise<WorkspaceEffect> {
  if (request.kind === "create") return createEffect(db, actor, request.projectIds);
  await getWorkspace(db, actor, request.workspaceId);
  const visible = await visibleProjectIds(db, actor);
  const held = await heldByProject(db, actor);
  const inWorkspace = await projectIdsOf(db, request.workspaceId);
  // Revisione del lotto 3 (I-2): l'anteprima la chiede chi potrebbe fare la scrittura
  // (la simulazione prende i lock della scrittura: chi guarda soltanto non li prende).
  if (request.kind === "removeMember") await assertManagesPeople(db, actor, inWorkspace);
  else if (!canManageStructure(actor)) throw forbidden();
  // M-5: un progetto che non c'è, o che chi chiede non vede, è 404 (mai un errore del DB).
  if (request.kind === "addProject" || request.kind === "removeProject") {
    const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, request.projectId));
    if (!p || (!isFullAdmin(actor) && held[request.projectId] === undefined)) throw new RoleRuleError(404, "not_found", "Project not found");
  }
  let touched: string[];
  let escalation: { projectId: string; permission: string }[] = [];
  if (request.kind === "addProject" || request.kind === "removeProject") touched = [request.projectId];
  else touched = inWorkspace;
  if (request.kind === "addProject") {
    const members = await membersOf(db, request.workspaceId);
    escalation = await judgeWorkspaceGrant(db, actor, members.map((m) => ({ userId: m.userId, rolePermissions: m.rolePermissions, projectIds: [request.projectId] })));
  }
  const { before, after, lost } = await rolledBack(db, async (tx) => {
    // Lo stesso ordine dei lock delle scritture: prima la workspace (I-2).
    await lockedWorkspace(tx, request.workspaceId);
    const before = await seers(tx, touched);
    const lost = await managersLostBy(tx, touched, async () => {
      switch (request.kind) {
        case "addProject":
          await tx.delete(workspaceProjects).where(eq(workspaceProjects.projectId, request.projectId));
          await tx.insert(workspaceProjects).values({ workspaceId: request.workspaceId, projectId: request.projectId });
          break;
        case "removeProject":
          await tx.delete(workspaceProjects).where(and(eq(workspaceProjects.workspaceId, request.workspaceId), eq(workspaceProjects.projectId, request.projectId)));
          break;
        case "deleteWorkspace":
          await tx.delete(workspaces).where(eq(workspaces.id, request.workspaceId));
          break;
        case "removeMember":
          await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, request.workspaceId), eq(workspaceMembers.userId, request.userId)));
          if (request.alsoProjects && inWorkspace.length > 0) await tx.delete(projectMembers).where(and(eq(projectMembers.userId, request.userId), inArray(projectMembers.projectId, inWorkspace)));
          break;
      }
    });
    return { before, after: await seers(tx, touched), lost };
  });
  const sees = (projectId: string) => isFullAdmin(actor) || scopeIncludes(visible, projectId) || held[projectId] !== undefined;
  const changed = [...new Set(touched.flatMap((id) => [...(before.get(id) ?? []), ...(after.get(id) ?? [])]))];
  const known = await peopleKnownTo(db, actor, changed);
  const names = new Map(
    changed.length
      ? (await db.select({ id: users.id, name: personName }).from(users).where(inArray(users.id, changed))).map((r) => [r.id, r.name])
      : [],
  );
  const person = (id: string) => ({ userId: id, name: names.get(id) ?? "" });
  const isKnown = (id: string) => known === "all" || known.has(id);
  return {
    projects: touched.filter(sees).map((projectId) => ({
      projectId,
      startSeeing: [...(after.get(projectId) ?? [])].filter((id) => !before.get(projectId)?.has(id) && isKnown(id)).map(person),
      stopSeeing: [...(before.get(projectId) ?? [])].filter((id) => !after.get(projectId)?.has(id) && isKnown(id)).map(person),
    })),
    lastManager: lost.filter(sees),
    escalation: escalation.map((m) => ({ projectId: sees(m.projectId) ? m.projectId : null, permission: m.permission })),
  };
}

// ── L'invito di registrazione (D9) ──────────────────────────────────────

export interface InviteWorkspace {
  workspaceId: string;
  roleId: string;
}

/**
 * Le workspace che un invito promette, con le regole di chi invita (D4, la
 * stessa di `putMember`): le persone della workspace le gestisce, e il ruolo
 * lo può dare in OGNI suo progetto. Senza ruolo, il Viewer (D3), risolto qui e
 * salvato: «nessun ruolo» non è una scorciatoia (R51). I reparti dell'invitato
 * non si conoscono ancora: li riverifica l'accettazione.
 */
export async function assertInviteWorkspaces(tx: Tx, actor: WorkspaceActor, grants: readonly { workspaceId: string; roleId?: string | undefined }[]): Promise<InviteWorkspace[]> {
  const seen = new Set<string>();
  const out: InviteWorkspace[] = [];
  for (const grant of grants) {
    if (seen.has(grant.workspaceId)) throw new RoleRuleError(400, "duplicate_workspace", "A workspace appears more than once");
    seen.add(grant.workspaceId);
    if ((await listWorkspaces(tx as unknown as Db, actor, grant.workspaceId)).length === 0) throw notFound();
    const projectIds = await projectIdsOf(tx, grant.workspaceId);
    await assertManagesPeople(tx, actor, projectIds);
    const role = await resolveRole(tx, grant.roleId);
    if (!isFullAdmin(actor)) {
      const held = await heldByProject(tx, actor);
      const missing = projectIds.flatMap((projectId) => role.permissions.filter((p) => !(held[projectId] ?? []).includes(p)).map((permission) => ({ projectId, permission })));
      if (missing.length > 0) throw escalationError(missing);
    }
    out.push({ workspaceId: grant.workspaceId, roleId: role.id });
  }
  return out;
}

export async function saveInviteWorkspaces(tx: Tx, token: string, grants: readonly InviteWorkspace[]): Promise<void> {
  if (grants.length > 0) await tx.insert(inviteWorkspaces).values(grants.map((g) => ({ inviteToken: token, workspaceId: g.workspaceId, roleId: g.roleId })));
}

/** Le workspace di un invito, da leggere PRIMA di consumarlo (il delete le porta via in cascata). */
export async function inviteWorkspacesOf(tx: Tx, token: string): Promise<InviteWorkspace[]> {
  return tx.select({ workspaceId: inviteWorkspaces.workspaceId, roleId: inviteWorkspaces.roleId }).from(inviteWorkspaces).where(eq(inviteWorkspaces.inviteToken, token));
}

/**
 * All'accettazione ogni workspace si RIVERIFICA coi permessi ATTUALI di chi ha
 * invitato (R51): gestisce ancora le persone (in ogni progetto di ADESSO), e ha
 * lì i permessi del ruolo e quelli che i reparti dell'invitato (il ripiego)
 * portano. Una non più valida si scarta con `onDropped`; l'utente nasce lo stesso.
 */
export async function applyInviteWorkspaces(
  tx: Tx,
  userId: string,
  grants: readonly InviteWorkspace[],
  invitedByUserId: string | null,
  onDropped: (grant: InviteWorkspace, reason: string) => void = () => {},
): Promise<void> {
  if (grants.length === 0) return;
  const [inviter] = invitedByUserId ? await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, invitedByUserId)) : [];
  if (!inviter) {
    for (const grant of grants) onDropped(grant, "inviter_missing");
    return;
  }
  const actor: WorkspaceActor = { id: inviter.id, email: inviter.email, instancePermissions: await instancePermissionsOfUser(tx as unknown as Db, inviter.id) };
  const [me] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId));
  for (const grant of grants) {
    const [w] = await tx.select().from(workspaces).where(eq(workspaces.id, grant.workspaceId)).for("update");
    if (!w) {
      onDropped(grant, "workspace_missing");
      continue;
    }
    const projectIds = await projectIdsOf(tx, grant.workspaceId);
    if (!managesPeople(actor, projectIds, await heldByProject(tx, actor))) {
      onDropped(grant, "inviter_cannot_manage_people");
      continue;
    }
    const [role] = await tx.select({ name: roles.name, permissions: roles.permissions }).from(roles).where(eq(roles.id, grant.roleId)).for("share");
    if (!role) {
      onDropped(grant, "role_missing");
      continue;
    }
    if ((await judgeWorkspaceGrant(tx, actor, [{ userId, rolePermissions: role.permissions, projectIds }])).length > 0) {
      onDropped(grant, "inviter_lacks_role_permissions");
      continue;
    }
    await tx.insert(workspaceMembers).values({ workspaceId: grant.workspaceId, userId, roleId: grant.roleId, addedByUserId: inviter.id }).onConflictDoNothing();
    // Entrare da un invito è un'aggiunta; l'attore è chi entra (come i progetti dell'invito).
    await recordChange(tx, { type: "workspace.member_added", actor: me!, projectId: null, data: { object: personObject(me!), params: { workspaceName: w.name, roleName: role.name, via: "invite" } } });
  }
}

/**
 * Lotto 5: l'effetto di una workspace NUOVA coi suoi progetti, prima di crearla
 * (la regola di `createWorkspace`): una workspace nuova non ha persone, quindi
 * nessuno comincia a vedere; smette chi vedeva un progetto solo per la
 * workspace da cui esce. La scrittura, annullata.
 */
async function createEffect(db: Db, actor: WorkspaceActor, projectIdsIn: readonly string[]): Promise<WorkspaceEffect> {
  if (!canManageStructure(actor)) throw forbidden();
  const projectIds = [...new Set(projectIdsIn)];
  const held = await heldByProject(db, actor);
  for (const projectId of projectIds) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!p || (!isFullAdmin(actor) && held[projectId] === undefined)) throw new RoleRuleError(404, "not_found", "Project not found");
    if (!isFullAdmin(actor) && !(held[projectId] ?? []).includes(MANAGE_MEMBERS)) throw forbidden("You don't manage this project's members");
  }
  const { before, after, lost } = await rolledBack(db, async (tx) => {
    // L'ordine dei lock delle scritture: le workspace di partenza, poi i membri.
    const sources = projectIds.length ? await tx.select({ id: workspaceProjects.workspaceId }).from(workspaceProjects).where(inArray(workspaceProjects.projectId, projectIds)) : [];
    for (const id of [...new Set(sources.map((r) => r.id))].sort()) await lockedWorkspace(tx, id);
    const before = await seers(tx, projectIds);
    const [w] = await tx.insert(workspaces).values({ name: "effect", colorToken: "--dept-1", createdByUserId: actor.id }).returning();
    const lost = await managersLostBy(tx, projectIds, async () => {
      if (projectIds.length === 0) return;
      await tx.delete(workspaceProjects).where(inArray(workspaceProjects.projectId, projectIds));
      await tx.insert(workspaceProjects).values(projectIds.map((projectId) => ({ workspaceId: w!.id, projectId })));
    });
    return { before, after: await seers(tx, projectIds), lost };
  });
  const changed = [...new Set(projectIds.flatMap((id) => [...(before.get(id) ?? []), ...(after.get(id) ?? [])]))];
  const known = await peopleKnownTo(db, actor, changed);
  const names = new Map(changed.length ? (await db.select({ id: users.id, name: personName }).from(users).where(inArray(users.id, changed))).map((r) => [r.id, r.name]) : []);
  const isKnown = (id: string) => known === "all" || known.has(id);
  const person = (id: string) => ({ userId: id, name: names.get(id) ?? "" });
  return {
    projects: projectIds.map((projectId) => ({
      projectId,
      startSeeing: [...(after.get(projectId) ?? [])].filter((id) => !before.get(projectId)?.has(id) && isKnown(id)).map(person),
      stopSeeing: [...(before.get(projectId) ?? [])].filter((id) => !after.get(projectId)?.has(id) && isKnown(id)).map(person),
    })),
    lastManager: lost,
    escalation: [],
  };
}

/**
 * Lotto 5: chi si può mettere in una workspace (`GET /:id/candidates`). Lo
 * chiede chi ne gestisce le persone (D4). I candidati sono le persone attive
 * che chi guarda vede (r.1414): con `users.view_all` tutta la directory (la
 * vede già da `GET /api/users`: chi entra in una workspace di solito non è
 * ancora in nessun suo progetto), altrimenti quelle di `visiblePersonIds`.
 * Fuori chi c'è già, i full admin (vedono tutto) e Claude. `missing` è
 * ciò che i loro reparti porterebbero in un progetto dove chi agisce non l'ha;
 * i ruoli si giudicano su TUTTI i progetti della workspace.
 */
export async function workspaceCandidates(db: Db, actor: WorkspaceActor, workspaceId: string): Promise<WorkspaceCandidates> {
  await getWorkspace(db, actor, workspaceId);
  const projectIds = await projectIdsOf(db, workspaceId);
  await assertManagesPeople(db, actor, projectIds);
  const held = await heldByProject(db, actor);
  const inside = new Set((await db.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))).map((r) => r.id));
  const visible = actor.instancePermissions.has("users.view_all") ? ("all" as const) : await visiblePersonIds(db, actor);
  const people = await db
    .select({ id: users.id, name: personName, email: users.email, permissions: roles.permissions })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.instanceRoleId))
    .where(and(eq(users.isAgent, false), sql`${users.deactivatedAt} is null`, ...(visible === "all" ? [] : [inArray(users.id, visible.length ? visible : ["00000000-0000-0000-0000-000000000000"])])))
    .orderBy(asc(users.email));
  const candidates = people.filter((p) => !inside.has(p.id) && !p.permissions.includes("instance.full_admin"));
  const fullAdmin = isFullAdmin(actor);
  const missingIn = (perms: readonly string[]) =>
    fullAdmin ? [] : [...new Set(perms.filter((perm) => projectIds.some((id) => !(held[id] ?? []).includes(perm))))].sort();
  const brought = await departmentGrantsOf(db, candidates.map((c) => c.id));
  const projectRoles = await db.select({ id: roles.id, name: roles.name, permissions: roles.permissions }).from(roles).where(eq(roles.scope, "project")).orderBy(asc(roles.name));
  const [viewer] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "viewer"));
  return {
    candidates: candidates.map((c) => ({ userId: c.id, name: c.name, email: c.email, missing: missingIn(brought.filter((g) => g.userId === c.id).map((g) => g.permission)) })),
    roles: projectRoles.map((r) => ({ roleId: r.id, name: r.name, missing: missingIn(r.permissions) })),
    defaultRoleId: viewer?.id ?? null,
  };
}
