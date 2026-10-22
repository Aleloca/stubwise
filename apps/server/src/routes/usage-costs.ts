import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import { agentRuns, aiJobs, aiProviders, projects } from "@stubwise/db";
import { authErrorResponses } from "./shared.js";

/**
 * Range temporale (default: ultimi 30 giorni) della dashboard consumi. `from`/
 * `to` sono date ISO (anche solo `YYYY-MM-DD`): il filtro è su `ai_jobs.created_at`
 * (l'istante in cui il job è nato) per le righe di un job, così tutti i run di
 * un job ricadono nello stesso giorno; per le altre su `agent_runs.created_at`
 * (vedi `effectiveAt`). `to` è
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
  // Null = righe senza progetto (posta, operazioni d'istanza).
  projectId: z.uuid().nullable(),
  projectName: z.string().nullable(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
});

const byProviderSchema = z.object({
  // Null = run eseguiti senza provider configurato (credenziale da env/default).
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
 * Istante a cui una riga appartiene ai fini del periodo e del giorno: la nascita
 * del job se la riga ne ha uno (così tutti i run di un job ricadono nello stesso
 * giorno), altrimenti il suo `created_at` (chat, review, posta, Docs...).
 */
const effectiveAt = sql`coalesce(${aiJobs.createdAt}, ${agentRuns.createdAt})`;

/** `from <= effectiveAt <= to`; le date passano come stringhe ISO castate (niente tipo da inferire). */
function periodFilter(from: Date, to: Date) {
  return sql`${effectiveAt} >= ${from.toISOString()}::timestamptz and ${effectiveAt} <= ${to.toISOString()}::timestamptz`;
}

/** Chiave di una esecuzione: le righe per-modello dello stesso run ne contano una. */
const runKey = sql`coalesce(${agentRuns.runId}, ${agentRuns.id})`;
const countRuns = sql<number>`count(distinct ${runKey})::int`;

/**
 * Aggrega i consumi AI nel range. Quattro query GROUP BY (giorno, modello,
 * progetto, provider) più una per i totali, su TUTTE le righe di agent_runs (con
 * o senza job): `ai_jobs` è un LEFT JOIN, serve solo alla data del job e al
 * provider delle righe vecchie. Nessun N+1: un round-trip per raggruppamento.
 * `jobs` conta le ESECUZIONI distinte (`count(distinct coalesce(run_id, id))`),
 * non più i job: una riga legacy senza `run_id` vale 1.
 */
