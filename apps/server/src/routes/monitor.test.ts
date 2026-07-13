import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import {
  checkSamples,
  encrypt,
  serverMetrics,
  servers,
  serviceChecks,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { generateServerKey, hashServerKey } from "./shared.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;

/** Registra un server (keyHash della chiave in chiaro) e ritorna riga + chiave. */
async function seedServer(
  db: Db,
  overrides: Partial<typeof servers.$inferInsert> = {},
): Promise<{ server: typeof servers.$inferSelect; key: string }> {
  const key = generateServerKey();
  const [server] = await db
    .insert(servers)
    .values({ name: "srv", keyHash: hashServerKey(key), ...overrides })
    .returning();
  return { server: server!, key };
}

/** Crea un check (http di default) su un server e ritorna la riga. */
async function seedCheck(
  db: Db,
  serverId: string,
  overrides: Partial<typeof serviceChecks.$inferInsert> = {},
): Promise<typeof serviceChecks.$inferSelect> {
  const [row] = await db
    .insert(serviceChecks)
    .values({
      serverId,
      type: "http",
      name: "web",
      target: "https://example.com",
      intervalSeconds: 60,
      enabled: true,
      ...overrides,
    })
    .returning();
  return row!;
}

/** Campione di metriche host coerente con metricSampleSchema. */
function sample(ts: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts,
    cpuPct: 10,
    load1m: 0.5,
    memUsedBytes: 1_000,
    memTotalBytes: 2_000,
    swapUsedBytes: 0,
    diskUsedBytes: 500,
    diskTotalBytes: 1_000,
    disks: [],
    netRxBytes: 100,
    netTxBytes: 200,
    services: [],
    ...over,
  };
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("POST /monitor/ingest", () => {
  it("chiave valida + 2 campioni → 200, righe metriche e server aggiornato", async () => {
    const { server, key } = await seedServer(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: "/monitor/ingest",
      headers: { "x-stubwise-server-key": key },
      payload: {
        hostname: "host-1",
        agentVersion: "1.2.3",
        samples: [sample("2026-07-13T10:00:00.000Z"), sample("2026-07-13T10:00:30.000Z")],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 2, checkResultsAccepted: 0 });

    const rows = await testDb.db
      .select()
      .from(serverMetrics)
      .where(eq(serverMetrics.serverId, server.id));
    expect(rows).toHaveLength(2);

    const [updated] = await testDb.db.select().from(servers).where(eq(servers.id, server.id));
    expect(updated!.hostname).toBe("host-1");
    expect(updated!.agentVersion).toBe("1.2.3");
    expect(updated!.lastSeenAt).not.toBeNull();
  });

  it("stesso batch rispedito (retry del buffer) → 200 e nessun duplicato", async () => {
    const { server, key } = await seedServer(testDb.db);
    const payload = {
      hostname: "h",
      agentVersion: "1",
      samples: [sample("2026-07-13T11:00:00.000Z")],
    };
    const first = await app.inject({
      method: "POST",
      url: "/monitor/ingest",
      headers: { "x-stubwise-server-key": key },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/monitor/ingest",
      headers: { "x-stubwise-server-key": key },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const rows = await testDb.db
      .select()
      .from(serverMetrics)
      .where(eq(serverMetrics.serverId, server.id));
    expect(rows).toHaveLength(1);
  });

  it("chiave assente → 401 invalid_server_key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/monitor/ingest",
      payload: { hostname: "h", agentVersion: "1", samples: [sample("2026-07-13T10:00:00.000Z")] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "invalid_server_key" });
  });

  it("chiave sbagliata → 401 invalid_server_key (identico all'assente)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/monitor/ingest",
      headers: { "x-stubwise-server-key": "sk_non-esiste" },
      payload: { hostname: "h", agentVersion: "1", samples: [sample("2026-07-13T10:00:00.000Z")] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "invalid_server_key" });
  });

  it("body malformato → 422", async () => {
    const { key } = await seedServer(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: "/monitor/ingest",
      headers: { "x-stubwise-server-key": key },
      payload: { hostname: "h" }, // manca agentVersion e samples
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("POST /monitor/ingest — checkResults", () => {
  it("check del server → sample + stato aggiornato; down_since alla transizione; check di altro server scartato", async () => {
    const { server, key } = await seedServer(testDb.db);
    const check = await seedCheck(testDb.db, server.id);
    const { server: other } = await seedServer(testDb.db);
    const otherCheck = await seedCheck(testDb.db, other.id);

    const res = await app.inject({
      method: "POST",
      url: "/monitor/ingest",
      headers: { "x-stubwise-server-key": key },
      payload: {
        hostname: "h",
        agentVersion: "1",
        samples: [sample("2026-07-13T12:00:00.000Z")],
        checkResults: [
          {
            checkId: check.id,
            ts: "2026-07-13T12:00:00.000Z",
            status: "down",
            latencyMs: 250,
            error: "timeout",
            metrics: null,
          },
          {
            checkId: otherCheck.id,
            ts: "2026-07-13T12:00:00.000Z",
            status: "up",
            latencyMs: 10,
            error: null,
            metrics: null,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    // Solo il check appartenente al server è stato accettato.
    expect(res.json()).toMatchObject({ checkResultsAccepted: 1 });

    const samples = await testDb.db
      .select()
      .from(checkSamples)
      .where(eq(checkSamples.checkId, check.id));
    expect(samples).toHaveLength(1);

    // Il check di un altro server è scartato silenziosamente: nessuna riga.
    const otherSamples = await testDb.db
      .select()
      .from(checkSamples)
      .where(eq(checkSamples.checkId, otherCheck.id));
    expect(otherSamples).toHaveLength(0);

    const [c] = await testDb.db
      .select()
      .from(serviceChecks)
      .where(eq(serviceChecks.id, check.id));
    expect(c!.lastStatus).toBe("down");
    expect(c!.lastLatencyMs).toBe(250);
    expect(c!.lastError).toBe("timeout");
    expect(c!.downSince?.toISOString()).toBe("2026-07-13T12:00:00.000Z");
  });

  it("down_since non si sovrascrive se il check è già down", async () => {
    const { server, key } = await seedServer(testDb.db);
    const original = new Date("2026-07-13T09:00:00.000Z");
    const check = await seedCheck(testDb.db, server.id, {
      lastStatus: "down",
      downSince: original,
    });
    await app.inject({
      method: "POST",
      url: "/monitor/ingest",
      headers: { "x-stubwise-server-key": key },
      payload: {
        hostname: "h",
        agentVersion: "1",
        samples: [sample("2026-07-13T12:30:00.000Z")],
        checkResults: [
          {
            checkId: check.id,
            ts: "2026-07-13T12:30:00.000Z",
            status: "down",
            latencyMs: null,
            error: "still down",
            metrics: null,
          },
        ],
      },
    });
    const [c] = await testDb.db
      .select()
      .from(serviceChecks)
      .where(eq(serviceChecks.id, check.id));
    expect(c!.downSince?.toISOString()).toBe(original.toISOString());
  });

  it("risalita up azzera down_since ma NON tocca down_notified_at", async () => {
    const { server, key } = await seedServer(testDb.db);
    const notified = new Date("2026-07-13T08:00:00.000Z");
    const check = await seedCheck(testDb.db, server.id, {
      lastStatus: "down",
      downSince: new Date("2026-07-13T07:00:00.000Z"),
      downNotifiedAt: notified,
    });
    await app.inject({
      method: "POST",
      url: "/monitor/ingest",
      headers: { "x-stubwise-server-key": key },
      payload: {
        hostname: "h",
        agentVersion: "1",
        samples: [sample("2026-07-13T13:00:00.000Z")],
        checkResults: [
          {
            checkId: check.id,
            ts: "2026-07-13T13:00:00.000Z",
            status: "up",
            latencyMs: 5,
            error: null,
            metrics: null,
          },
        ],
      },
    });
    const [c] = await testDb.db
      .select()
      .from(serviceChecks)
      .where(eq(serviceChecks.id, check.id));
    expect(c!.lastStatus).toBe("up");
    expect(c!.downSince).toBeNull();
    // L'ingest NON tocca MAI down_notified_at: lo consuma il worker (recovered).
    expect(c!.downNotifiedAt?.toISOString()).toBe(notified.toISOString());
  });

  it("più risultati per lo stesso check: vince il ts più recente", async () => {
    const { server, key } = await seedServer(testDb.db);
    const check = await seedCheck(testDb.db, server.id);
    await app.inject({
      method: "POST",
      url: "/monitor/ingest",
      headers: { "x-stubwise-server-key": key },
      payload: {
        hostname: "h",
        agentVersion: "1",
        samples: [sample("2026-07-13T14:00:00.000Z")],
        checkResults: [
          {
            checkId: check.id,
            ts: "2026-07-13T14:00:00.000Z",
            status: "down",
            latencyMs: 999,
            error: "old",
            metrics: null,
          },
          {
            checkId: check.id,
            ts: "2026-07-13T14:01:00.000Z",
            status: "up",
            latencyMs: 12,
            error: null,
            metrics: null,
          },
        ],
      },
    });
    const [c] = await testDb.db
      .select()
      .from(serviceChecks)
      .where(eq(serviceChecks.id, check.id));
    // Lo stato corrente riflette il risultato con ts più recente (up @14:01).
    expect(c!.lastStatus).toBe("up");
    expect(c!.lastLatencyMs).toBe(12);
  });
});

describe("GET /monitor/config", () => {
  it("intervallo + check abilitati, dsn postgres decifrato, disabilitati esclusi", async () => {
    const { server, key } = await seedServer(testDb.db, { sampleIntervalSeconds: 45 });
    const http = await seedCheck(testDb.db, server.id, {
      type: "http",
      name: "web",
      target: "https://api.example.com",
      intervalSeconds: 30,
    });
    const dsn = "postgres://user:pass@db:5432/app";
    const pg = await seedCheck(testDb.db, server.id, {
      type: "postgres",
      name: "db",
      target: "",
      dsnEncrypted: encrypt(dsn, ENCRYPTION_KEY),
      intervalSeconds: 60,
    });
    const disabled = await seedCheck(testDb.db, server.id, {
      type: "tcp",
      name: "off",
      target: "host:1234",
      enabled: false,
    });

    const res = await app.inject({
      method: "GET",
      url: "/monitor/config",
      headers: { "x-stubwise-server-key": key },
    });
    expect(res.statusCode).toBe(200);
    const cfg = res.json() as {
      sampleIntervalSeconds: number;
      checks: { id: string; type: string; target: string }[];
    };
    expect(cfg.sampleIntervalSeconds).toBe(45);

    const ids = cfg.checks.map((c) => c.id);
    expect(ids).toContain(http.id);
    expect(ids).toContain(pg.id);
    expect(ids).not.toContain(disabled.id);

    const pgCfg = cfg.checks.find((c) => c.id === pg.id);
    // Il DSN arriva DECIFRATO in chiaro nella config dell'agente.
    expect(pgCfg!.target).toBe(dsn);
  });

  it("dsn corrotto → check escluso, niente 500", async () => {
    const { server, key } = await seedServer(testDb.db);
    const good = await seedCheck(testDb.db, server.id, {
      type: "http",
      name: "web",
      target: "https://ok.example.com",
    });
    const bad = await seedCheck(testDb.db, server.id, {
      type: "postgres",
      name: "db",
      target: "",
      dsnEncrypted: "payload-non-decifrabile",
    });
    const res = await app.inject({
      method: "GET",
      url: "/monitor/config",
      headers: { "x-stubwise-server-key": key },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { checks: { id: string }[] }).checks.map((c) => c.id);
    expect(ids).toContain(good.id);
    expect(ids).not.toContain(bad.id);
  });

  it("chiave assente → 401 invalid_server_key", async () => {
    const res = await app.inject({ method: "GET", url: "/monitor/config" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "invalid_server_key" });
  });
});
