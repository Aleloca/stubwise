import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import { agentRuns, aiJobs, aiProviders, projects, tickets } from "@stubwise/db";
import { requireAdmin } from "../auth/session.js";
import { authErrorResponses } from "./shared.js";

/**
 * Range temporale (default: ultimi 30 giorni) della dashboard consumi. `from`/
 * `to` sono date ISO (anche solo `YYYY-MM-DD`): il filtro è su `ai_jobs.created_at`
 * (l'istante in cui il job è nato), così tutti i run di un job ricadono nello
 * stesso giorno a prescindere da quando il worker li ha registrati. `to` è
 * inclusivo fino alla fine del giorno indicato (vedi resolveRange).
 */
const querySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

const totalsSchema = z.object({
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  jobs: z.number().int(),
});

const byDaySchema = z.object({
  // Giorno in formato YYYY-MM-DD (UTC).
  day: z.string(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  jobs: z.number().int(),
});

const byModelSchema = z.object({
  model: z.string(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
});

const byProjectSchema = z.object({
  projectId: z.uuid(),
  projectName: z.string(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
});

const byProviderSchema = z.object({
  // Null = job eseguiti senza provider configurato (credenziale da env/default).
  providerId: z.uuid().nullable(),
  providerLabel: z.string().nullable(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
});

export const aiUsageCostsSchema = z.object({
  range: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  totals: totalsSchema,
  byDay: z.array(byDaySchema),
  byModel: z.array(byModelSchema),
  byProject: z.array(byProjectSchema),
  byProvider: z.array(byProviderSchema),
});

export type AiUsageCosts = z.infer<typeof aiUsageCostsSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Risolve [from, to] in due istanti UTC. Default: ultimi 30 giorni fino ad ora.
 * `to` è reso inclusivo del giorno indicato (fine giornata: +1 giorno meno 1ms),
 * così "to=2026-06-10" copre tutti i job del 10 giugno.
 */
function resolveRange(from?: string, to?: string): { from: Date; to: Date } {
  const toDate = to ? new Date(`${to}T23:59:59.999Z`) : new Date();
  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : new Date(toDate.getTime() - 30 * DAY_MS);
  return { from: fromDate, to: toDate };
}

/**
 * Somma USD coalesced a 0: `sum(coalesce(cost_usd, 0))`. I run con costo NULL
 * (CLI vecchio) contano 0 nelle somme, ma la somma di sole righe NULL torna 0
 * (non NULL) grazie al coalesce esterno. Restituita come stringa dal driver
 * (numeric), convertita a number nel mapping.
 */
const sumCost = sql<string>`coalesce(sum(coalesce(${agentRuns.costUsd}, 0)), 0)`;
const sumInput = sql<number>`coalesce(sum(${agentRuns.inputTokens}), 0)::int`;
const sumOutput = sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::int`;
const sumCache = sql<number>`coalesce(sum(${agentRuns.cacheReadTokens}), 0)::int`;

/** Arrotonda a 6 decimali (scala di numeric(12,6)) evitando code float. */
function roundCost(value: string | number): number {
  return Number(Number(value).toFixed(6));
}

/**
 * Aggrega i consumi AI nel range. Quattro query GROUP BY (giorno, modello,
 * progetto, provider) più una per i totali, tutte sul join
 * agent_runs → ai_jobs (→ tickets/projects/ai_providers dove serve). Nessun
 * N+1: ogni raggruppamento è un solo round-trip. Il filtro è su
 * ai_jobs.created_at ∈ [from, to].
 */
async function aggregate(db: Db, from: Date, to: Date): Promise<Omit<AiUsageCosts, "range">> {
  const inRange = and(gte(aiJobs.createdAt, from), lte(aiJobs.createdAt, to));

  // Totali: somma su tutti i run nel range + conteggio dei job distinti.
  const [totalsRow] = await db
    .select({
      costUsd: sumCost,
      inputTokens: sumInput,
      outputTokens: sumOutput,
      cacheReadTokens: sumCache,
      jobs: sql<number>`count(distinct ${aiJobs.id})::int`,
    })
    .from(agentRuns)
    .innerJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
    .where(inRange);

  const totals = {
    costUsd: roundCost(totalsRow?.costUsd ?? 0),
    inputTokens: totalsRow?.inputTokens ?? 0,
    outputTokens: totalsRow?.outputTokens ?? 0,
    cacheReadTokens: totalsRow?.cacheReadTokens ?? 0,
    jobs: totalsRow?.jobs ?? 0,
  };

  // Serie per giorno (UTC), ordinata cronologicamente.
  const day = sql<string>`to_char(date_trunc('day', ${aiJobs.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const byDayRows = await db
    .select({
      day,
      costUsd: sumCost,
      inputTokens: sumInput,
      outputTokens: sumOutput,
      cacheReadTokens: sumCache,
      jobs: sql<number>`count(distinct ${aiJobs.id})::int`,
    })
    .from(agentRuns)
    .innerJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
    .where(inRange)
    .groupBy(day)
    .orderBy(asc(day));

  const byDay = byDayRows.map((r) => ({
    day: r.day,
    costUsd: roundCost(r.costUsd),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    jobs: r.jobs,
  }));

  // Per modello.
  const byModelRows = await db
    .select({
      model: agentRuns.model,
      costUsd: sumCost,
      inputTokens: sumInput,
      outputTokens: sumOutput,
      cacheReadTokens: sumCache,
    })
    .from(agentRuns)
    .innerJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
    .where(inRange)
    .groupBy(agentRuns.model)
    .orderBy(asc(agentRuns.model));

  const byModel = byModelRows.map((r) => ({
    model: r.model,
    costUsd: roundCost(r.costUsd),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
  }));

  // Per progetto: join fino a tickets → projects per il nome.
  const byProjectRows = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      costUsd: sumCost,
      inputTokens: sumInput,
      outputTokens: sumOutput,
      cacheReadTokens: sumCache,
    })
    .from(agentRuns)
    .innerJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
    .innerJoin(tickets, eq(aiJobs.ticketId, tickets.id))
    .innerJoin(projects, eq(tickets.projectId, projects.id))
    .where(inRange)
    .groupBy(projects.id, projects.name)
    .orderBy(asc(projects.name));

  const byProject = byProjectRows.map((r) => ({
    projectId: r.projectId,
    projectName: r.projectName,
    costUsd: roundCost(r.costUsd),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
  }));

  // Per provider: left join (i job senza providerId sono "default/env" → null).
  const byProviderRows = await db
    .select({
      providerId: aiJobs.providerId,
      providerLabel: aiProviders.label,
      costUsd: sumCost,
      inputTokens: sumInput,
      outputTokens: sumOutput,
      cacheReadTokens: sumCache,
    })
    .from(agentRuns)
    .innerJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
    .leftJoin(aiProviders, eq(aiJobs.providerId, aiProviders.id))
    .where(inRange)
    .groupBy(aiJobs.providerId, aiProviders.label)
    .orderBy(asc(aiProviders.label));

  const byProvider = byProviderRows.map((r) => ({
    providerId: r.providerId,
    providerLabel: r.providerLabel,
    costUsd: roundCost(r.costUsd),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
  }));

  return { totals, byDay, byModel, byProject, byProvider };
}

/**
 * Route della dashboard consumi AI (costi/token), sotto /api/ai-usage. Solo
 * admin. Aggrega da agent_runs join ai_jobs (e, dove serve, tickets/projects e
 * ai_providers) con query GROUP BY: serie per giorno, ripartizioni per modello,
 * progetto e provider, più i totali del periodo. I costi NULL contano 0.
 */
export async function aiUsageCostsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/costs",
    {
      preHandler: requireAdmin,
      schema: {
        querystring: querySchema,
        response: { 200: aiUsageCostsSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const { from, to } = resolveRange(request.query.from, request.query.to);
      const aggregates = await aggregate(app.db, from, to);
      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        ...aggregates,
      };
    },
  );
}
