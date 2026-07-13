import { agentConfigSchema, ingestBodySchema } from "@stubwise/shared";
import type { AgentCheckConfig } from "@stubwise/shared";
import { checkSamples, decrypt, serverMetrics, servers, serviceChecks } from "@stubwise/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import { errorSchema, hashServerKey, unprocessableEntityFormatter } from "./shared.js";
import type { RateLimitConfig } from "./shared.js";

export interface MonitorRoutesOptions {
  /** Limite di richieste per chiave del server (default 600/min). */
  rateLimit: RateLimitConfig;
}

/** Riga completa del server autenticato, decorata su request.monitorServer. */
type ServerRow = typeof servers.$inferSelect;

/**
 * Superficie PUBBLICA server-to-server del monitoraggio: POST /monitor/ingest e
 * GET /monitor/config. La invoca l'agente installato sull'host monitorato, non
 * un browser: nessun CORS (nessuna origine da autorizzare).
 *
 * Autenticazione: header X-Stubwise-Server-Key ri-hashato (sha256) e cercato
 * sulla colonna unique `servers.key_hash`. La chiave in chiaro non è mai
 * persistita: il lookup su hash non offre un confronto in tempo variabile utile
 * a un attaccante. Header assente e chiave sconosciuta producono la stessa 401
 * `invalid_server_key`. Il controllo sta in preValidation, condiviso da ingest
 * e config: una richiesta non autenticata riceve 401 anche con payload malformato.
 *
 * Validazione: un body ingest non valido risponde 422 (via
 * schemaErrorFormatter), come le altre superfici pubbliche.
 */
