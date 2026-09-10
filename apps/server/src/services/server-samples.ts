import { desc, inArray } from "drizzle-orm";
import { serverMetrics, type Db } from "@stubwise/db";
import type { DiscoveredService } from "@stubwise/shared";

/**
 * Servizi scoperti dall'ULTIMO campione di ciascun server, uno solo per
 * `serverId` (query batch, niente N+1): il DISTINCT ON tiene la prima riga
 * per server nell'ordine dato — `serverId`, `ts desc` — cioè l'ultima.
 *
 * Condiviso fra la rotta degli ambienti (fase 8, Task 4 — "cosa gira
 * sull'ambiente collegato") e la coda di rilascio (Task 9 — "questa PR è già
 * su staging?"): stessa lettura, due domande diverse sullo stesso dato.
 */
export async function loadLatestServicesByServer(
  db: Db,
  serverIds: string[],
): Promise<Map<string, DiscoveredService[]>> {
  if (serverIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([serverMetrics.serverId], {
      serverId: serverMetrics.serverId,
      services: serverMetrics.services,
    })
    .from(serverMetrics)
    .where(inArray(serverMetrics.serverId, serverIds))
    .orderBy(serverMetrics.serverId, desc(serverMetrics.ts));
  return new Map(rows.map((r) => [r.serverId, r.services]));
}
