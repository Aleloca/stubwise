/**
 * Gestione di ruoli e membri (design `docs/plans/2026-10-22-permessi-progetto-design.md`).
 *
 * Due regole reggono tutto il modulo, e stanno qui in UN posto:
 *
 * - **Niente escalation** ({@link assertNoEscalation}): si assegna un ruolo —
 *   o lo si rende effettivo modificandolo — solo se i suoi permessi sono
 *   inclusi in quelli di chi agisce. Per un ruolo di progetto contano i
 *   permessi di chi agisce IN QUEL PROGETTO, per uno d'istanza i suoi permessi
 *   d'istanza. Un full admin passa sempre.
 * - **Resta sempre un full admin** ({@link assertFullAdminRemains}): ogni
 *   transazione che cambia un ruolo d'istanza, i permessi di un ruolo, elimina
 *   un ruolo o un utente la chiama prima di confermare.
 *
 * Gli errori di regola escono come {@link RoleRuleError}: le rotte li
 * traducono in risposta, la transazione intanto è già annullata.
 */
import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { inviteProjects, projectMembers, projects, roles, users } from "@stubwise/db";
import {
  effectiveInstancePermissions,
  PROJECT_PERMISSIONS,
  unknownPermissionsFor,
  type InviteProject,
  type RoleScope,
} from "@stubwise/shared";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { isForeignKeyViolation, isUniqueViolation } from "../routes/shared.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;
type Actor = Pick<SessionUser, "id" | "instancePermissions">;

/** Un rifiuto di regola, con lo status e il codice della risposta. */
export class RoleRuleError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
    /** Campi in più della risposta (es. `count` di `role_in_use`). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RoleRuleError";
  }
}

/**
 * Chiave del lock advisory che serializza le transazioni che possono togliere
 * l'ultimo full admin. Valore arbitrario ma fisso, diverso dagli altri lock
 * dell'applicazione (il setup usa 7_414_355).
 */
const FULL_ADMIN_LOCK_KEY = 7_414_356;

function isFullAdmin(actor: Actor): boolean {
  return actor.instancePermissions.has("instance.full_admin");
}

/**
 * 403 se `permissions` non è incluso in `held` (default: i permessi d'istanza
 * di chi agisce). Un full admin passa sempre.
 */
export function assertNoEscalation(
  actor: Actor,
  permissions: Iterable<string>,
  held: ReadonlySet<string> = actor.instancePermissions,
): void {
  if (isFullAdmin(actor)) return;
  for (const p of permissions) {
    if (!held.has(p)) {
      throw new RoleRuleError(
        403,
        "forbidden",
        `You cannot grant a permission you do not have (${p})`,
      );
    }
  }
}

/**
 * Protezione del bersaglio (ruling R28): si cambia o si toglie il ruolo di
 * qualcuno solo se i permessi del suo ruolo ATTUALE sono inclusi in quelli di
 * chi agisce (`held`, default i permessi d'istanza). Altrimenti chi gestisce
 * utenti o membri potrebbe declassare chi sta sopra di lui. 403, come
 * l'escalation; un full admin passa sempre.
 */
export function assertTargetNotAbove(
  actor: Actor,
  targetPermissions: Iterable<string>,
  held: ReadonlySet<string> = actor.instancePermissions,
): void {
  if (isFullAdmin(actor)) return;
  for (const p of targetPermissions) {
    if (!held.has(p)) {
      throw new RoleRuleError(
        403,
        "forbidden",
        `You cannot change a role with more permissions than yours (${p})`,
      );
    }
  }
}

/**
 * 409 `last_full_admin` se, dentro `tx`, non resta nessun utente con
 * `instance.full_admin`. `excludingRoleId` conta come se quel ruolo non ci
 * fosse più (eliminazione di un ruolo: il RESTRICT la fermerebbe comunque, ma
 * il motivo da dire è questo).
 *
 * Concorrenza: prima del conteggio prende un lock advisory di transazione, lo
 * stesso per tutte le transazioni che lo chiamano. Due declassamenti
 * concorrenti di due admin diversi si serializzano QUI: il secondo aspetta il
 * commit del primo e, in READ COMMITTED (il livello di default), il suo
 * conteggio — uno statement nuovo — vede la modifica già confermata. Va quindi
 * chiamata DOPO la modifica, nella stessa transazione.
 */
