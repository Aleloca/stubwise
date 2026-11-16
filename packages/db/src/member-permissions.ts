import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { projectMemberPermissions } from "./schema.js";

/**
 * Area 9, F1: i permessi di un membro nel SUO progetto come espressione SQL,
 * ruolo ∪ permessi personali (`project_member_permissions`). È il pezzo SQL
 * della regola «I permessi effettivi in un progetto sono UNA funzione»
 * (docs/invariants/permissions.md): ogni WHERE e ogni lettura che parte dai
 * permessi del ruolo di un membro passa da qui, mai da `roles.permissions` da
 * solo. Il full admin implicito resta a chi chiama (`effectiveProjectPermissions`,
 * `userIsFullAdmin`).
 *
 * `rolePermissions` è la colonna `permissions` del ruolo del membro (anche
 * un alias), `projectId` e `userId` quelle dell'appartenenza. Con un LEFT JOIN
 * senza appartenenza il ruolo è NULL e il risultato è NULL: «non membro».
 */
export function memberPermissionsSql(rolePermissions: AnyColumn | SQL, projectId: AnyColumn | SQL, userId: AnyColumn | SQL): SQL<string[] | null> {
  return sql<string[] | null>`(case when ${rolePermissions} is null then null else ${rolePermissions} || coalesce((
    select array_agg(mp_g.permission) from ${projectMemberPermissions} mp_g
    where mp_g.project_id = ${projectId} and mp_g.user_id = ${userId}
  ), '{}'::text[]) end)`;
}
