/**
 * Test d'integrazione end-to-end agente ↔ server: il loop REALE dell'agente
 * (`runAgentLoop` da @stubwise/agent, devDep del server — la dipendenza
 * agent→shared non crea cicli) parla via HTTP VERO (app.listen su porta
 * effimera + IngestClient reale) con il buildApp del server, che scrive su un
 * Postgres testcontainers. Il check `postgres` è REALE e punta al testcontainer
 * stesso, quindi esercita davvero driver, query pg_stat_database e delta tps.
 *
 * L'unica parte finta è `collectSample` (deterministico: niente /proc su
 * macOS/CI) e i timer, compressi con un cap sul delay così gli intervalli
 * minimi consentiti dagli schemi (10s) girano in centinaia di ms senza
 * cambiare la logica del loop.
 */
import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IngestClient,
  pruneCheckState,
  resetCheckState,
  runAgentLoop,
  runCheck,
  type AgentLoopController,
} from "@stubwise/agent";
import { checkSamples, serverMetrics } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { MetricSample } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

/** Cap sui delay dei timer del loop: 10s di intervallo → tick ogni ~250ms. */
const TIMER_CAP_MS = 250;

let testDb: TestDb;
let app: FastifyInstance;
let baseUrl: string;
let adminCookie: string;
let controller: AgentLoopController | undefined;

/**
 * collectSample finto ma deterministico e conforme a metricSampleSchema:
 * timestamp che avanzano di 30s a partire da ~5 minuti fa (restano "recenti"
 * per lo snapshot) e cpuPct crescente per riconoscere i campioni in DB.
 */
function makeFakeCollectSample(): () => Promise<MetricSample | null> {
  const base = Date.now() - 5 * 60_000;
  let n = 0;
  return async () => {
    const i = n++;
    return {
      ts: new Date(base + i * 30_000).toISOString(),
      cpuPct: 10 + i,
      load1m: 0.42,
      memUsedBytes: 512 * 1024 * 1024,
      memTotalBytes: 2048 * 1024 * 1024,
      swapUsedBytes: 0,
      diskUsedBytes: 10_000_000,
      diskTotalBytes: 100_000_000,
      disks: [{ mount: "/", usedBytes: 10_000_000, totalBytes: 100_000_000 }],
      netRxBytes: 1000 + i,
      netTxBytes: 2000 + i,
      services: [
        {
          source: "docker" as const,
          name: "fake-service",
          state: "running",
          cpuPct: 1.5,
          memBytes: 1024 * 1024,
          restarts: null,
        },
      ],
    };
  };
}

