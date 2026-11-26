import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { departmentMembers, departmentProjectPermissions, projectMemberPermissions, users } from "./schema.js";

/**
 * Area 9, F1: i permessi di un membro nel SUO progetto come espressione SQL,
 * ruolo ∪ permessi personali (`project_member_permissions`) ∪ (F8) i permessi
 * di progetto dei suoi reparti (`department_project_permissions`). È il pezzo SQL
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
  // Area 9, F8 (0196, F8-1 = a): ∪ i permessi di progetto dei reparti della
  // persona, validi in ogni progetto di cui è GIÀ membro (il `case` resta: un
  // non membro ha null, un reparto non rende membri). Mai a un utente di
  // sistema (`is_agent`, R-L9: Claude non riceve permessi).
  return sql<string[] | null>`(case when ${rolePermissions} is null then null else ${rolePermissions} || coalesce((
    select array_agg(mp_g.permission) from ${projectMemberPermissions} mp_g
    where mp_g.project_id = ${projectId} and mp_g.user_id = ${userId}
  ), '{}'::text[]) || coalesce((
    select array_agg(dp_g.permission) from ${departmentProjectPermissions} dp_g
    join ${departmentMembers} dm_g on dm_g.department_id = dp_g.department_id
    join ${users} du_g on du_g.id = dm_g.user_id
    where dm_g.user_id = ${userId} and not du_g.is_agent
  ), '{}'::text[]) end)`;
}
