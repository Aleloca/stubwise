import { backlogItemRequesters, backlogItems } from "@stubwise/db";
import { inArray, or, sql, type SQL } from "drizzle-orm";
import { inProjects, isAllProjects, type ProjectScope } from "../auth/access.js";

/**
 * La regola di `backlog.view_all` come condizione SQL su `backlog_items` (la
 * stessa di `canSeeBacklogItem`): `viewAll` sono i progetti in cui chi guarda
 * ha il permesso (un full admin: ovunque tranne gli archiviati, F6); fuori
 * da quelli, solo le voci di cui è richiedente. Sta nella WHERE, così anche
 * `total` la rispetta.
 */
export function backlogVisibleSql(viewAll: ProjectScope, userId: string): SQL | undefined {
  if (isAllProjects(viewAll)) return inProjects(backlogItems.projectId, viewAll);
  const own = sql`exists (
    select 1 from ${backlogItemRequesters}
    where ${backlogItemRequesters.itemId} = ${backlogItems.id}
      and ${backlogItemRequesters.userId} = ${userId}
  )`;
  return viewAll.length > 0 ? or(inArray(backlogItems.projectId, [...viewAll]), own) : own;
}
