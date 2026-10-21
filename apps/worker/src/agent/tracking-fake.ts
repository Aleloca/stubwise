import { agentRuns, type Db } from "@stubwise/db";
import { asc } from "drizzle-orm";
import { TrackingAgentRunner } from "./tracking-runner.js";
import type { AgentRunner, AgentRunUsage } from "./runner.js";

/**
 * Supporto per i test dei call site (design 2026-10-21-modelli-e-consumi):
 * avvolge un runner finto nel VERO `TrackingAgentRunner`, come fa index.ts col
 * runner reale, così il test vede la riga che finisce in `agent_runs` e non
 * solo il tag passato al runner. Il resolver restituisce sempre il ripiego:
 * qui si prova l'etichetta, la scelta del modello la prova tracking-runner.test.
 */
export function trackedRunner(db: Db, inner: AgentRunner): TrackingAgentRunner {
  return new TrackingAgentRunner({ inner, db, models: { resolve: async (_op, fallback) => fallback } });
}

/** Consumi di un run su un solo modello, per i risultati scriptati. */
export function oneModelUsage(model = "claude-haiku-4-5"): AgentRunUsage {
  return {
    totalCostUsd: 0.01,
    models: [{ model, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 }],
  };
}

/** Le righe dei consumi, in ordine di scrittura. */
export async function usageRows(db: Db) {
  return db
    .select({
      operation: agentRuns.operation,
      projectId: agentRuns.projectId,
      phase: agentRuns.phase,
      jobId: agentRuns.jobId,
      emailMessageId: agentRuns.emailMessageId,
      runId: agentRuns.runId,
      model: agentRuns.model,
    })
    .from(agentRuns)
    .orderBy(asc(agentRuns.createdAt));
}
