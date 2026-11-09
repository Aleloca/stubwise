import { backlogItemRequesters, backlogItems } from "@stubwise/db";
import { inArray, or, sql, type SQL } from "drizzle-orm";

/**
 * La regola di `backlog.view_all` come condizione SQL su `backlog_items` (la
 * stessa di `canSeeBacklogItem`): `viewAll` sono i progetti in cui chi guarda
 * ha il permesso (`"all"` = ovunque, nessun filtro); fuori da quelli, solo le
 * voci di cui è richiedente. Sta nella WHERE, così anche `total` la rispetta.
 */
export function backlogVisibleSql(viewAll: "all" | readonly string[], userId: string): SQL | undefined {
  if (viewAll === "all") return undefined;
  const own = sql`exists (
    select 1 from ${backlogItemRequesters}
    where ${backlogItemRequesters.itemId} = ${backlogItems.id}
      and ${backlogItemRequesters.userId} = ${userId}
  )`;
  return viewAll.length > 0 ? or(inArray(backlogItems.projectId, [...viewAll]), own) : own;
}