/** Polla `cond` fino a `timeoutMs`; oltre, fallisce con l'etichetta. */
async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout in attesa di: ${label}`);
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    // I tick compressi fanno molte richieste /monitor in pochi secondi: il
    // rate limit di default non deve interferire con il test.
    monitorRateLimit: { max: 100_000, timeWindow: "1 minute" },
  });
  ({ adminCookie } = await seedUsers(app));
  // Listen su porta effimera: l'IngestClient dell'agente parla HTTP vero.
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
}, 120_000);

afterAll(async () => {
  await controller?.stop();
  resetCheckState();
  await app.close();
  await testDb.stop();
}, 120_000);

describe("integrazione agente ↔ server", () => {
  it(
    "il loop reale invia metriche via HTTP e il check postgres gira davvero contro il testcontainer",
    async () => {
      // 1. Registrazione del server via route admin → chiave sk_ in chiaro.
      const createRes = await app.inject({
        method: "POST",
        url: "/api/servers",
        headers: { cookie: adminCookie },
        payload: { name: "integrazione-01" },
      });
      expect(createRes.statusCode).toBe(201);
      const { id: serverId, key } = createRes.json() as { id: string; key: string };
      expect(key).toMatch(/^sk_[0-9a-f]{48}$/);

      // 2. Check postgres il cui DSN è il testcontainer del test stesso.
      const checkRes = await app.inject({
        method: "POST",
        url: `/api/servers/${serverId}/checks`,
        headers: { cookie: adminCookie },
        payload: {
          type: "postgres",
          name: "db-di-test",
          target: testDb.container.getConnectionUri(),
          intervalSeconds: 10, // minimo consentito dallo schema
          enabled: true,
        },
      });
      expect(checkRes.statusCode).toBe(201);
      const { id: checkId } = checkRes.json() as { id: string };

      // 3. Client REALE puntato all'URL del listen: la config iniziale arriva
      //    da GET /monitor/config con il DSN decifrato nel target.
      const client = new IngestClient({
        baseUrl,
        serverKey: key,
        hostname: "agent-integration-host",
        agentVersion: "0.0.0-it",
      });
      const initialConfig = await client.fetchConfig();
      expect(initialConfig).not.toBeNull();
      expect(initialConfig!.checks).toHaveLength(1);
      expect(initialConfig!.checks[0]!.id).toBe(checkId);
      expect(initialConfig!.checks[0]!.target).toBe(testDb.container.getConnectionUri());

      // 4. Loop REALE: runCheck vero (contro il testcontainer), collectSample
      //    finto, timer con cap sul delay per comprimere gli intervalli.
      controller = runAgentLoop(
        {
          collectSample: makeFakeCollectSample(),
          runCheck: (config) => runCheck(config, { timeoutMs: 5_000 }),
          client,
          pruneCheckState,
        },
        {
          initialConfig: initialConfig!,
          timers: {
            setTimeout: (cb, ms) => setTimeout(cb, Math.min(ms, TIMER_CAP_MS)),
            clearTimeout: (h) => clearTimeout(h),
          },
        },
      );

      // 5. Dopo 2+ tick: metriche in server_metrics e 2+ run del check in
      //    check_samples (il secondo run produce anche il tps dal delta).
      await waitFor(
        async () => {
          const metricRows = await testDb.db
            .select({ ts: serverMetrics.ts })
            .from(serverMetrics)
            .where(eq(serverMetrics.serverId, serverId));
          const sampleRows = await testDb.db
            .select({ id: checkSamples.id })
            .from(checkSamples)
            .where(eq(checkSamples.checkId, checkId));
          return metricRows.length >= 2 && sampleRows.length >= 2;
        },
        60_000,
        "2 campioni host in server_metrics e 2 run del check postgres",
      );

      await controller.stop();
      controller = undefined;

      // 6a. Le metriche host in DB sono quelle del collector (cpuPct 10, 11, …).
      const metricRows = await testDb.db
        .select()
        .from(serverMetrics)
        .where(eq(serverMetrics.serverId, serverId))
        .orderBy(asc(serverMetrics.ts));
      expect(metricRows.length).toBeGreaterThanOrEqual(2);
      expect(metricRows[0]!.cpuPct).toBe(10);
      expect(metricRows[1]!.cpuPct).toBe(11);
      expect(metricRows[0]!.services).toEqual([
        expect.objectContaining({ source: "docker", name: "fake-service" }),
      ]);

      // 6b. Il check postgres ha girato DAVVERO: up, latenza misurata e
      //     metriche interne dal testcontainer (connections = numbackends ≥ 1
      //     perché il pool del test è connesso; dal secondo run anche il tps).
      const sampleRows = await testDb.db
        .select()
        .from(checkSamples)
        .where(eq(checkSamples.checkId, checkId))
        .orderBy(asc(checkSamples.ts));
      expect(sampleRows.length).toBeGreaterThanOrEqual(2);
      for (const row of sampleRows) {
        expect(row.status).toBe("up");
        expect(row.latencyMs).toBeGreaterThanOrEqual(0);
      }
      const firstMetrics = sampleRows[0]!.metrics as Record<string, number>;
      expect(firstMetrics.connections).toBeGreaterThanOrEqual(1);
      expect(firstMetrics.maxConnections).toBeGreaterThan(0);
      expect(firstMetrics.dbSizeBytes).toBeGreaterThan(0);
      // Il primo run non ha delta → niente tps; dal secondo sì (anche 0 vale).
      expect(firstMetrics).not.toHaveProperty("tps");
      const withTps = sampleRows
        .slice(1)
        .filter((r) => "tps" in (r.metrics as Record<string, number>));
      expect(withTps.length).toBeGreaterThanOrEqual(1);
      for (const row of withTps) {
        expect((row.metrics as Record<string, number>).tps).toBeGreaterThanOrEqual(0);
      }

      // 6c. La vista admin riflette l'ingest: online, recentCpu popolato,
      //     hostname/agentVersion dell'agente, check conteggiato up.
      const detailRes = await app.inject({
        method: "GET",
        url: `/api/servers/${serverId}`,
        headers: { cookie: adminCookie },
      });
      expect(detailRes.statusCode).toBe(200);
      const detail = detailRes.json() as {
        status: string;
        hostname: string | null;
        agentVersion: string | null;
        recentCpu: number[];
        checksUp: number;
        checksDown: number;
        services: { name: string }[];
      };
      expect(detail.status).toBe("online");
      expect(detail.hostname).toBe("agent-integration-host");
      expect(detail.agentVersion).toBe("0.0.0-it");
      expect(detail.recentCpu.length).toBeGreaterThanOrEqual(2);
      expect(detail.recentCpu).toContain(10);
      expect(detail.checksUp).toBe(1);
      expect(detail.checksDown).toBe(0);
      expect(detail.services).toEqual([
        expect.objectContaining({ name: "fake-service" }),
      ]);
    },
    120_000,
  );
});
