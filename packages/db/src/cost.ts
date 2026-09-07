import { eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentRunPhase, agentRuns, aiJobs } from "./schema.js";

/** Le fasi di `agent_runs`, nell'ordine dell'enum Postgres. */
export const AGENT_RUN_PHASES = agentRunPhase.enumValues;

/** Una fase di `agent_runs` (`triage | fix | review | email_classify`). */
export type AgentRunPhase = (typeof AGENT_RUN_PHASES)[number];

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
 * Somma i costi (USD) di TUTTI i run dell'agente del mese corrente, dove
 * "mese corrente" è da date_trunc('month', now()) in poi. Stessa gestione
 * NULL→0 di ticketCostUsd; torna 0 se non ci sono run nel mese.
 *
 * ⚠️ "tutti" è letterale, e va tenuto tale: NON c'è nessun join con `ai_jobs`,
 * quindi qui dentro finiscono anche i run che un job non ce l'hanno — la
 * review di una PR e, dalla fase 6, la CLASSIFICAZIONE DELLA POSTA
 * (`email_classify`). È la cosa giusta perché questo numero è il controllo di
 * BUDGET MENSILE dell'istanza: una spesa che non passa da un ticket è comunque
 * una spesa, e lasciarla fuori significherebbe sforare il tetto senza che il
 * tetto se ne accorga. Chi un giorno volesse "contare solo i fix" aggiunga una
 * funzione, non un filtro qui.
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

/**
 * Il costo del mese corrente RIPARTITO PER FASE: `triage`, `fix`, `review` e
 * `email_classify` — la voce "posta" della fase 6.
 *
 * Esiste perché {@link monthlyCostUsd} risponde a una domanda sola («quanto ho
 * speso»), mentre "dove sta andando la spesa" era leggibile solo dalla
 * dashboard consumi, che aggrega sul join con `ai_jobs` e quindi NON vede né la
 * review né la posta. Le fasi senza run nel mese compaiono comunque, a 0: un
 * chiamante che itera non deve distinguere "zero" da "chiave assente".
 */
export async function monthlyCostByPhase(db: Db): Promise<Record<AgentRunPhase, number>> {
  const rows = await db
    .select({
      phase: agentRuns.phase,
      total: sql<string>`coalesce(sum(coalesce(${agentRuns.costUsd}, 0)), 0)`,
    })
    .from(agentRuns)
    .where(gte(agentRuns.createdAt, sql`date_trunc('month', now())`))
    .groupBy(agentRuns.phase);

  const totals = Object.fromEntries(
    AGENT_RUN_PHASES.map((phase) => [phase, 0]),
  ) as Record<AgentRunPhase, number>;
  for (const row of rows) totals[row.phase] = Number(row.total);
  return totals;
}
