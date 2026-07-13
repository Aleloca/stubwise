import {
  alertThresholdsSchema,
  computeServerStatus,
  createServerSchema,
  serverStatusSchema,
  updateServerSchema,
} from "@stubwise/shared";
import {
  projects,
  serverMetrics,
  serverProjects,
  servers,
  serviceChecks,
} from "@stubwise/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import {
  authErrorResponses,
  errorSchema,
  generateServerKey,
  hashServerKey,
  isForeignKeyViolation,
} from "./shared.js";

/** Quanti valori di CPU recenti includere nella lista/dettaglio (sparkline UI). */
const RECENT_CPU_POINTS = 20;

const idParamsSchema = z.object({ id: z.uuid() });

/** Query string della lista: filtro opzionale per progetto associato. */
const listQuerySchema = z.object({ projectId: z.uuid().optional() });

type ServerRow = typeof servers.$inferSelect;

/** Progetto associato, ridotto ai campi che servono alla UI (id + nome). */
const serverProjectSummarySchema = z.object({ id: z.uuid(), name: z.string() });

/**
 * Proiezione pubblica di un server per la SPA: dati anagrafici, stato calcolato,
 * progetti associati, conteggi check e la coda di CPU recente per la sparkline.
 * NON contiene MAI `keyHash` né la chiave in chiaro (quella si mostra solo alla
 * creazione e alla rigenerazione, in uno schema dedicato).
 */
const serverViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  hostname: z.string().nullable(),
  status: serverStatusSchema,
  sampleIntervalSeconds: z.number().int(),
  agentVersion: z.string().nullable(),
  alertThresholds: alertThresholdsSchema,
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  projects: z.array(serverProjectSummarySchema),
  checksUp: z.number().int(),
  checksDown: z.number().int(),
  // Ultimi valori di CPU dai campioni fini, dal più vecchio al più recente.
  recentCpu: z.array(z.number()),
});
type ServerView = z.infer<typeof serverViewSchema>;

/** Risposta con la chiave in chiaro: creazione e rigenerazione, una sola volta. */
const serverWithKeySchema = serverViewSchema.extend({ key: z.string() });

/** Dati aggregati per un server, da unire alla riga base nella proiezione. */
interface ServerAggregates {
  projects: ServerView["projects"];
  checksUp: number;
  checksDown: number;
  recentCpu: number[];
}

/** Aggregati vuoti (server senza progetti/check/campioni). */
function emptyAggregates(): ServerAggregates {
  return { projects: [], checksUp: 0, checksDown: 0, recentCpu: [] };
}

/**
 * Compone la proiezione pubblica del server: campi elencati esplicitamente (mai
 * spread della riga, così `keyHash` non può sfuggire) + aggregati + stato.
 */
function toServerView(row: ServerRow, agg: ServerAggregates, now: Date): ServerView {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    status: computeServerStatus(row.lastSeenAt, row.sampleIntervalSeconds, now),
    sampleIntervalSeconds: row.sampleIntervalSeconds,
    agentVersion: row.agentVersion,
    alertThresholds: row.alertThresholds,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    projects: agg.projects,
    checksUp: agg.checksUp,
    checksDown: agg.checksDown,
    recentCpu: agg.recentCpu,
  };
}

/**
 * Calcola gli aggregati (progetti, conteggi check, CPU recente) per un insieme
 * di server in poche query batch, evitando N+1: una join progetti (inArray),
 * un group-by sui check, e — poiché i server monitorati sono pochi — una query
 * di CPU recente per server (semplice e con `LIMIT`, il volume è trascurabile).
 */
async function loadAggregates(
  app: FastifyInstance,
  serverIds: string[],
): Promise<Map<string, ServerAggregates>> {
  const byServer = new Map<string, ServerAggregates>();
  for (const id of serverIds) byServer.set(id, emptyAggregates());
  if (serverIds.length === 0) return byServer;

  // Progetti associati, in una sola query con la join sui nomi.
  const projectRows = await app.db
    .select({
      serverId: serverProjects.serverId,
      id: projects.id,
      name: projects.name,
    })
    .from(serverProjects)
    .innerJoin(projects, eq(projects.id, serverProjects.projectId))
    .where(inArray(serverProjects.serverId, serverIds))
    .orderBy(projects.name);
  for (const r of projectRows) {
    byServer.get(r.serverId)!.projects.push({ id: r.id, name: r.name });
  }

  // Conteggi check up/down (solo abilitati), aggregati per server in una query.
  const checkRows = await app.db
    .select({
      serverId: serviceChecks.serverId,
      up: sql<number>`count(*) filter (where ${serviceChecks.lastStatus} = 'up')::int`,
      down: sql<number>`count(*) filter (where ${serviceChecks.lastStatus} = 'down')::int`,
    })
    .from(serviceChecks)
    .where(and(inArray(serviceChecks.serverId, serverIds), eq(serviceChecks.enabled, true)))
    .groupBy(serviceChecks.serverId);
  for (const r of checkRows) {
    const agg = byServer.get(r.serverId)!;
    agg.checksUp = r.up;
    agg.checksDown = r.down;
  }

  // CPU recente: una query per server (i server monitorati sono pochi). Prendo
  // gli ultimi N in ordine decrescente e li riordino dal più vecchio.
  for (const id of serverIds) {
    const cpuRows = await app.db
      .select({ cpuPct: serverMetrics.cpuPct })
      .from(serverMetrics)
      .where(eq(serverMetrics.serverId, id))
      .orderBy(desc(serverMetrics.ts))
      .limit(RECENT_CPU_POINTS);
    byServer.get(id)!.recentCpu = cpuRows.map((r) => r.cpuPct).reverse();
  }

  return byServer;
}

