import { productDocJobs, productFirstVersions, productPageUpdates, productWireframes, type Db } from "@stubwise/db";
import { projectPermissionsByProject } from "@stubwise/notifications";
import { eq } from "drizzle-orm";

/**
 * Lo scavalco del budget di un lavoro della doc (D-7.1, 0223) VALE ancora?
 * Review del lotto 5, decisione di 46: `budget_bypass` lo scrive il server
 * alla richiesta, ma il permesso può essere tolto dopo. Si RILEGGE quando il
 * lavoro parte, come `page_update` rilegge `docs.edit`: chi l'ha chiesto (la
 * riga della fonte lo tiene già — `started_by` della prima versione,
 * `requested_by` della bozza e dell'aggiornamento) deve avere ADESSO
 * `plans.approve` nel progetto. Senza, il lavoro torna a rispettare il budget.
 */
export async function budgetBypassHolds(db: Db, job: typeof productDocJobs.$inferSelect): Promise<boolean> {
  if (!job.budgetBypass) return false;
  const requester = await requesterOf(db, job);
  if (requester === null) return false;
  const perms = (await projectPermissionsByProject(db, requester, [job.projectId])).get(job.projectId);
  return perms?.has("plans.approve") === true;
}

async function requesterOf(db: Db, job: typeof productDocJobs.$inferSelect): Promise<string | null> {
  if (job.sourceKind === "first_version") {
    const [r] = await db.select({ by: productFirstVersions.startedBy }).from(productFirstVersions).where(eq(productFirstVersions.id, job.sourceId));
    return r?.by ?? null;
  }
  if (job.sourceKind === "wireframe") {
    const [r] = await db.select({ by: productWireframes.requestedBy }).from(productWireframes).where(eq(productWireframes.id, job.sourceId));
    return r?.by ?? null;
  }
  if (job.sourceKind === "page_update") {
    const [r] = await db.select({ by: productPageUpdates.requestedBy }).from(productPageUpdates).where(eq(productPageUpdates.id, job.sourceId));
    return r?.by ?? null;
  }
  return null;
}
