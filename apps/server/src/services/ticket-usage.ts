import { agentRuns, aiJobs, type Db } from "@stubwise/db";
import { eq, sql } from "drizzle-orm";

/** I consumi AI di una task per modello: token interi, costo in USD (null = nessun run col costo). */
export interface ModelUsageRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
}

/**
 * I consumi AI di una task, per modello, su tutta la sua vita (`agent_runs` dei
 * suoi job). UN conto per `/api/tickets/:id/usage` e per `/work` (rimandi,
 * lotto 4, §7.3), così le due letture non divergono; l'ordine lo sceglie chi
 * legge.
 */
export async function ticketUsageByModel(db: Db, ticketId: string): Promise<ModelUsageRow[]> {
  const rows = await db
    .select({
      model: agentRuns.model,
      inputTokens: sql<number>`sum(${agentRuns.inputTokens})::int`,
      outputTokens: sql<number>`sum(${agentRuns.outputTokens})::int`,
      cacheReadTokens: sql<number>`sum(${agentRuns.cacheReadTokens})::int`,
      // numeric → stringa lato driver; null se tutti i costi sono null.
      costUsd: sql<string | null>`sum(${agentRuns.costUsd})`,
    })
    .from(agentRuns)
    .innerJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
    .where(eq(aiJobs.ticketId, ticketId))
    .groupBy(agentRuns.model)
    .orderBy(agentRuns.model);
  return rows.map((row) => ({
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    costUsd: row.costUsd !== null ? Number(row.costUsd) : null,
  }));
}

/** Dal costo più alto, i senza costo in fondo, poi per modello (il prototipo, `usageOfTask`). */
export function byCostDesc(rows: readonly ModelUsageRow[]): ModelUsageRow[] {
  return [...rows].sort((a, b) => {
    if (a.costUsd === null || b.costUsd === null) return a.costUsd === b.costUsd ? a.model.localeCompare(b.model) : a.costUsd === null ? 1 : -1;
    return b.costUsd - a.costUsd || a.model.localeCompare(b.model);
  });
}