export async function monitorRoutes(
  instance: FastifyInstance,
  opts: MonitorRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * preValidation condivisa: autentica il server dall'header
   * X-Stubwise-Server-Key (sha256 → lookup su key_hash) e decora
   * request.monitorServer (riga completa). Ramo unico di rifiuto: header assente
   * e chiave sconosciuta sono indistinguibili (stessa 401 invalid_server_key).
   */
  const authenticateServer = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const provided = request.headers["x-stubwise-server-key"];
    let server: ServerRow | undefined;
    if (typeof provided === "string" && provided.length > 0) {
      [server] = await app.db
        .select()
        .from(servers)
        .where(eq(servers.keyHash, hashServerKey(provided)));
    }
    if (!server) {
      await apiError(reply, 401, "invalid_server_key", "Invalid server key");
      return;
    }
    request.monitorServer = server;
  };

  // Bucket per chiave del server (fallback IP per le richieste senza header): un
  // server loquace non consuma il budget degli altri. Riusato da ingest e config.
  const rateLimit = {
    ...opts.rateLimit,
    keyGenerator: (request: FastifyRequest) =>
      (request.headers["x-stubwise-server-key"] as string | undefined) ?? request.ip,
  };

  /**
   * Ingest di un batch: campioni host + esiti dei check. Idempotente su entrambe
   * le tabelle (onConflictDoNothing sull'unique (server,ts) / (check,ts)), così i
   * retry del buffer dell'agente non duplicano righe. Aggiorna last_seen/hostname/
   * agent_version del server e lo stato corrente dei check.
   */
  app.post(
    "/ingest",
    {
      config: { rateLimit },
      preValidation: authenticateServer,
      schemaErrorFormatter: unprocessableEntityFormatter,
      schema: {
        body: ingestBodySchema,
        response: {
          200: z.object({
            accepted: z.number().int(),
            checkResultsAccepted: z.number().int(),
          }),
          401: errorSchema,
        },
      },
    },
    async (request) => {
      const server = request.monitorServer!;
      const { hostname, agentVersion, samples, checkResults } = request.body;

      // Campioni host: ts (ISO) → Date. onConflictDoNothing su (server_id, ts)
      // rende il re-invio dello stesso batch un no-op (idempotenza).
      const metricRows = samples.map((s) => ({
        serverId: server.id,
        ts: new Date(s.ts),
        cpuPct: s.cpuPct,
        load1m: s.load1m,
        memUsedBytes: s.memUsedBytes,
        memTotalBytes: s.memTotalBytes,
        swapUsedBytes: s.swapUsedBytes,
        diskUsedBytes: s.diskUsedBytes,
        diskTotalBytes: s.diskTotalBytes,
        netRxBytes: s.netRxBytes,
        netTxBytes: s.netTxBytes,
        disks: s.disks,
        services: s.services,
      }));
      await app.db
        .insert(serverMetrics)
        .values(metricRows)
        .onConflictDoNothing({ target: [serverMetrics.serverId, serverMetrics.ts] });

      // Il server ha appena parlato: aggiorna heartbeat e identità dichiarata.
      await app.db
        .update(servers)
        .set({ lastSeenAt: new Date(), hostname, agentVersion })
        .where(eq(servers.id, server.id));

      let checkResultsAccepted = 0;
      if (checkResults.length > 0) {
        // Filtro preventivo: teniamo solo i risultati dei check che appartengono
        // a QUESTO server (un checkId di un altro server è scartato in silenzio).
        const batchCheckIds = [...new Set(checkResults.map((r) => r.checkId))];
        const ownChecks = await app.db
          .select({ id: serviceChecks.id, lastStatus: serviceChecks.lastStatus })
          .from(serviceChecks)
          .where(
            and(eq(serviceChecks.serverId, server.id), inArray(serviceChecks.id, batchCheckIds)),
          );
        const prevStatus = new Map(ownChecks.map((c) => [c.id, c.lastStatus]));
        const accepted = checkResults.filter((r) => prevStatus.has(r.checkId));

        if (accepted.length > 0) {
          // Sample grezzi: idempotenti su (check_id, ts) come le metriche host.
          await app.db
            .insert(checkSamples)
            .values(
              accepted.map((r) => ({
                checkId: r.checkId,
                ts: new Date(r.ts),
                status: r.status,
                latencyMs: r.latencyMs,
                metrics: r.metrics,
              })),
            )
            .onConflictDoNothing({ target: [checkSamples.checkId, checkSamples.ts] });
          checkResultsAccepted = accepted.length;

          // Stato corrente per check: vince il risultato con ts più recente del
          // batch (l'agente può accumulare più esiti prima di spedire).
          const latestByCheck = new Map<string, (typeof accepted)[number]>();
          for (const r of accepted) {
            const cur = latestByCheck.get(r.checkId);
            if (!cur || new Date(r.ts) > new Date(cur.ts)) latestByCheck.set(r.checkId, r);
          }

          for (const [checkId, r] of latestByCheck) {
            const ts = new Date(r.ts);
            const patch: Partial<typeof serviceChecks.$inferInsert> = {
              lastStatus: r.status,
              lastCheckedAt: ts,
              lastLatencyMs: r.latencyMs,
              lastError: r.error,
            };
            // down_since marca l'INIZIO della finestra di down: si valorizza solo
            // alla transizione up→down (non si sovrascrive se già down), si azzera
            // alla risalita. down_notified_at NON si tocca MAI qui: lo scrive/azzera
            // solo il worker (evaluator alert / recovered).
            if (r.status === "down" && prevStatus.get(checkId) !== "down") {
              patch.downSince = ts;
            } else if (r.status === "up") {
              patch.downSince = null;
            }
            await app.db.update(serviceChecks).set(patch).where(eq(serviceChecks.id, checkId));
          }
        }
      }

      return { accepted: samples.length, checkResultsAccepted };
    },
  );

  /**
   * Config che l'agente scarica periodicamente: intervallo di campionamento del
   * server + i suoi check abilitati. Per i check DB (postgres/mysql) il `target`
   * è il DSN DECIFRATO (l'agente ne ha bisogno per connettersi); un DSN mancante
   * o non decifrabile esclude il check e logga un warning, senza abbattere
   * l'endpoint (mai 500 su una riga corrotta).
   */
  app.get(
    "/config",
    {
      config: { rateLimit },
      preValidation: authenticateServer,
      schema: {
        response: {
          200: agentConfigSchema,
          401: errorSchema,
        },
      },
    },
    async (request) => {
      const server = request.monitorServer!;
      const rows = await app.db
        .select()
        .from(serviceChecks)
        .where(and(eq(serviceChecks.serverId, server.id), eq(serviceChecks.enabled, true)));

      const checks: AgentCheckConfig[] = [];
      for (const c of rows) {
        let target = c.target;
        if (c.type === "postgres" || c.type === "mysql") {
          if (!c.dsnEncrypted) {
            request.log.warn({ checkId: c.id }, "monitor config: check DB senza DSN, escluso");
            continue;
          }
          try {
            target = decrypt(c.dsnEncrypted, app.encryptionKey);
          } catch (err) {
            request.log.warn(
              { err, checkId: c.id },
              "monitor config: DSN non decifrabile, check escluso",
            );
            continue;
          }
        }
        checks.push({
          id: c.id,
          type: c.type,
          name: c.name,
          target,
          intervalSeconds: c.intervalSeconds,
        });
      }

      return { sampleIntervalSeconds: server.sampleIntervalSeconds, checks };
    },
  );
}

declare module "fastify" {
  interface FastifyRequest {
    /** Server autenticato (riga completa) dalla preValidation della superficie monitor. */
    monitorServer?: ServerRow;
  }
}
