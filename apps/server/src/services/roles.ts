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
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { inviteProjects, memberPermissionsSql, projectMemberPermissions, projectMembers, projects, roles, users } from "@stubwise/db";
import {
  effectiveInstancePermissions,
  PROJECT_PERMISSIONS,
  unknownPermissionsFor,
  type InviteProject,
  type RoleScope,
} from "@stubwise/shared";
import { projectPermissionsByProject } from "@stubwise/notifications";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { isForeignKeyViolation, isUniqueViolation } from "../routes/shared.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;
type Actor = Pick<SessionUser, "id" | "instancePermissions">;

/** Un rifiuto di regola, con lo status e il codice della risposta. */
export class RoleRuleError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
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
 * 403 `escalation` se `permissions` non è incluso in `held` (default: i
 * permessi d'istanza di chi agisce), con la chiave mancante in `permission`.
 * Un codice suo, non `forbidden` (ruling R44): quello lo dà già la guardia
 * della rotta, e i client devono poter dire PERCHÉ. Un full admin passa sempre.
 */
export function assertNoEscalation(
  actor: Actor,
  permissions: Iterable<string>,
  held: ReadonlySet<string> = actor.instancePermissions,
): void {
  const [p] = missingToGrant(actor, permissions, held);
  if (p !== undefined) {
    throw new RoleRuleError(403, "escalation", `You cannot grant a permission you do not have (${p})`, { permission: p });
  }
}

/**
 * Ciò che a chi agisce manca per dare `permissions` (vuoto = si può): la regola
 * di {@link assertNoEscalation}, in UN posto. Le letture calcolate dell'area 9
 * (`missing` dei ruoli, delle scelte, delle bozze) la usano tale e quale, così
 * il client non la deduce e la lettura non diverge dalla scrittura.
 */
export function missingToGrant(
  actor: Actor,
  permissions: Iterable<string>,
  held: ReadonlySet<string> = actor.instancePermissions,
): string[] {
  if (isFullAdmin(actor)) return [];
  return [...new Set(permissions)].filter((p) => !held.has(p));
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
  if ((await fullAdminCount(tx, opts)) === 0) {
    throw new RoleRuleError(
      409,
      "last_full_admin",
      "At least one user must keep full administration",
    );
  }
}

/** Quanti full admin ATTIVI che possono entrare, con le esclusioni date: il conteggio di {@link assertFullAdminRemains}. */
async function fullAdminCount(db: DbOrTx, opts: { excludingRoleId?: string; excludingUserId?: string } = {}): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.instanceRoleId))
    .where(
      and(
        sql`${roles.permissions} @> array['instance.full_admin']::text[]`,
        // L'utente di sistema «Claude» non è un amministratore che possa entrare
        // (non entra mai): anche con un preset User allargato non conta (review
        // dell'area 3, punto 9).
        eq(users.isAgent, false),
        // Area 9, F1: un full admin disattivato non entra, quindi non conta.
        isNull(users.deactivatedAt),
        opts.excludingRoleId ? sql`${roles.id} <> ${opts.excludingRoleId}` : undefined,
        opts.excludingUserId ? sql`${users.id} <> ${opts.excludingUserId}` : undefined,
      ),
    );
  return Number(row?.value ?? 0);
}

/**
 * Area 9, F1 (le letture calcolate): toglierle l'amministrazione (cambio di
 * ruolo, disattivazione) lascerebbe l'istanza senza full admin? La stessa
 * regola di {@link assertFullAdminRemains}, letta senza scrivere.
 */
export async function isLastActiveFullAdmin(db: DbOrTx, userId: string): Promise<boolean> {
  const [me] = await db
    .select({ permissions: roles.permissions })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.instanceRoleId))
    .where(and(eq(users.id, userId), isNull(users.deactivatedAt), eq(users.isAgent, false)));
  if (!me || !me.permissions.includes("instance.full_admin")) return false;
  return (await fullAdminCount(db, { excludingUserId: userId })) === 0;
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
 * I permessi di progetto che chi agisce ha «sopra» un ruolo di progetto:
 * quelli che ha in OGNI progetto dove il ruolo è assegnato O promesso da un
 * invito pendente (la modifica lo rende effettivo lì, e un invito accettato
 * non si riverifica). Un ruolo né assegnato né promesso (o nuovo) non è
 * effettivo da nessuna parte: bastano i permessi che ha in almeno un progetto
 * — assegnarlo poi richiederà comunque di averli nel progetto dell'assegnazione.
 */
