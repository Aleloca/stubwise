import {
  checkStatusSchema,
  checkTypeSchema,
  createCheckSchema,
  updateCheckSchema,
} from "@stubwise/shared";
import {
  checkSamples,
  checkSamplesRollup,
  encrypt,
  serverMetrics,
  serverMetricsRollup,
  servers,
  serviceChecks,
} from "@stubwise/db";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/** Oltre questo intervallo (incluso il boundary) si legge il rollup 5m. */
const RAW_RESOLUTION_MAX_MS = 48 * 60 * 60 * 1000;
/** Tetto di sicurezza sui punti restituiti per una singola query. */
const METRICS_POINT_LIMIT = 6000;

const idParamsSchema = z.object({ id: z.uuid() });
const checkParamsSchema = z.object({ id: z.uuid(), checkId: z.uuid() });

type CheckRow = typeof serviceChecks.$inferSelect;

/** I tipi DB (postgres/mysql) tengono il DSN cifrato, mai in `target`. */
function isDbCheckType(type: CheckRow["type"]): boolean {
  return type === "postgres" || type === "mysql";
}

/**
 * Proiezione pubblica di un check: campi elencati esplicitamente (mai spread
 * della riga, così `dsnEncrypted` non può sfuggire). Il DSN cifrato non esce
 * MAI dall'API: al suo posto il flag `hasDsn`. Per i check DB `target` è sempre
 * vuoto (il DSN vive solo in `dsnEncrypted`, decifrato unicamente per l'agente
 * su /monitor/config).
 */
const checkViewSchema = z.object({
  id: z.uuid(),
  serverId: z.uuid(),
  type: checkTypeSchema,
  name: z.string(),
  target: z.string(),
  hasDsn: z.boolean(),
  intervalSeconds: z.number().int(),
  enabled: z.boolean(),
  lastStatus: checkStatusSchema,
  lastCheckedAt: z.string().nullable(),
  lastLatencyMs: z.number().int().nullable(),
  lastError: z.string().nullable(),
  downSince: z.string().nullable(),
  createdAt: z.string(),
});
type CheckView = z.infer<typeof checkViewSchema>;

/** Compone la proiezione pubblica: mai `dsnEncrypted`, mai il DSN in chiaro. */
function toCheckView(row: CheckRow): CheckView {
  return {
    id: row.id,
    serverId: row.serverId,
    type: row.type,
    name: row.name,
    target: row.target,
    hasDsn: row.dsnEncrypted !== null,
    intervalSeconds: row.intervalSeconds,
    enabled: row.enabled,
    lastStatus: row.lastStatus,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastLatencyMs: row.lastLatencyMs,
    lastError: row.lastError,
    downSince: row.downSince ? row.downSince.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Schemi dei punti metrica -------------------------------------------------

/** Punto a risoluzione piena (campione host grezzo). */
const rawPointSchema = z.object({
  ts: z.string(),
  cpuPct: z.number(),
  load1m: z.number(),
  memUsedBytes: z.number(),
  memTotalBytes: z.number(),
  swapUsedBytes: z.number(),
  diskUsedBytes: z.number(),
  diskTotalBytes: z.number(),
  netRxBytes: z.number(),
  netTxBytes: z.number(),
});

/** Punto aggregato a 5 minuti (rollup): coppie avg/max + somme di rete. */
const rollupPointSchema = z.object({
  ts: z.string(),
  cpuPctAvg: z.number(),
  cpuPctMax: z.number(),
  load1mAvg: z.number(),
  load1mMax: z.number(),
  memUsedBytesAvg: z.number(),
  memUsedBytesMax: z.number(),
  memTotalBytes: z.number(),
  diskUsedBytesAvg: z.number(),
  diskUsedBytesMax: z.number(),
  diskTotalBytes: z.number(),
  netRxBytesSum: z.number(),
  netTxBytesSum: z.number(),
});

/** Esito di check a risoluzione piena. */
const rawCheckPointSchema = z.object({
  ts: z.string(),
  status: checkStatusSchema,
  latencyMs: z.number().int().nullable(),
});

/** Esito di check aggregato a 5 minuti (rollup). */
const rollupCheckPointSchema = z.object({
  ts: z.string(),
  upCount: z.number().int(),
  downCount: z.number().int(),
  latencyMsAvg: z.number().nullable(),
  latencyMsMax: z.number().int().nullable(),
});

const metricsQuerySchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  checkId: z.uuid().optional(),
});

const metricsResponseSchema = z.object({
  resolution: z.enum(["raw", "5m"]),
  points: z.array(z.union([rawPointSchema, rollupPointSchema])),
  checkPoints: z.array(z.union([rawCheckPointSchema, rollupCheckPointSchema])).optional(),
});