/**
 * Route interne del monitoraggio server, sotto /api/servers. Lettura per ogni
 * utente autenticato; creazione, modifica, rigenerazione chiave ed eliminazione
 * solo admin. La chiave dell'agente (`sk_…`) si mostra in chiaro SOLO alla
 * creazione e alla rigenerazione: in DB vive solo l'hash (sha256).
 */
export async function serverRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      preHandler: requireAdmin,
      schema: {
        body: createServerSchema,
        response: { 201: serverWithKeySchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const key = generateServerKey();
      const [created] = await app.db
        .insert(servers)
        .values({ name: request.body.name, keyHash: hashServerKey(key) })
        .returning();
      if (!created) throw new Error("insert del server non ha restituito la riga");
      return await reply
        .code(201)
        .send({ ...toServerView(created, emptyAggregates(), now), key });
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        querystring: listQuerySchema,
        response: { 200: z.array(serverViewSchema), ...authErrorResponses },
      },
    },
    async (request) => {
      const now = new Date();
      const { projectId } = request.query;

      // Filtro per progetto: gli id dei server associati, poi la lista completa.
      let rows: ServerRow[];
      if (projectId) {
        const associated = await app.db
          .select({ serverId: serverProjects.serverId })
          .from(serverProjects)
          .where(eq(serverProjects.projectId, projectId));
        const ids = associated.map((a) => a.serverId);
        rows =
          ids.length === 0
            ? []
            : await app.db
                .select()
                .from(servers)
                .where(inArray(servers.id, ids))
                .orderBy(servers.createdAt);
      } else {
        rows = await app.db.select().from(servers).orderBy(servers.createdAt);
      }

      const agg = await loadAggregates(app, rows.map((r) => r.id));
      return rows.map((r) => toServerView(r, agg.get(r.id)!, now));
    },
  );

  app.get(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 200: serverViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const [row] = await app.db.select().from(servers).where(eq(servers.id, request.params.id));
      if (!row) return apiError(reply, 404, "server_not_found", "Server not found");
      const agg = await loadAggregates(app, [row.id]);
      return toServerView(row, agg.get(row.id)!, now);
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: updateServerSchema,
        response: {
          200: serverViewSchema,
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const { name, sampleIntervalSeconds, alertThresholds, projectIds } = request.body;

      const updates: Partial<ServerRow> = {};
      if (name !== undefined) updates.name = name;
      if (sampleIntervalSeconds !== undefined) updates.sampleIntervalSeconds = sampleIntervalSeconds;
      // alertThresholds è full-replacement (contratto A1): lo schema shared ha
      // già applicato i default sui campi omessi.
      if (alertThresholds !== undefined) updates.alertThresholds = alertThresholds;

      // Esistenza + eventuale sync dei progetti in un'unica transazione: se un
      // projectId è inesistente la FK viola e l'intero PATCH torna 422 (nessuna
      // modifica parziale applicata).
      try {
        const applied = await app.db.transaction(async (tx) => {
          const [row] =
            Object.keys(updates).length > 0
              ? await tx.update(servers).set(updates).where(eq(servers.id, request.params.id)).returning()
              : await tx.select().from(servers).where(eq(servers.id, request.params.id));
          if (!row) return undefined;

          // projectIds assente → associazioni intatte; presente → replace
          // completo. Dedup preventivo: un duplicato nel body violerebbe
          // l'unique (server_id, project_id) → 500, non la FK.
          if (projectIds !== undefined) {
            const uniqueProjectIds = [...new Set(projectIds)];
            await tx.delete(serverProjects).where(eq(serverProjects.serverId, row.id));
            if (uniqueProjectIds.length > 0) {
              await tx
                .insert(serverProjects)
                .values(uniqueProjectIds.map((projectId) => ({ serverId: row.id, projectId })));
            }
          }
          return row;
        });
        if (!applied) return apiError(reply, 404, "server_not_found", "Server not found");
        const agg = await loadAggregates(app, [applied.id]);
        return toServerView(applied, agg.get(applied.id)!, now);
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          return apiError(reply, 422, "project_not_found", "One or more projects do not exist");
        }
        throw error;
      }
    },
  );

  app.post(
    "/:id/regenerate-key",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: { 200: serverWithKeySchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const key = generateServerKey();
      const [updated] = await app.db
        .update(servers)
        .set({ keyHash: hashServerKey(key) })
        .where(eq(servers.id, request.params.id))
        .returning();
      if (!updated) return apiError(reply, 404, "server_not_found", "Server not found");
      const agg = await loadAggregates(app, [updated.id]);
      return { ...toServerView(updated, agg.get(updated.id)!, now), key };
    },
  );

  app.delete(
    "/:id",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // Cascade DB su server_metrics, service_checks (e con essi check_samples)
      // e server_projects: nessuna guardia, coerente con lo schema.
      const [deleted] = await app.db
        .delete(servers)
        .where(eq(servers.id, request.params.id))
        .returning({ id: servers.id });
      if (!deleted) return apiError(reply, 404, "server_not_found", "Server not found");
      return reply.code(204).send(null);
    },
  );
}