async function aggregate(db: Db, from: Date, to: Date): Promise<Omit<AiUsageCosts, "range">> {
  const inRange = periodFilter(from, to);

  const [totalsRow] = await db
    .select({
      costUsd: sumCost,
      inputTokens: sumInput,
      outputTokens: sumOutput,
      cacheReadTokens: sumCache,
      jobs: countRuns,
    })
    .from(agentRuns)
    .leftJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
    .where(inRange);

  const totals = {
    costUsd: roundCost(totalsRow?.costUsd ?? 0),
    inputTokens: totalsRow?.inputTokens ?? 0,
    outputTokens: totalsRow?.outputTokens ?? 0,
    cacheReadTokens: totalsRow?.cacheReadTokens ?? 0,
    jobs: totalsRow?.jobs ?? 0,
  };

  // Serie per giorno (UTC), ordinata cronologicamente.
  const day = sql<string>`to_char(date_trunc('day', ${effectiveAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const byDayRows = await db
    .select({
      day,
      costUsd: sumCost,
      inputTokens: sumInput,
      outputTokens: sumOutput,
      cacheReadTokens: sumCache,
      jobs: countRuns,
    })
    .from(agentRuns)
    .leftJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
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
    .leftJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
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

  // Per progetto: `agent_runs.project_id` (null = nessun progetto, es. posta).
  const byProjectRows = await db
    .select({
      projectId: agentRuns.projectId,
      projectName: projects.name,
      costUsd: sumCost,
      inputTokens: sumInput,
      outputTokens: sumOutput,
      cacheReadTokens: sumCache,
    })
    .from(agentRuns)
    .leftJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(inRange)
    .groupBy(agentRuns.projectId, projects.name)
    .orderBy(sql`${projects.name} asc nulls last`);

  const byProject = byProjectRows.map((r) => ({
    projectId: r.projectId,
    projectName: r.projectName,
    costUsd: roundCost(r.costUsd),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
  }));

  // Per provider: quello della riga, altrimenti (righe di prima della 0096) quello
  // del job. Senza nessuno dei due = credenziale da env/default → null.
  const providerId = sql<string | null>`coalesce(${agentRuns.providerId}, ${aiJobs.providerId})`;
  const byProviderRows = await db
    .select({
      providerId,
      providerLabel: aiProviders.label,
      costUsd: sumCost,
      inputTokens: sumInput,
      outputTokens: sumOutput,
      cacheReadTokens: sumCache,
    })
    .from(agentRuns)
    .leftJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
    .leftJoin(aiProviders, sql`${aiProviders.id} = ${providerId}`)
    .where(inRange)
    .groupBy(providerId, aiProviders.label)
    .orderBy(sql`${aiProviders.label} asc nulls last`);

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

const BREAKDOWN_DIMENSIONS = ["operation", "project", "model", "day"] as const;
type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

const breakdownQuerySchema = querySchema
  .extend({
    groupBy: z.enum(BREAKDOWN_DIMENSIONS),
    thenBy: z.enum(BREAKDOWN_DIMENSIONS).optional(),
  })
  .refine((q) => q.thenBy !== q.groupBy, {
    message: "thenBy deve essere diverso da groupBy",
    path: ["thenBy"],
  });

const breakdownRowSchema = z.object({
  key: z.string().nullable(),
  // Nome del progetto per `project`, altrimenti null (l'etichetta delle
  // operazioni la traduce il web).
  label: z.string().nullable(),
  subKey: z.string().nullable(),
  subLabel: z.string().nullable(),
  // Esecuzioni distinte: `count(distinct coalesce(run_id, id))`.
  runs: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheCreationTokens: z.number().int(),
  // Null = nessuna riga del gruppo ha riportato un costo (non è «zero»).
  costUsd: z.number().nullable(),
  avgTokensPerRun: z.number(),
});

export const aiUsageBreakdownSchema = z.object({ rows: z.array(breakdownRowSchema) });
export type AiUsageBreakdown = z.infer<typeof aiUsageBreakdownSchema>;

/** Espressione di chiave (testo) e di etichetta di una dimensione di raggruppamento. */
function dimensionExprs(dim: BreakdownDimension): {
  key: ReturnType<typeof sql<string | null>>;
  label: ReturnType<typeof sql<string | null>>;
} {
  switch (dim) {
    case "operation":
      return { key: sql<string>`${agentRuns.operation}`, label: sql<null>`null::text` };
    case "model":
      return { key: sql<string>`${agentRuns.model}`, label: sql<null>`null::text` };
    case "project":
      return {
        key: sql<string | null>`${agentRuns.projectId}::text`,
        label: sql<string | null>`${projects.name}`,
      };
    case "day":
      return {
        key: sql<string>`to_char(date_trunc('day', ${effectiveAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        label: sql<null>`null::text`,
      };
  }
}

async function breakdown(
  db: Db,
  from: Date,
  to: Date,
  groupBy: BreakdownDimension,
  thenBy: BreakdownDimension | undefined,
): Promise<AiUsageBreakdown> {
  const first = dimensionExprs(groupBy);
  const second = thenBy ? dimensionExprs(thenBy) : undefined;
  const subKey = second ? second.key : sql<string | null>`null::text`;
  const subLabel = second ? second.label : sql<string | null>`null::text`;

  // Le etichette sono funzionalmente dipendenti dalla chiave (nome del progetto):
  // le raggruppiamo solo quando non sono la costante null.
  const groups = [first.key, ...(groupBy === "project" ? [first.label] : [])];
  if (second && thenBy) {
    groups.push(second.key, ...(thenBy === "project" ? [second.label] : []));
  }

  const rows = await db
    .select({
      key: first.key,
      label: first.label,
      subKey,
      subLabel,
      runs: countRuns,
      inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum(${agentRuns.cacheReadTokens}), 0)::int`,
      cacheCreationTokens: sql<number>`coalesce(sum(${agentRuns.cacheCreationTokens}), 0)::int`,
      // sum() di soli NULL resta NULL: è il «costo non riportato».
      costUsd: sql<string | null>`sum(${agentRuns.costUsd})`,
    })
    .from(agentRuns)
    .leftJoin(aiJobs, eq(agentRuns.jobId, aiJobs.id))
    .leftJoin(projects, eq(agentRuns.projectId, projects.id))
    .where(periodFilter(from, to))
    .groupBy(...groups)
    .orderBy(sql`${first.key} asc nulls last`, sql`${subKey} asc nulls last`);

  return {
    rows: rows.map((r) => {
      const tokens = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens;
      return {
        key: r.key,
        label: r.label,
        subKey: r.subKey,
        subLabel: r.subLabel,
        runs: r.runs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        costUsd: r.costUsd === null ? null : roundCost(r.costUsd),
        avgTokensPerRun: r.runs > 0 ? tokens / r.runs : 0,
      };
    }),
  };
}

/**
 * Route della dashboard consumi AI (costi/token), sotto /api/ai-usage. Solo
 * admin. Aggrega da agent_runs (left join ai_jobs, projects e ai_providers) con query GROUP BY: serie per giorno, ripartizioni per modello,
 * progetto e provider, più i totali del periodo. I costi NULL contano 0.
 */
export async function aiUsageCostsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/costs",
    {
      config: { access: { kind: "instance", permission: "usage.view" } },
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

  // Letterale come /costs: nessuna rotta parametrica sullo stesso prefisso.
  app.get(
    "/breakdown",
    {
      config: { access: { kind: "instance", permission: "usage.view" } },
      schema: {
        querystring: breakdownQuerySchema,
        response: { 200: aiUsageBreakdownSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const { from, to } = resolveRange(request.query.from, request.query.to);
      return breakdown(app.db, from, to, request.query.groupBy, request.query.thenBy);
    },
  );
}