/**
 * Route dei check di servizio e delle metriche di un server, registrate sotto
 * /api/servers (secondo plugin sullo stesso prefix di serverRoutes). Lettura per
 * ogni utente autenticato; creazione/modifica/eliminazione solo admin.
 *
 * Sicurezza dei segreti: i check DB (postgres/mysql) tengono la connection string
 * cifrata (AES-256-GCM via `encrypt`) in `dsn_encrypted`; il DSN in chiaro entra
 * dal campo `target` del body e non esce MAI da questa API (né in risposta né in
 * log). La proiezione pubblica espone solo `hasDsn`. La decifratura avviene
 * unicamente nel canale agente (/monitor/config).
 *
 * Ownership: ogni operazione su un check verifica che appartenga al server
 * dell'URL (`:id`/`:checkId`); un mismatch è indistinguibile da un check
 * inesistente (stessa 404).
 */
export async function serverCheckRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /** Esistenza di un server (solo l'id): 404 a monte delle sotto-risorse. */
  async function serverExists(serverId: string): Promise<boolean> {
    const [row] = await app.db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, serverId));
    return row !== undefined;
  }

  /** Riga completa del check SE appartiene al server dell'URL, altrimenti undefined. */
  async function findOwnedCheck(
    serverId: string,
    checkId: string,
  ): Promise<CheckRow | undefined> {
    const [row] = await app.db
      .select()
      .from(serviceChecks)
      .where(and(eq(serviceChecks.id, checkId), eq(serviceChecks.serverId, serverId)));
    return row;
  }

  app.post(
    "/:id/checks",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: createCheckSchema,
        response: { 201: checkViewSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id: serverId } = request.params;
      if (!(await serverExists(serverId))) {
        return apiError(reply, 404, "server_not_found", "Server not found");
      }
      const { type, name, target, intervalSeconds, enabled } = request.body;
      // Check DB: il DSN (arrivato in `target`) va cifrato in dsn_encrypted e la
      // colonna target resta vuota. Altri tipi: target in chiaro, nessun DSN.
      const db = isDbCheckType(type);
      const [created] = await app.db
        .insert(serviceChecks)
        .values({
          serverId,
          type,
          name,
          target: db ? "" : target,
          dsnEncrypted: db ? encrypt(target, app.encryptionKey) : null,
          intervalSeconds,
          enabled,
        })
        .returning();
      if (!created) throw new Error("insert del check non ha restituito la riga");
      return await reply.code(201).send(toCheckView(created));
    },
  );

  app.get(
    "/:id/checks",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 200: z.array(checkViewSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id: serverId } = request.params;
      if (!(await serverExists(serverId))) {
        return apiError(reply, 404, "server_not_found", "Server not found");
      }
      const rows = await app.db
        .select()
        .from(serviceChecks)
        .where(eq(serviceChecks.serverId, serverId))
        .orderBy(asc(serviceChecks.createdAt));
      return rows.map(toCheckView);
    },
  );

  app.put(
    "/:id/checks/:checkId",
    {
      preHandler: requireAdmin,
      schema: {
        params: checkParamsSchema,
        body: updateCheckSchema,
        response: { 200: checkViewSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id: serverId, checkId } = request.params;
      const existing = await findOwnedCheck(serverId, checkId);
      if (!existing) return apiError(reply, 404, "check_not_found", "Check not found");

      const { type, name, target, intervalSeconds, enabled } = request.body;
      const updates: Partial<typeof serviceChecks.$inferInsert> = {};
      if (type !== undefined) updates.type = type;
      if (name !== undefined) updates.name = name;
      if (intervalSeconds !== undefined) updates.intervalSeconds = intervalSeconds;
      if (enabled !== undefined) updates.enabled = enabled;

      // `target` presente = nuovo valore. Per un check DB è il nuovo DSN da
      // ri-cifrare (colonna target vuota); per gli altri è il target in chiaro
      // (nessun DSN). Il tipo effettivo tiene conto di un eventuale cambio di
      // type nello stesso PUT. `target` assente = invariato (DSN incluso).
      if (target !== undefined) {
        const effectiveType = type ?? existing.type;
        if (isDbCheckType(effectiveType)) {
          updates.dsnEncrypted = encrypt(target, app.encryptionKey);
          updates.target = "";
        } else {
          updates.target = target;
          updates.dsnEncrypted = null;
        }
      }

      const [updated] =
        Object.keys(updates).length > 0
          ? await app.db
              .update(serviceChecks)
              .set(updates)
              .where(eq(serviceChecks.id, checkId))
              .returning()
          : [existing];
      if (!updated) throw new Error("update del check non ha restituito la riga");
      return toCheckView(updated);
    },
  );

  app.delete(
    "/:id/checks/:checkId",
    {
      preHandler: requireAdmin,
      schema: {
        params: checkParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id: serverId, checkId } = request.params;
      // Il vincolo su serverId evita di cancellare check di altri server con un
      // checkId indovinato (mismatch → 404). Cascade DB su check_samples.
      const deleted = await app.db
        .delete(serviceChecks)
        .where(and(eq(serviceChecks.id, checkId), eq(serviceChecks.serverId, serverId)))
        .returning({ id: serviceChecks.id });
      if (deleted.length === 0) return apiError(reply, 404, "check_not_found", "Check not found");
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/:id/metrics",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        querystring: metricsQuerySchema,
        response: { 200: metricsResponseSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id: serverId } = request.params;
      const { checkId } = request.query;
      const from = new Date(request.query.from);
      const to = new Date(request.query.to);
      // Range degenere/rovesciato: nessun dato sensato da restituire.
      if (from.getTime() >= to.getTime()) {
        return apiError(reply, 400, "invalid_range", "`from` must be strictly before `to`");
      }
      if (!(await serverExists(serverId))) {
        return apiError(reply, 404, "server_not_found", "Server not found");
      }
      // checkId opzionale: la serie va aggiunta solo se il check appartiene a
      // QUESTO server (mismatch/inesistente → 404, non silenzioso).
      if (checkId !== undefined && !(await findOwnedCheck(serverId, checkId))) {
        return apiError(reply, 404, "check_not_found", "Check not found");
      }

      // Boundary incluso: range <= 48h legge i campioni fini, oltre il rollup 5m.
      const raw = to.getTime() - from.getTime() <= RAW_RESOLUTION_MAX_MS;

      if (raw) {
        const rows = await app.db
          .select()
          .from(serverMetrics)
          .where(
            and(
              eq(serverMetrics.serverId, serverId),
              gte(serverMetrics.ts, from),
              lte(serverMetrics.ts, to),
            ),
          )
          .orderBy(asc(serverMetrics.ts))
          .limit(METRICS_POINT_LIMIT);
        const points = rows.map((r) => ({
          ts: r.ts.toISOString(),
          cpuPct: r.cpuPct,
          load1m: r.load1m,
          memUsedBytes: r.memUsedBytes,
          memTotalBytes: r.memTotalBytes,
          swapUsedBytes: r.swapUsedBytes,
          diskUsedBytes: r.diskUsedBytes,
          diskTotalBytes: r.diskTotalBytes,
          netRxBytes: r.netRxBytes,
          netTxBytes: r.netTxBytes,
        }));

        if (checkId === undefined) return { resolution: "raw" as const, points };

        const sampleRows = await app.db
          .select()
          .from(checkSamples)
          .where(
            and(
              eq(checkSamples.checkId, checkId),
              gte(checkSamples.ts, from),
              lte(checkSamples.ts, to),
            ),
          )
          .orderBy(asc(checkSamples.ts))
          .limit(METRICS_POINT_LIMIT);
        const checkPoints = sampleRows.map((s) => ({
          ts: s.ts.toISOString(),
          status: s.status,
          latencyMs: s.latencyMs,
        }));
        return { resolution: "raw" as const, points, checkPoints };
      }

      const rows = await app.db
        .select()
        .from(serverMetricsRollup)
        .where(
          and(
            eq(serverMetricsRollup.serverId, serverId),
            gte(serverMetricsRollup.ts, from),
            lte(serverMetricsRollup.ts, to),
          ),
        )
        .orderBy(asc(serverMetricsRollup.ts))
        .limit(METRICS_POINT_LIMIT);
      const points = rows.map((r) => ({
        ts: r.ts.toISOString(),
        cpuPctAvg: r.cpuPctAvg,
        cpuPctMax: r.cpuPctMax,
        load1mAvg: r.load1mAvg,
        load1mMax: r.load1mMax,
        memUsedBytesAvg: r.memUsedBytesAvg,
        memUsedBytesMax: r.memUsedBytesMax,
        memTotalBytes: r.memTotalBytes,
        diskUsedBytesAvg: r.diskUsedBytesAvg,
        diskUsedBytesMax: r.diskUsedBytesMax,
        diskTotalBytes: r.diskTotalBytes,
        netRxBytesSum: r.netRxBytesSum,
        netTxBytesSum: r.netTxBytesSum,
      }));

      if (checkId === undefined) return { resolution: "5m" as const, points };

      const rollupRows = await app.db
        .select()
        .from(checkSamplesRollup)
        .where(
          and(
            eq(checkSamplesRollup.checkId, checkId),
            gte(checkSamplesRollup.ts, from),
            lte(checkSamplesRollup.ts, to),
          ),
        )
        .orderBy(asc(checkSamplesRollup.ts))
        .limit(METRICS_POINT_LIMIT);
      const checkPoints = rollupRows.map((r) => ({
        ts: r.ts.toISOString(),
        upCount: r.upCount,
        downCount: r.downCount,
        latencyMsAvg: r.latencyMsAvg,
        latencyMsMax: r.latencyMsMax,
      }));
      return { resolution: "5m" as const, points, checkPoints };
    },
  );
}
