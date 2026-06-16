import { eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentRuns, aiJobs } from "./schema.js";

/**
 * Somma i costi (USD) dei run dell'agente di un ticket, joinando agent_runs ai
 * job AI del ticket. I run con cost_usd NULL contano 0 (coalesce), e un ticket
 * senza run torna 0. La somma di numeric in Postgres è una stringa (o null se
 * non ci sono righe): coalesce a 0 lato SQL e conversione a number qui.
 */
export async function ticketCostUsd(db: Db, ticketId: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(coalesce(${agentRuns.costUsd}, 0)), 0)`,
    })
    .from(agentRuns)
    .innerJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
    .where(eq(aiJobs.ticketId, ticketId));
  return Number(row?.total ?? 0);
}

/**
 * Somma i costi (USD) di tutti i run dell'agente del mese corrente, dove
 * "mese corrente" è da date_trunc('month', now()) in poi. Stessa gestione
 * NULL→0 di ticketCostUsd; torna 0 se non ci sono run nel mese.
 */
export async function monthlyCostUsd(db: Db): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(coalesce(${agentRuns.costUsd}, 0)), 0)`,
    })
    .from(agentRuns)
    .where(gte(agentRuns.createdAt, sql`date_trunc('month', now())`));
  return Number(row?.total ?? 0);
}
