import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { Db } from "@stubwise/db";
import { agentRuns, aiJobs, aiProviders, tickets } from "@stubwise/db";
import { aiJobSchema } from "@stubwise/shared";
import { authErrorResponses, errorSchema } from "./shared.js";
import { apiError } from "../errors.js";

// La forma pubblica di un job AI vive in `@stubwise/shared`: unica fonte di
// verità con la SPA e l'app mobile.

const ticketParamsSchema = z.object({ ticketId: z.uuid() });

/**
 * Consumo aggregato per un singolo modello, sommato su tutti gli agent_runs
 * (triage + fix) dei job del ticket. `costUsd` è nullable: alcuni run possono
 * non riportare il costo (CLI vecchio), e se NESSUN run di un modello lo
 * riporta la somma resta null anziché 0.
 */
const usageByModelSchema = z.object({
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  costUsd: z.number().nullable(),
});

/**
 * Riepilogo dei consumi AI di un ticket: token totali (input+output), costo
 * totale in USD (null se nessun run riporta un costo) e dettaglio per modello.
 * Alimenta il pannello "Consumi AI" del dettaglio ticket.
 */
export const ticketUsageSchema = z.object({
  totalTokens: z.number().int(),
  totalCostUsd: z.number().nullable(),
  byModel: z.array(usageByModelSchema),
});

// La riga del job arricchita col provider risolto via LEFT JOIN: `provider`
// è null quando il job non ha provider_id o il provider è stato eliminato.
type AiJobRow = typeof aiJobs.$inferSelect & {
  provider: { label: string; kind: (typeof aiProviders.$inferSelect)["kind"] } | null;
};

function toPublicAiJob(row: AiJobRow): z.infer<typeof aiJobSchema> {
  return {
    id: row.id,
    ticketId: row.ticketId,
    status: row.status,
    log: row.log,
    prUrl: row.prUrl,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    providerLabel: row.provider?.label ?? null,
    providerKind: row.provider?.kind ?? null,
    requestedByUserId: row.requestedByUserId,
    // Riassunto "in breve" del piano parcheggiato su questo job (fase 5):
    // azzerato insieme a `planText` quando il piano viene rifiutato, quindi non
    // sopravvive mai al piano che descrive.
    planSummary: row.planSummary,
  };
}

/** True se il ticket esiste: i job di un ticket fantasma sono 404. */
async function ticketExists(db: Db, ticketId: string): Promise<boolean> {
  const [row] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId));
  return row !== undefined;
}

/**
 * Aggrega i consumi (token + costo) di TUTTI gli agent_runs dei job del
 * ticket, raggruppati per modello. Join agent_runs → ai_jobs su jobId, filtro
 * sul ticket. La somma del costo è null quando nessun run del modello riporta
 * un costo (SUM su soli NULL → NULL in Postgres); i token sono interi sempre
 * presenti (default 0 in colonna). I `::int`/`numeric` espliciti tengono i
 * tipi prevedibili a prescindere dal driver.
 */
async function aggregateUsage(db: Db, ticketId: string): Promise<z.infer<typeof ticketUsageSchema>> {
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

  const byModel = rows.map((row) => ({
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    costUsd: row.costUsd !== null ? Number(row.costUsd) : null,
  }));

  const totalTokens = byModel.reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0);
  // Costo totale: null se NESSUN modello riporta un costo; altrimenti la somma
  // dei costi noti (i null contano come 0 nel totale, ma il totale resta null
  // finché non c'è almeno un costo reale).
  const costs = byModel.map((m) => m.costUsd).filter((c): c is number => c !== null);
  const totalCostUsd =
    costs.length > 0 ? Number(costs.reduce((sum, c) => sum + c, 0).toFixed(6)) : null;

  return { totalTokens, totalCostUsd, byModel };
}

/**
 * Route dei job AI, registrate sotto /api/tickets/:ticketId/jobs. Solo
 * lettura: i job li crea la pipeline (Task 19+), la UI mostra la timeline.
 */
export async function aiJobRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        params: ticketParamsSchema,
        response: { 200: z.array(aiJobSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { ticketId } = request.params;
      if (!(await ticketExists(app.db, ticketId))) {
        return apiError(reply, 404, "ticket_not_found", "Ticket not found");
      }
      // Dal più recente al più vecchio: la timeline in UI parte dall'ultimo
      // tentativo. L'id spareggia i job creati nello stesso istante. LEFT JOIN
      // sul provider per esporne etichetta e tipo (null se assente/eliminato).
      const rows = await app.db
        .select({
          job: aiJobs,
          provider: { label: aiProviders.label, kind: aiProviders.kind },
        })
        .from(aiJobs)
        .leftJoin(aiProviders, eq(aiProviders.id, aiJobs.providerId))
        .where(eq(aiJobs.ticketId, ticketId))
        .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id));
      return rows.map((row) => toPublicAiJob({ ...row.job, provider: row.provider }));
    },
  );
}

/**
 * Route del riepilogo consumi AI, registrate sotto
 * /api/tickets/:ticketId/usage. Endpoint a sé (non innestato nella lista
 * job) così la UI lo carica in parallelo e il contratto della lista job
 * resta invariato. Solo lettura, requireAuth.
 */
export async function ticketUsageRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        params: ticketParamsSchema,
        response: { 200: ticketUsageSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { ticketId } = request.params;
      if (!(await ticketExists(app.db, ticketId))) {
        return apiError(reply, 404, "ticket_not_found", "Ticket not found");
      }
      return aggregateUsage(app.db, ticketId);
    },
  );
}
