import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, seedRepository, type TestDb } from "./testing.js";
import {
  checkSamples,
  checkSamplesRollup,
  serverMetrics,
  serverMetricsRollup,
  serverProjects,
  servers,
  serviceChecks,
} from "./schema.js";

describe("monitor tables", () => {
  let testDb: TestDb;
  let projectId: string;
  beforeAll(async () => {
    testDb = await startTestDb();
    ({ projectId } = await seedRepository(testDb.db));
  }, 120_000);
  afterAll(() => testDb.stop());

  it("server con default: soglie di alert e activeAlerts vuoto", async () => {
    const [srv] = await testDb.db
      .insert(servers)
      .values({ name: "web-1", keyHash: "hash_" + crypto.randomUUID() })
      .returning();
    expect(srv!.id).toBeDefined();
    expect(srv!.sampleIntervalSeconds).toBe(30);
    expect(srv!.alertThresholds).toEqual({
      cpuPct: 95,
      memPct: 90,
      diskPct: 90,
      sustainedMinutes: 5,
    });
    expect(srv!.activeAlerts).toEqual({});
    // Niente colonna `status`: si calcola da lastSeenAt (default null).
    expect(srv!.lastSeenAt).toBeNull();
  });

  it("keyHash duplicato → throw (unique)", async () => {
    const keyHash = "hash_dup_" + crypto.randomUUID();
    await testDb.db.insert(servers).values({ name: "a", keyHash });
    await expect(
      testDb.db.insert(servers).values({ name: "b", keyHash }),
    ).rejects.toThrow();
  });

  it("join server↔progetto (N:M) con unique sulla coppia", async () => {
    const [srv] = await testDb.db
      .insert(servers)
      .values({ name: "join-srv", keyHash: "hash_" + crypto.randomUUID() })
      .returning();
    await testDb.db.insert(serverProjects).values({ serverId: srv!.id, projectId });
    const rows = await testDb.db
      .select()
      .from(serverProjects)
      .where(eq(serverProjects.serverId, srv!.id));
    expect(rows).toHaveLength(1);
    // Un solo legame per (server, progetto).
    await expect(
      testDb.db.insert(serverProjects).values({ serverId: srv!.id, projectId }),
    ).rejects.toThrow();
  });

  it("serverMetrics: unique su (server_id, ts), byte come number", async () => {
    const [srv] = await testDb.db
      .insert(servers)
      .values({ name: "metric-srv", keyHash: "hash_" + crypto.randomUUID() })
      .returning();
    const ts = new Date("2026-07-13T10:00:00.000Z");
    await testDb.db.insert(serverMetrics).values({
      serverId: srv!.id,
      ts,
      cpuPct: 12.5,
      load1m: 0.4,
      memUsedBytes: 8_000_000_000,
      memTotalBytes: 16_000_000_000,
      swapUsedBytes: 0,
      diskUsedBytes: 50_000_000_000,
      diskTotalBytes: 100_000_000_000,
      netRxBytes: 1024,
      netTxBytes: 2048,
    });
    const [m] = await testDb.db
      .select()
      .from(serverMetrics)
      .where(eq(serverMetrics.serverId, srv!.id));
    expect(m!.memUsedBytes).toBe(8_000_000_000);
    expect(m!.cpuPct).toBeCloseTo(12.5);
    expect(m!.disks).toEqual([]);
    expect(m!.services).toEqual([]);
    // Secondo insert allo stesso ts → violazione unique (upsert idempotente).
    await expect(
      testDb.db.insert(serverMetrics).values({
        serverId: srv!.id,
        ts,
        cpuPct: 99,
        load1m: 1,
        memUsedBytes: 1,
        memTotalBytes: 2,
        swapUsedBytes: 0,
        diskUsedBytes: 1,
        diskTotalBytes: 2,
        netRxBytes: 0,
        netTxBytes: 0,
      }),
    ).rejects.toThrow();
  });

  it("serviceChecks + checkSamples: unique su (check_id, ts)", async () => {
    const [srv] = await testDb.db
      .insert(servers)
      .values({ name: "check-srv", keyHash: "hash_" + crypto.randomUUID() })
      .returning();
    const [check] = await testDb.db
      .insert(serviceChecks)
      .values({ serverId: srv!.id, type: "http", name: "homepage", target: "https://x.it" })
      .returning();
    expect(check!.enabled).toBe(true);
    expect(check!.lastStatus).toBe("unknown");
    expect(check!.intervalSeconds).toBe(60);

    const ts = new Date("2026-07-13T10:00:00.000Z");
    await testDb.db.insert(checkSamples).values({
      checkId: check!.id,
      ts,
      status: "up",
      latencyMs: 42,
      metrics: { connections: 3 },
    });
    const [s] = await testDb.db
      .select()
      .from(checkSamples)
      .where(eq(checkSamples.checkId, check!.id));
    expect(s!.status).toBe("up");
    expect(s!.metrics).toEqual({ connections: 3 });
    await expect(
      testDb.db.insert(checkSamples).values({ checkId: check!.id, ts, status: "down" }),
    ).rejects.toThrow();
  });

  it("rollup: insert su entrambe le tabelle, unique su (server|check, ts)", async () => {
    const [srv] = await testDb.db
      .insert(servers)
      .values({ name: "rollup-srv", keyHash: "hash_" + crypto.randomUUID() })
      .returning();
    const ts = new Date("2026-07-13T10:00:00.000Z");
    const metricRollup = {
      serverId: srv!.id,
      ts,
      cpuPctAvg: 10.5,
      cpuPctMax: 80,
      load1mAvg: 0.3,
      load1mMax: 2.1,
      memUsedBytesAvg: 7_000_000_000,
      memUsedBytesMax: 9_000_000_000,
      memTotalBytes: 16_000_000_000,
      diskUsedBytesAvg: 40_000_000_000,
      diskUsedBytesMax: 45_000_000_000,
      diskTotalBytes: 100_000_000_000,
      netRxBytesSum: 123_456,
      netTxBytesSum: 654_321,
    };
    await testDb.db.insert(serverMetricsRollup).values(metricRollup);
    const [mr] = await testDb.db
      .select()
      .from(serverMetricsRollup)
      .where(eq(serverMetricsRollup.serverId, srv!.id));
    expect(mr!.memUsedBytesAvg).toBe(7_000_000_000);
    expect(mr!.cpuPctAvg).toBeCloseTo(10.5);
    // Un solo bucket per (server, ts): il ri-rollup fa upsert, non append.
    await expect(testDb.db.insert(serverMetricsRollup).values(metricRollup)).rejects.toThrow();

    const [check] = await testDb.db
      .insert(serviceChecks)
      .values({ serverId: srv!.id, type: "postgres", name: "db", dsnEncrypted: "blob" })
      .returning();
    const sampleRollup = {
      checkId: check!.id,
      ts,
      upCount: 58,
      downCount: 2,
      latencyMsAvg: 12.5,
      latencyMsMax: 300,
    };
    await testDb.db.insert(checkSamplesRollup).values(sampleRollup);
    const [cr] = await testDb.db
      .select()
      .from(checkSamplesRollup)
      .where(eq(checkSamplesRollup.checkId, check!.id));
    expect(cr!.upCount).toBe(58);
    expect(cr!.latencyMsAvg).toBeCloseTo(12.5);
    await expect(testDb.db.insert(checkSamplesRollup).values(sampleRollup)).rejects.toThrow();
  });

  it("delete server → cascade su join, metriche, check e sample", async () => {
    const [srv] = await testDb.db
      .insert(servers)
      .values({ name: "cascade-srv", keyHash: "hash_" + crypto.randomUUID() })
      .returning();
    await testDb.db.insert(serverProjects).values({ serverId: srv!.id, projectId });
    await testDb.db.insert(serverMetrics).values({
      serverId: srv!.id,
      ts: new Date("2026-07-13T11:00:00.000Z"),
      cpuPct: 1,
      load1m: 0,
      memUsedBytes: 1,
      memTotalBytes: 2,
      swapUsedBytes: 0,
      diskUsedBytes: 1,
      diskTotalBytes: 2,
      netRxBytes: 0,
      netTxBytes: 0,
    });
    const [check] = await testDb.db
      .insert(serviceChecks)
      .values({ serverId: srv!.id, type: "tcp", name: "ssh", target: "host:22" })
      .returning();
    await testDb.db.insert(checkSamples).values({
      checkId: check!.id,
      ts: new Date("2026-07-13T11:00:00.000Z"),
      status: "up",
    });

    await testDb.db.delete(servers).where(eq(servers.id, srv!.id));

    expect(
      await testDb.db.select().from(serverProjects).where(eq(serverProjects.serverId, srv!.id)),
    ).toHaveLength(0);
    expect(
      await testDb.db.select().from(serverMetrics).where(eq(serverMetrics.serverId, srv!.id)),
    ).toHaveLength(0);
    expect(
      await testDb.db.select().from(serviceChecks).where(eq(serviceChecks.serverId, srv!.id)),
    ).toHaveLength(0);
    // I sample del check spariscono con il check (cascade transitiva).
    expect(
      await testDb.db.select().from(checkSamples).where(eq(checkSamples.checkId, check!.id)),
    ).toHaveLength(0);
  });
});