export async function assertFullAdminRemains(
  tx: Tx,
  opts: { excludingRoleId?: string } = {},
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${FULL_ADMIN_LOCK_KEY})`);
  const [row] = await tx
    .select({ value: count() })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.instanceRoleId))
    .where(
      and(
        sql`${roles.permissions} @> array['instance.full_admin']::text[]`,
        opts.excludingRoleId ? sql`${roles.id} <> ${opts.excludingRoleId}` : undefined,
      ),
    );
  if ((row?.value ?? 0) === 0) {
    throw new RoleRuleError(
      409,
      "last_full_admin",
      "At least one user must keep full administration",
    );
  }
}

// ── Ruoli ────────────────────────────────────────────────────────────────

export interface RoleRow {
  id: string;
  name: string;
  scope: RoleScope;
  permissions: string[];
  presetKey: string | null;
  assignmentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Assegnazioni di un ruolo: utenti (istanza) o membri (progetto). */
const assignmentCountSql = sql<number>`(
  case when ${roles.scope} = 'instance'
    then (select count(*) from ${users} where ${users.instanceRoleId} = ${roles.id})
    else (select count(*) from ${projectMembers} where ${projectMembers.roleId} = ${roles.id})
  end
)::int`;

const roleSelection = {
  id: roles.id,
  name: roles.name,
  scope: roles.scope,
  permissions: roles.permissions,
  presetKey: roles.presetKey,
  assignmentCount: assignmentCountSql,
  createdAt: roles.createdAt,
  updatedAt: roles.updatedAt,
};

export async function listRoles(db: DbOrTx, scope?: RoleScope): Promise<RoleRow[]> {
  return db
    .select(roleSelection)
    .from(roles)
    .where(scope ? eq(roles.scope, scope) : undefined)
    .orderBy(roles.scope, sql`lower(${roles.name})`);
}

async function roleById(db: DbOrTx, id: string): Promise<RoleRow | null> {
  const [row] = await db.select(roleSelection).from(roles).where(eq(roles.id, id));
  return row ?? null;
}

async function lockedRole(tx: Tx, id: string): Promise<RoleRow> {
  await tx.execute(sql`select 1 from ${roles} where ${roles.id} = ${id} for update`);
  const role = await roleById(tx, id);
  if (!role) throw new RoleRuleError(404, "role_not_found", "Role not found");
  return role;
}

function assertKnownPermissions(scope: RoleScope, permissions: readonly string[]): void {
  const unknown = unknownPermissionsFor(scope, permissions);
  if (unknown.length > 0) {
    throw new RoleRuleError(
      400,
      "invalid_permissions",
      `Unknown permissions: ${unknown.join(", ")}`,
    );
  }
}

/**
 * I permessi di progetto che chi agisce può mettere in un ruolo di progetto:
 * quelli che ha in OGNI progetto dove il ruolo è assegnato (la modifica lo
 * rende effettivo lì). Un ruolo non assegnato (o nuovo) non è effettivo da
 * nessuna parte: bastano i permessi che ha in almeno un progetto — assegnarlo
 * poi richiederà comunque di averli nel progetto dell'assegnazione.
 */
async function heldForProjectRole(
  db: DbOrTx,
  actor: Actor,
  roleId: string | null,
): Promise<Set<string>> {
  const mine = await db
    .select({ projectId: projectMembers.projectId, permissions: roles.permissions })
    .from(projectMembers)
    .innerJoin(roles, eq(roles.id, projectMembers.roleId))
    .where(eq(projectMembers.userId, actor.id));
  const byProject = new Map(mine.map((m) => [m.projectId, new Set(m.permissions)]));
  const assigned = roleId
    ? (
        await db
          .selectDistinct({ projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(eq(projectMembers.roleId, roleId))
      ).map((r) => r.projectId)
    : [];
  if (assigned.length === 0) return new Set(mine.flatMap((m) => m.permissions));
  const [first, ...rest] = assigned.map((p) => byProject.get(p) ?? new Set<string>());
  return new Set([...first!].filter((p) => rest.every((there) => there.has(p))));
}

async function assertCanGrantInRole(
  db: DbOrTx,
  actor: Actor,
  scope: RoleScope,
  roleId: string | null,
  granted: readonly string[],
): Promise<void> {
  if (isFullAdmin(actor) || granted.length === 0) return;
  const held =
    scope === "instance" ? actor.instancePermissions : await heldForProjectRole(db, actor, roleId);
  assertNoEscalation(actor, granted, held);
}

function nameTaken(): RoleRuleError {
  return new RoleRuleError(409, "role_name_taken", "A role with this name already exists");
}

async function insertRole(
  db: Db,
  values: { name: string; scope: RoleScope; permissions: string[] },
): Promise<RoleRow> {
  try {
    const [created] = await db.insert(roles).values(values).returning({ id: roles.id });
    return (await roleById(db, created!.id))!;
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken();
    throw error;
  }
}

export async function createRole(
  db: Db,
  actor: Actor,
  input: { name: string; scope: RoleScope; permissions: string[] },
): Promise<RoleRow> {
  const permissions = [...new Set(input.permissions)];
  assertKnownPermissions(input.scope, permissions);
  await assertCanGrantInRole(db, actor, input.scope, null, permissions);
  return insertRole(db, { name: input.name, scope: input.scope, permissions });
}

export async function duplicateRole(
  db: Db,
  actor: Actor,
  id: string,
  name: string | undefined,
): Promise<RoleRow> {
  const source = await roleById(db, id);
  if (!source) throw new RoleRuleError(404, "role_not_found", "Role not found");
  await assertCanGrantInRole(db, actor, source.scope, null, source.permissions);
  return insertRole(db, {
    name: name ?? `${source.name} (copy)`,
    scope: source.scope,
    permissions: source.permissions,
  });
}

/**
 * Rinomina e/o cambia i permessi. Solo i permessi AGGIUNTI passano dal
 * controllo anti-escalation: toglierne non dà niente a nessuno (ma può
 * togliere l'ultimo full admin, e lì c'è la guardia).
 */
export async function updateRole(
  db: Db,
  actor: Actor,
  id: string,
  input: { name?: string; permissions?: string[] },
): Promise<RoleRow> {
  try {
    return await db.transaction(async (tx) => {
      const role = await lockedRole(tx, id);
      const permissions = input.permissions ? [...new Set(input.permissions)] : undefined;
      if (permissions) {
        assertKnownPermissions(role.scope, permissions);
        const added = permissions.filter((p) => !role.permissions.includes(p));
        await assertCanGrantInRole(tx, actor, role.scope, role.id, added);
      }
      await tx
        .update(roles)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(permissions ? { permissions } : {}),
          updatedAt: new Date(),
        })
        .where(eq(roles.id, id));
      if (permissions && role.scope === "instance") await assertFullAdminRemains(tx);
      return (await roleById(tx, id))!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken();
    throw error;
  }
}

/**
 * I preset che il percorso legacy di `users.role` (trigger della 0097) e gli
 * inviti senza ruolo usano: non si eliminano finché la colonna derivata esiste
 * (ruling R9). Si rinominano e si modificano come gli altri.
 */
const SYSTEM_PRESET_KEYS: ReadonlySet<string> = new Set(["admin", "user"]);

export async function deleteRole(db: Db, id: string): Promise<void> {
  await db
    .transaction(async (tx) => {
      const role = await lockedRole(tx, id);
      if (role.scope === "instance") await assertFullAdminRemains(tx, { excludingRoleId: id });
      if (role.presetKey && SYSTEM_PRESET_KEYS.has(role.presetKey)) {
        throw new RoleRuleError(
          409,
          "role_required_by_system",
          "This preset role is still required by the system and cannot be deleted",
        );
      }
      if (role.assignmentCount > 0) {
        throw new RoleRuleError(409, "role_in_use", "The role is still assigned", {
          count: role.assignmentCount,
        });
      }
      await tx.delete(roles).where(eq(roles.id, id));
    })
    .catch((error: unknown) => {
      // Un'assegnazione arrivata fra il conteggio e il delete: la ferma il
      // RESTRICT, e il motivo resta lo stesso.
      if (isForeignKeyViolation(error)) {
        throw new RoleRuleError(409, "role_in_use", "The role is still assigned");
      }
      throw error;
    });
}

// ── Ruolo d'istanza e utenti ─────────────────────────────────────────────

async function instanceRole(db: DbOrTx, roleId: string): Promise<RoleRow> {
  const role = await roleById(db, roleId);
  if (!role) throw new RoleRuleError(404, "role_not_found", "Role not found");
  if (role.scope !== "instance") {
    throw new RoleRuleError(400, "invalid_role_scope", "Not an instance role");
  }
  return role;
}

/**
 * Cambia il ruolo d'istanza di un utente. Chi agisce deve avere tutti i
 * permessi d'istanza EFFETTIVI del ruolo (un ruolo con `instance.full_admin`
 * li ha tutti, quindi lo assegna solo un full admin). Il proprio ruolo non si
 * cambia (400), ma l'ultimo full admin vince come motivo più specifico.
 *
 * `lastAdminCode` esiste per la rotta legacy `PATCH /:id/role`, che continua a
 * rispondere `last_admin` ai client che lo conoscono.
 */
export async function setInstanceRole(
  db: Db,
  actor: Actor,
  userId: string,
  roleId: string,
  opts: { lastAdminCode?: string } = {},
): Promise<void> {
  const role = await instanceRole(db, roleId);
  assertNoEscalation(actor, effectiveInstancePermissions(role.permissions));
  await db.transaction(async (tx) => {
    // Protezione del bersaglio (ruling R28): non si tocca chi ha più di te.
    // La riga si blocca, così il ruolo letto è quello che si sostituisce.
    const [target] = await tx
      .select({ permissions: roles.permissions })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.instanceRoleId))
      .where(eq(users.id, userId))
      .for("update", { of: users });
    if (!target) throw new RoleRuleError(404, "user_not_found", "User not found");
    assertTargetNotAbove(actor, effectiveInstancePermissions(target.permissions));
    await tx.update(users).set({ instanceRoleId: roleId }).where(eq(users.id, userId));
    try {
      await assertFullAdminRemains(tx);
    } catch (error) {
      if (error instanceof RoleRuleError && opts.lastAdminCode) {
        throw new RoleRuleError(409, opts.lastAdminCode, "Cannot demote the last admin");
      }
      throw error;
    }
    if (userId === actor.id) {
      throw new RoleRuleError(400, "cannot_change_own_role", "You cannot change your own role");
    }
  });
}

/**
 * Elimina un utente (non sé stessi), senza mai lasciare l'istanza senza full
 * admin. Nessuna rotta la espone ancora (ruling R27): esiste perché la guardia
 * copra anche l'eliminazione quando ci sarà, e la protezione del bersaglio vale
 * come per il cambio di ruolo.
 */
export async function deleteUser(db: Db, actor: Actor, userId: string): Promise<void> {
  if (userId === actor.id) {
    throw new RoleRuleError(400, "cannot_delete_self", "You cannot delete your own account");
  }
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ permissions: roles.permissions })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.instanceRoleId))
      .where(eq(users.id, userId))
      .for("update", { of: users });
    if (target) assertTargetNotAbove(actor, effectiveInstancePermissions(target.permissions));
    const [deleted] = await tx
      .delete(users)
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    if (!deleted) throw new RoleRuleError(404, "user_not_found", "User not found");
    await assertFullAdminRemains(tx);
  });
}

// ── Membri di progetto ──────────────────────────────────────────────────

async function projectRole(db: DbOrTx, roleId: string): Promise<RoleRow> {
  const role = await roleById(db, roleId);
  if (!role) throw new RoleRuleError(404, "role_not_found", "Role not found");
  if (role.scope !== "project") {
    throw new RoleRuleError(400, "invalid_role_scope", "Not a project role");
  }
  return role;
}

export interface MemberRow {
  userId: string;
  email: string;
  avatarUrl: string | null;
  roleId: string;
  roleName: string;
  createdAt: Date;
}

const memberSelection = {
  userId: projectMembers.userId,
  email: users.email,
  avatarUrl: users.slackAvatarUrl,
  roleId: projectMembers.roleId,
  roleName: roles.name,
  createdAt: projectMembers.createdAt,
};

export async function listProjectMembers(db: DbOrTx, projectId: string): Promise<MemberRow[]> {
  return db
    .select(memberSelection)
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .innerJoin(roles, eq(roles.id, projectMembers.roleId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(users.email);
}

/**
 * Aggiunge `userId` al progetto con `roleId`, o gli cambia ruolo. `held` sono
 * i permessi di chi agisce IN QUESTO progetto (quelli risolti dall'hook).
 */
export async function putProjectMember(
  db: Db,
  actor: Actor,
  held: ReadonlySet<string>,
  projectId: string,
  userId: string,
  roleId: string,
): Promise<MemberRow> {
  const role = await projectRole(db, roleId);
  assertNoEscalation(actor, role.permissions, held);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) throw new RoleRuleError(404, "user_not_found", "User not found");
  await db.transaction(async (tx) => {
    const current = await lockedMemberPermissions(tx, projectId, userId);
    if (current) assertTargetNotAbove(actor, current, held);
    await tx
      .insert(projectMembers)
      .values({ projectId, userId, roleId })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { roleId },
      });
  });
  const [row] = await db
    .select(memberSelection)
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .innerJoin(roles, eq(roles.id, projectMembers.roleId))
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return row!;
}

/** Toglie un membro; come per il cambio di ruolo, mai uno con più permessi di chi agisce lì. */
export async function removeProjectMember(
  db: Db,
  actor: Actor,
  held: ReadonlySet<string>,
  projectId: string,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockedMemberPermissions(tx, projectId, userId);
    if (!current) throw new RoleRuleError(404, "member_not_found", "Member not found");
    assertTargetNotAbove(actor, current, held);
    await tx
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  });
}

/** I permessi del ruolo attuale di un membro, con la riga bloccata; `null` se non è membro. */
async function lockedMemberPermissions(
  tx: Tx,
  projectId: string,
  userId: string,
): Promise<string[] | null> {
  const [row] = await tx
    .select({ permissions: roles.permissions })
    .from(projectMembers)
    .innerJoin(roles, eq(roles.id, projectMembers.roleId))
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .for("update", { of: projectMembers });
  return row?.permissions ?? null;
}

/**
 * Il ruolo che riceve chi crea un progetto: il preset `Project Lead` o, se è
 * stato eliminato, il primo ruolo di progetto con tutti i permessi di
 * progetto. `null` se non ce n'è nessuno.
 */
export async function leadRoleId(db: DbOrTx): Promise<string | null> {
  const [preset] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.presetKey, "project_lead"), eq(roles.scope, "project")));
  if (preset) return preset.id;
  const [full] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        eq(roles.scope, "project"),
        sql`${roles.permissions} @> array[${sql.join(
          PROJECT_PERMISSIONS.map((p) => sql`${p}`),
          sql`, `,
        )}]::text[]`,
      ),
    )
    .orderBy(roles.createdAt)
    .limit(1);
  return full?.id ?? null;
}

// ── Inviti ───────────────────────────────────────────────────────────────

/**
 * Verifica ruolo d'istanza e progetti di un invito con le regole di chi
 * invita: il ruolo d'istanza va tenuto nei propri permessi d'istanza; per
 * ogni progetto servono `project.members.manage` lì (un progetto che non si
 * vede è 404, come altrove) e i permessi del ruolo in quel progetto.
 */
export async function assertInviteGrants(
  db: Db,
  actor: Actor,
  instanceRoleId: string | undefined,
  grants: readonly InviteProject[],
): Promise<void> {
  if (instanceRoleId) {
    const role = await instanceRole(db, instanceRoleId);
    assertNoEscalation(actor, effectiveInstancePermissions(role.permissions));
  }
  const seen = new Set<string>();
  for (const grant of grants) {
    if (seen.has(grant.projectId)) {
      throw new RoleRuleError(400, "duplicate_project", "A project appears more than once");
    }
    seen.add(grant.projectId);
    const held = await projectPermissionsFor(db, actor, grant.projectId);
    if (!held) throw new RoleRuleError(404, "not_found", "Not found");
    if (!held.has("project.members.manage")) {
      throw new RoleRuleError(403, "forbidden", "Missing permission");
    }
    const role = await projectRole(db, grant.roleId);
    assertNoEscalation(actor, role.permissions, held);
  }
}

export async function saveInviteGrants(
  tx: Tx,
  token: string,
  grants: readonly InviteProject[],
): Promise<void> {
  if (grants.length === 0) return;
  await tx
    .insert(inviteProjects)
    .values(grants.map((g) => ({ inviteToken: token, projectId: g.projectId, roleId: g.roleId })));
}

/** I progetti di un invito, da leggere PRIMA di consumarlo (il delete li porta via in cascata). */
export async function inviteGrants(tx: Tx, token: string): Promise<InviteProject[]> {
  return tx
    .select({ projectId: inviteProjects.projectId, roleId: inviteProjects.roleId })
    .from(inviteProjects)
    .innerJoin(projects, eq(projects.id, inviteProjects.projectId))
    .where(eq(inviteProjects.inviteToken, token));
}

export async function applyInviteGrants(
  tx: Tx,
  userId: string,
  grants: readonly InviteProject[],
): Promise<void> {
  if (grants.length === 0) return;
  await tx
    .insert(projectMembers)
    .values(grants.map((g) => ({ projectId: g.projectId, userId, roleId: g.roleId })));
}
