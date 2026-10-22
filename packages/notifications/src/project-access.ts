/**
 * I PERMESSI DI UN UTENTE IN UN PROGETTO, letti dal DB, per chi non ha una
 * sessione in mano: il routing delle notifiche (`./publish.ts`), il poller
 * delle consegne del worker (bottoni del DM Slack) e i servizi del server che
 * agiscono per conto di un id (inbox, Slack, pulse, domande). Design
 * `docs/plans/2026-10-22-permessi-progetto-design.md`.
 *
 * Sta QUI e non in `apps/server/src/auth/access.ts` per la stessa ragione di
 * `unread.ts`: il worker non può importare da `apps/server`, e due copie della
 * regola «chi vede il progetto e con quali permessi» divergerebbero alla prima
 * modifica. Il server ri-usa queste funzioni (`projectPermissionsOfUser` in
 * `access.ts` le delega).
 */
import { projectMembers, roles, users } from "@stubwise/db";
import {
  effectiveInstancePermissions,
  effectiveProjectPermissions,
  INSTANCE_PERMISSIONS,
  type InstancePermission,
  type ProjectPermission,
} from "@stubwise/shared";
import { and, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "./dispatch.js";

/** Il ruolo di progetto dell'appartenenza, accanto a quello d'istanza. */
const memberRoles = alias(roles, "member_roles");

/**
 * Condizione SQL: l'utente `userId` (una colonna o un'espressione) ha
 * `instance.full_admin` nel suo ruolo d'istanza. L'UNICA copia del predicato:
 * la usano la visibilità delle card (`inbox-visibility.ts`), il routing e
 * l'elenco utenti del server. Le tabelle sono aliasate (`fa_u`, `fa_r`), così
 * una colonna esterna di `users` passata come `userId` resta quella esterna.
 */
export function userIsFullAdmin(userId: AnyColumn | SQL): SQL {
  return sql`exists (
    select 1 from ${users} fa_u
    inner join ${roles} fa_r on fa_r.id = fa_u.instance_role_id
    where fa_u.id = ${userId}
      and fa_r.permissions @> array['instance.full_admin']::text[]
  )`;
}

/**
 * Permessi effettivi di `userId` in `projectId`. `null` = non lo vede: utente
 * inesistente, progetto inesistente, oppure né membro né full admin. Un full
 * admin li ha tutti, membro o no.
 */
export async function projectPermissionsOfUser(
  db: DbOrTx,
  userId: string,
  projectId: string,
): Promise<ReadonlySet<ProjectPermission> | null> {
  const byProject = await projectPermissionsByProject(db, userId, [projectId]);
  return byProject.get(projectId) ?? null;
}

/**
 * Come {@link projectPermissionsOfUser}, per più progetti in UNA query (una
 * pagina d'inbox non ne fa una per card). Ogni progetto chiesto è nella mappa;
 * quelli che l'utente non vede valgono `null`. Un progetto inesistente per un
 * full admin vale l'insieme completo: chi chiede un id lo ha letto da una riga
 * che lo referenzia (FK), quindi il caso non si presenta.
 */
export async function projectPermissionsByProject(
  db: DbOrTx,
  userId: string,
  projectIds: readonly string[],
): Promise<Map<string, ReadonlySet<ProjectPermission> | null>> {
  const result = new Map<string, ReadonlySet<ProjectPermission> | null>();
  const unique = [...new Set(projectIds)];
  if (unique.length === 0) return result;
  // Ruolo d'istanza + le appartenenze ai progetti chiesti, in una riga per
  // appartenenza (una sola, con l'appartenenza nulla, se non ce ne sono).
  const rows = await db
    .select({
      instancePermissions: roles.permissions,
      projectId: projectMembers.projectId,
      memberPermissions: memberRoles.permissions,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.instanceRoleId))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.userId, users.id), inArray(projectMembers.projectId, unique)),
    )
    .leftJoin(memberRoles, eq(memberRoles.id, projectMembers.roleId))
    .where(eq(users.id, userId));
  if (rows.length === 0) {
    for (const id of unique) result.set(id, null);
    return result;
  }
  const instance = effectiveInstancePermissions(rows[0]!.instancePermissions);
  const memberPerms = new Map<string, string[]>();
  for (const row of rows) {
    if (row.projectId && row.memberPermissions) memberPerms.set(row.projectId, row.memberPermissions);
  }
  for (const id of unique) {
    result.set(id, effectiveProjectPermissions(instance, memberPerms.get(id) ?? null));
  }
  return result;
}

/** Gli id di tutti i full admin dell'istanza. */
async function fullAdminIds(db: DbOrTx): Promise<string[]> {
  const rows = await db.select({ id: users.id }).from(users).where(userIsFullAdmin(users.id));
  return rows.map((row) => row.id);
}

/**
 * Chi VEDE il progetto: i suoi membri più i full admin (membri impliciti di
 * ogni progetto). È il filtro dei destinatari di ogni evento di progetto.
 */
export async function projectViewerIds(db: DbOrTx, projectId: string): Promise<string[]> {
  const members = await db
    .select({ id: projectMembers.userId })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));
  return [...new Set([...members.map((row) => row.id), ...(await fullAdminIds(db))])];
}

const INSTANCE_PERMISSION_SET: ReadonlySet<string> = new Set(INSTANCE_PERMISSIONS);

/**
 * Chi ha `permission`: i full admin sempre, più
 *  - per un permesso d'ISTANZA, chi ce l'ha nel ruolo d'istanza;
 *  - per un permesso di PROGETTO, i membri di `projectId` il cui ruolo lo
 *    contiene (senza progetto: nessuno oltre ai full admin — un permesso di
 *    progetto non vale «su un progetto qualsiasi»).
 * `permission` nullo = nessun permesso pertinente: i soli full admin.
 */
export async function userIdsWithPermission(
  db: DbOrTx,
  permission: InstancePermission | ProjectPermission | null,
  projectId: string | null,
): Promise<string[]> {
  const ids = await fullAdminIds(db);
  if (permission === null) return ids;
  if (INSTANCE_PERMISSION_SET.has(permission)) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.instanceRoleId))
      .where(sql`${roles.permissions} @> array[${permission}]::text[]`);
    return [...new Set([...ids, ...rows.map((row) => row.id)])];
  }
  if (projectId === null) return ids;
  const rows = await db
    .select({ id: projectMembers.userId })
    .from(projectMembers)
    .innerJoin(roles, eq(roles.id, projectMembers.roleId))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        sql`${roles.permissions} @> array[${permission}]::text[]`,
      ),
    );
  return [...new Set([...ids, ...rows.map((row) => row.id)])];
}