export async function heldForProjectRole(
  db: DbOrTx,
  actor: Actor,
  roleId: string | null,
): Promise<Set<string>> {
  const mine = await db
    .select({
      projectId: projectMembers.projectId,
      permissions: sql<string[]>`${memberPermissionsSql(roles.permissions, projectMembers.projectId, projectMembers.userId)}`,
    })
    .from(projectMembers)
    .innerJoin(roles, eq(roles.id, projectMembers.roleId))
    .where(eq(projectMembers.userId, actor.id));
  const byProject = new Map(mine.map((m) => [m.projectId, new Set(m.permissions)]));
  const assigned = roleId
    ? [
        ...new Set([
          ...(
            await db
              .selectDistinct({ projectId: projectMembers.projectId })
              .from(projectMembers)
              .where(eq(projectMembers.roleId, roleId))
          ).map((r) => r.projectId),
          ...(
            await db
              .selectDistinct({ projectId: inviteProjects.projectId })
              .from(inviteProjects)
              .where(eq(inviteProjects.roleId, roleId))
          ).map((r) => r.projectId),
        ]),
      ]
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
 * Rinomina e/o cambia i permessi. I permessi AGGIUNTI passano dal controllo
 * anti-escalation; togliere non chiede niente (area 9, D-2: niente gerarchia
 * fra persone, R30 non c'è più). Togliere un permesso può togliere l'ultimo
 * full admin: lì c'è la guardia.
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

export async function deleteRole(db: Db, actor: Actor, id: string): Promise<void> {
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

/**
 * Il ruolo da assegnare, letto e bloccato `FOR SHARE` dentro la transazione
 * che lo assegna: fino al commit nessuno lo modifica né lo elimina, quindi i
 * permessi controllati sono quelli che entrano in vigore. Sparito nel
 * frattempo → 404, mai un errore di vincolo.
 */
async function sharedRole(
  tx: Tx,
  roleId: string,
  scope: RoleScope,
): Promise<{ id: string; permissions: string[] }> {
  const [role] = await tx
    .select({ id: roles.id, scope: roles.scope, permissions: roles.permissions })
    .from(roles)
    .where(eq(roles.id, roleId))
    .for("share");
  if (!role) throw new RoleRuleError(404, "role_not_found", "Role not found");
  if (role.scope !== scope) {
    throw new RoleRuleError(
      400,
      "invalid_role_scope",
      `Not a${scope === "instance" ? "n instance" : " project"} role`,
    );
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
  await db.transaction(async (tx) => {
    const role = await sharedRole(tx, roleId, "instance");
    assertNoEscalation(actor, effectiveInstancePermissions(role.permissions));
    // Niente bersaglio protetto (area 9, D-2): la riga si blocca solo perché
    // il cambio e la guardia dell'ultimo full admin leggano lo stesso stato.
    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!target) throw new RoleRuleError(404, "user_not_found", "User not found");
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
 * copra anche l'eliminazione quando ci sarà.
 */
export async function deleteUser(db: Db, actor: Actor, userId: string): Promise<void> {
  if (userId === actor.id) {
    throw new RoleRuleError(400, "cannot_delete_self", "You cannot delete your own account");
  }
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(users)
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    if (!deleted) throw new RoleRuleError(404, "user_not_found", "User not found");
    await assertFullAdminRemains(tx);
  });
}

// ── Membri di progetto ──────────────────────────────────────────────────

/** Da dove viene un permesso effettivo di un membro (area 9, F1). */
export type MemberPermissionSourceRow =
  | { kind: "role"; roleId: string }
  | { kind: "grant"; byUserId: string | null; at: string };

export interface MemberRow {
  userId: string;
  email: string;
  avatarUrl: string | null;
  roleId: string;
  roleName: string;
  createdAt: Date;
  /** I permessi EFFETTIVI nel progetto (ruolo ∪ personali), con la provenienza. */
  permissions: { permission: string; sources: MemberPermissionSourceRow[] }[];
}

const memberSelection = {
  userId: projectMembers.userId,
  email: users.email,
  avatarUrl: users.slackAvatarUrl,
  roleId: projectMembers.roleId,
  roleName: roles.name,
  rolePermissions: roles.permissions,
  createdAt: projectMembers.createdAt,
};

/** I membri di un progetto (o uno solo), coi permessi effettivi e la loro provenienza. */
async function membersWithPermissions(db: DbOrTx, projectId: string, onlyUserId?: string): Promise<MemberRow[]> {
  const rows = await db
    .select(memberSelection)
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .innerJoin(roles, eq(roles.id, projectMembers.roleId))
    .where(and(eq(projectMembers.projectId, projectId), ...(onlyUserId ? [eq(projectMembers.userId, onlyUserId)] : [])))
    .orderBy(users.email);
  const grants = await db
    .select()
    .from(projectMemberPermissions)
    .where(and(eq(projectMemberPermissions.projectId, projectId), ...(onlyUserId ? [eq(projectMemberPermissions.userId, onlyUserId)] : [])));
  const known = new Set<string>(PROJECT_PERMISSIONS);
  return rows.map(({ rolePermissions, ...row }) => {
    const sources = new Map<string, MemberPermissionSourceRow[]>();
    const add = (permission: string, source: MemberPermissionSourceRow) => {
      if (!known.has(permission)) return;
      sources.set(permission, [...(sources.get(permission) ?? []), source]);
    };
    for (const p of rolePermissions) add(p, { kind: "role", roleId: row.roleId });
    for (const g of grants) if (g.userId === row.userId) add(g.permission, { kind: "grant", byUserId: g.grantedByUserId, at: g.grantedAt.toISOString() });
    return { ...row, permissions: PROJECT_PERMISSIONS.filter((p) => sources.has(p)).map((p) => ({ permission: p, sources: sources.get(p)! })) };
  });
}

export async function listProjectMembers(db: DbOrTx, projectId: string): Promise<MemberRow[]> {
  return membersWithPermissions(db, projectId);
}

/** Una chiave del lock advisory per i membri di UN progetto (la regola dell'ultimo gestore). */
const membersLock = (projectId: string) => sql`select pg_advisory_xact_lock(hashtext(${`members:${projectId}`}))`;

/** Quanti gestori dei membri (ruolo o personale) ha il progetto, fuori dai full admin. */
async function managerCount(tx: DbOrTx, projectId: string, excludingUserId?: string): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n
    from ${projectMembers} lm_pm
    join ${roles} lm_r on lm_r.id = lm_pm.role_id
    join ${users} lm_u on lm_u.id = lm_pm.user_id
    join ${roles} lm_ir on lm_ir.id = lm_u.instance_role_id
    where lm_pm.project_id = ${projectId}
      -- Solo i gestori ATTIVI (review di F1, m4): un disattivato non gestisce.
      and lm_u.deactivated_at is null
      and (${excludingUserId ?? null}::uuid is null or lm_pm.user_id <> ${excludingUserId ?? null}::uuid)
      and not (lm_ir.permissions @> array['instance.full_admin']::text[])
      and ${memberPermissionsSql(sql`lm_r.permissions`, sql`lm_pm.project_id`, sql`lm_pm.user_id`)} @> array['project.members.manage']::text[]
  `);
  return Number(row?.n ?? 0);
}

/**
 * Un progetto non resta senza un gestore dei membri fuori dai full admin
 * (area 9, F1, `last_manager`): la scrittura fatta in `write` si annulla se
 * porta da almeno uno a zero. Un progetto che non ne aveva (lo gestivano i soli
 * full admin) non si blocca.
 */
/**
 * Area 9, F1 (le letture calcolate): il primo progetto (per id) che
 * resterebbe senza un gestore attivo se `userId` smettesse di gestirlo, o
 * `null`. La regola di {@link keepingManagersIn}, letta senza scrivere.
 */
export async function lastManagerProjectOf(db: DbOrTx, userId: string, onlyProjectIds?: readonly string[]): Promise<string | null> {
  const mine = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.userId, userId), ...(onlyProjectIds ? [inArray(projectMembers.projectId, [...onlyProjectIds])] : [])));
  for (const projectId of mine.map((m) => m.projectId).sort()) {
    if ((await managerCount(db, projectId)) > 0 && (await managerCount(db, projectId, userId)) === 0) return projectId;
  }
  return null;
}

/**
 * La stessa regola per una scrittura che tocca PIÙ progetti insieme (la
 * disattivazione di una persona, review di F1, m4): lock in ordine di id, poi
 * la scrittura, poi il controllo. Il 409 porta il `projectId` che resterebbe
 * senza gestori.
 */
export async function keepingManagersIn(tx: Tx, projectIds: readonly string[], write: () => Promise<void>): Promise<void> {
  const ordered = [...new Set(projectIds)].sort();
  const before = new Map<string, number>();
  for (const projectId of ordered) {
    await tx.execute(membersLock(projectId));
    before.set(projectId, await managerCount(tx, projectId));
  }
  await write();
  for (const projectId of ordered) {
    if (before.get(projectId)! > 0 && (await managerCount(tx, projectId)) === 0) {
      throw new RoleRuleError(409, "last_manager", "The project would be left without anyone who manages its members", { projectId });
    }
  }
}

async function keepingAManager(tx: Tx, projectId: string, write: () => Promise<void>): Promise<void> {
  await tx.execute(membersLock(projectId));
  const before = await managerCount(tx, projectId);
  await write();
  if (before > 0 && (await managerCount(tx, projectId)) === 0) {
    throw new RoleRuleError(409, "last_manager", "The project would be left without anyone who manages its members");
  }
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
  permissions?: readonly string[],
): Promise<MemberRow> {
  const wanted = permissions ? [...new Set(permissions)] : undefined;
  if (wanted) {
    const unknown = unknownPermissionsFor("project", wanted);
    if (unknown.length > 0) {
      throw new RoleRuleError(422, "unknown_permission", `Not a project permission: ${unknown[0]}`, { permission: unknown[0]! });
    }
  }
  await db.transaction(async (tx) => {
    const role = await sharedRole(tx, roleId, "project");
    assertNoEscalation(actor, role.permissions, held);
    const [user] = await tx
      .select({ id: users.id, deactivatedAt: users.deactivatedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for("share");
    if (!user) throw new RoleRuleError(404, "user_not_found", "User not found");
    // Review di F1 (m9): una persona disattivata non entra in un progetto.
    if (user.deactivatedAt) throw new RoleRuleError(422, "user_deactivated", "This person is deactivated");
    await keepingAManager(tx, projectId, async () => {
      // La riga (se c'è) si blocca: niente bersaglio protetto (area 9, D-2).
      await lockedMemberPermissions(tx, projectId, userId);
      await tx
        .insert(projectMembers)
        .values({ projectId, userId, roleId })
        .onConflictDoUpdate({
          target: [projectMembers.projectId, projectMembers.userId],
          set: { roleId },
        });
      if (!wanted) return;
      // I permessi personali: l'insieme COMPLETO dopo il salvataggio. Si dà solo
      // ciò che si ha (escalation sugli AGGIUNTI); togliere non chiede niente.
      const current = await tx
        .select({ permission: projectMemberPermissions.permission })
        .from(projectMemberPermissions)
        .where(and(eq(projectMemberPermissions.projectId, projectId), eq(projectMemberPermissions.userId, userId)));
      const had = new Set(current.map((c) => c.permission));
      const added = wanted.filter((p) => !had.has(p));
      assertNoEscalation(actor, added, held);
      const removed = [...had].filter((p) => !wanted.includes(p));
      if (removed.length > 0) {
        await tx
          .delete(projectMemberPermissions)
          .where(
            and(
              eq(projectMemberPermissions.projectId, projectId),
              eq(projectMemberPermissions.userId, userId),
              inArray(projectMemberPermissions.permission, removed),
            ),
          );
      }
      if (added.length > 0) {
        await tx.insert(projectMemberPermissions).values(added.map((permission) => ({ projectId, userId, permission, grantedByUserId: actor.id })));
      }
    });
  });
  return (await membersWithPermissions(db, projectId, userId))[0]!;
}

/** Toglie un membro. Togliere non chiede niente (area 9, D-2: niente gerarchia fra persone). */
export async function removeProjectMember(
  db: Db,
  actor: Actor,
  held: ReadonlySet<string>,
  projectId: string,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await keepingAManager(tx, projectId, async () => {
      const current = await lockedMemberPermissions(tx, projectId, userId);
      if (!current) throw new RoleRuleError(404, "member_not_found", "Member not found");
      await tx
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
    });
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
 * Verifica e salva ruolo d'istanza e progetti di un invito, dentro la
 * transazione che crea l'invito (i ruoli restano bloccati `FOR SHARE` fino al
 * commit). Regole di chi invita: per ogni progetto servono
 * `project.members.manage` lì (un progetto che non si vede è 404, come
 * altrove) e i permessi del ruolo in quel progetto; il ruolo d'istanza va
 * tenuto nei propri permessi d'istanza. Da chiamare PRIMA dell'insert
 * dell'invito.
 *
 * Senza `instanceRoleId` l'invitato riceverebbe il preset `User`: la regola
 * vale anche per lui (ruling R51), quindi il preset si risolve QUI, si
 * verifica come un ruolo scelto e il suo id si salva sull'invito. Altrimenti
 * chi ha solo `users.invite` darebbe, omettendo il ruolo, permessi che non ha.
 * Restituisce l'id del ruolo d'istanza da salvare.
 */
export async function assertInviteGrants(
  tx: Tx,
  actor: Actor,
  instanceRoleId: string | undefined,
  grants: readonly InviteProject[],
): Promise<string> {
  const seen = new Set<string>();
  for (const grant of grants) {
    if (seen.has(grant.projectId)) {
      throw new RoleRuleError(400, "duplicate_project", "A project appears more than once");
    }
    seen.add(grant.projectId);
    const held = await projectPermissionsFor(tx, actor, grant.projectId);
    if (!held) throw new RoleRuleError(404, "not_found", "Not found");
    if (!held.has("project.members.manage")) {
      throw new RoleRuleError(403, "forbidden", "Missing permission");
    }
    const role = await sharedRole(tx, grant.roleId, "project");
    assertNoEscalation(actor, role.permissions, held);
  }
  const roleId = instanceRoleId ?? (await userPresetId(tx));
  const role = await sharedRole(tx, roleId, "instance");
  assertNoEscalation(actor, effectiveInstancePermissions(role.permissions));
  return role.id;
}

/** Il preset d'istanza `User` (non eliminabile finché esiste `users.role`, ruling R9). */
async function userPresetId(tx: Tx): Promise<string> {
  const [row] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.presetKey, "user"), eq(roles.scope, "instance")));
  if (!row) {
    throw new RoleRuleError(409, "role_required_by_system", "The User preset role is missing");
  }
  return row.id;
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

/**
 * Applica all'invitato i progetti dell'invito. Ognuno si RIVERIFICA coi
 * permessi ATTUALI di chi ha invitato (ruling R51): fra l'invito e
 * l'accettazione l'invitante può aver perso `project.members.manage` nel
 * progetto, o i permessi del ruolo promesso, o non esistere più
 * (`invitedByUserId` nullo). Una concessione non più valida si scarta —
 * l'utente nasce lo stesso, senza quel progetto — e lo si dice in `onDropped`
 * (una riga di log): la registrazione non fallisce per una scelta altrui.
 */
export async function applyInviteGrants(
  tx: Tx,
  userId: string,
  grants: readonly InviteProject[],
  invitedByUserId: string | null,
  onDropped: (grant: InviteProject, reason: string) => void = () => {},
): Promise<void> {
  if (grants.length === 0) return;
  const valid: InviteProject[] = [];
  const held = invitedByUserId
    ? await projectPermissionsByProject(
        tx,
        invitedByUserId,
        grants.map((g) => g.projectId),
      )
    : new Map<string, ReadonlySet<string> | null>();
  for (const grant of grants) {
    const perms = held.get(grant.projectId) ?? null;
    if (!perms || !perms.has("project.members.manage")) {
      onDropped(grant, invitedByUserId ? "inviter_cannot_manage_members" : "inviter_missing");
      continue;
    }
    const [role] = await tx
      .select({ permissions: roles.permissions })
      .from(roles)
      .where(eq(roles.id, grant.roleId))
      .for("share");
    const missing = role?.permissions.find((p) => !perms.has(p));
    if (!role || missing) {
      onDropped(grant, "inviter_lacks_role_permissions");
      continue;
    }
    valid.push(grant);
  }
  if (valid.length === 0) return;
  await tx
    .insert(projectMembers)
    .values(valid.map((g) => ({ projectId: g.projectId, userId, roleId: g.roleId })));
}
