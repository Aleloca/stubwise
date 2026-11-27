import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { departmentMembers, departmentProjectPermissions, projectAccess, projectMemberPermissions, roles, users } from "./schema.js";

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

/**
 * Workspace (0238, `docs/plans/2026-11-27-workspace-design.md` §1.3–1.4): i
 * permessi di `userId` in `projectId` come UNIONE delle fonti, letta dalla
 * vista `project_access` (una riga per fonte): i ruoli di TUTTE le righe
 * (membro esplicito e workspace) ∪ i permessi personali (esistono solo con la
 * riga `project_members`, FK) ∪ i permessi di progetto dei suoi reparti (D10:
 * anche dove è membro per workspace). `null` = nessuna riga: non membro, e un
 * reparto non rende membri. Mai a un utente di sistema (Claude, R-L9): né i
 * reparti né la workspace. «Vince il più alto» è questa unione (D1: un
 * override non toglie niente). Il full admin implicito resta a chi chiama.
 *
 * È LA regola: ogni WHERE e ogni lettura di visibilità o di permesso passa da
 * qui (o da {@link projectAccessSql}), mai da `project_members` da sola.
 */
export function projectAccessPermissionsSql(projectId: AnyColumn | SQL, userId: AnyColumn | SQL): SQL<string[] | null> {
  // I due valori si legano PRIMA in una sottoquery senza FROM (`k`): in una
  // select su una tabella sola Drizzle scrive le colonne senza qualificarle
  // (`"id"`), e dentro le sottoquery sotto un `"id"` nudo finirebbe su
  // un'altra tabella. Da `k` in giù si usano solo `k.pid` e `k.uid`.
  return sql<string[] | null>`(select case when not exists (
    select 1 from ${projectAccess} pa_x join ${users} u_x on u_x.id = pa_x.user_id
    where pa_x.project_id = k.pid and pa_x.user_id = k.uid and (pa_x.source = 'member' or not u_x.is_agent)
  ) then null else coalesce((
    select array_agg(r_a.permission) from ${projectAccess} pa_a
    join ${users} u_a on u_a.id = pa_a.user_id
    join ${roles} ro_a on ro_a.id = pa_a.role_id
    cross join lateral unnest(ro_a.permissions) as r_a(permission)
    where pa_a.project_id = k.pid and pa_a.user_id = k.uid and (pa_a.source = 'member' or not u_a.is_agent)
  ), '{}'::text[]) || coalesce((
    select array_agg(mp_a.permission) from ${projectMemberPermissions} mp_a
    where mp_a.project_id = k.pid and mp_a.user_id = k.uid
  ), '{}'::text[]) || coalesce((
    select array_agg(dp_a.permission) from ${departmentProjectPermissions} dp_a
    join ${departmentMembers} dm_a on dm_a.department_id = dp_a.department_id
    join ${users} du_a on du_a.id = dm_a.user_id
    where dm_a.user_id = k.uid and not du_a.is_agent
  ), '{}'::text[]) end from (select (${projectId})::uuid as pid, (${userId})::uuid as uid) k)`;
}

/**
 * `userId` accede a `projectId` (è membro per una delle due vie della vista,
 * senza contare il full admin implicito). Per le WHERE di visibilità.
 * Un utente di sistema conta solo come membro ESPLICITO (Claude non entra in
 * una workspace), la stessa condizione di {@link projectAccessPermissionsSql}.
 */
export function projectAccessSql(projectId: AnyColumn | SQL, userId: AnyColumn | SQL): SQL<boolean> {
  // Gli stessi `k.pid`/`k.uid` di {@link projectAccessPermissionsSql}, per la stessa ragione.
  return sql<boolean>`exists (
    select 1 from (select (${projectId})::uuid as pid, (${userId})::uuid as uid) k
    join ${projectAccess} pa_e on pa_e.project_id = k.pid and pa_e.user_id = k.uid
    join ${users} u_e on u_e.id = pa_e.user_id
    where pa_e.source = 'member' or not u_e.is_agent
  )`;
}

/**
 * Per chi legge DIRETTAMENTE le righe di `project_access` (chi vede un
 * progetto, i progetti di una persona): la riga conta, cioè non è la riga di
 * workspace di un utente di sistema. La stessa condizione di
 * {@link projectAccessSql}, sulle colonne della vista.
 */
export const projectAccessRowCounts: SQL<boolean> = sql<boolean>`(${projectAccess.source} = 'member' or not exists (
  select 1 from ${users} u_r where u_r.id = ${projectAccess.userId} and u_r.is_agent
))`;
