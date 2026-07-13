import {
  checkSamples,
  checkSamplesRollup,
  serverMetrics,
  serverMetricsRollup,
  servers,
  serviceChecks,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rollupMonitorOnce, startMonitorRollupPoller } from "./rollup.js";

// Un container Postgres per file di test (l'avvio costa secondi). I test si
// isolano cancellando i server e i check in afterEach: le cascade FK svuotano
// metriche, sample e rollup.
let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(servers);
});

afterAll(async () => {
  await testDb.stop();
});

// `now` fisso per cutoff deterministici: 48h prima = 2026-07-11T12:00Z.
const NOW = new Date("2026-07-13T12:00:00Z");
const CUTOFF_48H = new Date("2026-07-11T12:00:00Z");
// Inizio di un bucket da 5 minuti ben oltre le 48h.
const OLD_BUCKET = new Date("2026-07-10T10:00:00Z");
const RECENT_TS = new Date("2026-07-13T11:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60_000);
}

async function seedServer(db: Db): Promise<string> {
  const [server] = await db
    .insert(servers)
    .values({ name: "srv-test", keyHash: `hash-${crypto.randomUUID()}` })
    .returning({ id: servers.id });
  if (!server) throw new Error("insert del server non ha restituito la riga");
  return server.id;
}

async function seedCheck(db: Db, serverId: string): Promise<string> {
  const [check] = await db
    .insert(serviceChecks)
    .values({ serverId, type: "http", name: "check-test", target: "https://example.test" })
    .returning({ id: serviceChecks.id });
  if (!check) throw new Error("insert del check non ha restituito la riga");
  return check.id;
}

interface MetricOverrides {
  cpuPct?: number;
  load1m?: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  diskUsedBytes?: number;
  diskTotalBytes?: number;
  netRxBytes?: number;
  netTxBytes?: number;
}

async function seedMetric(
  db: Db,
  serverId: string,
  ts: Date,
  overrides: MetricOverrides = {},
): Promise<void> {
  await db.insert(serverMetrics).values({
    serverId,
    ts,
    cpuPct: 0,
    load1m: 0,
    memUsedBytes: 0,
    memTotalBytes: 0,
    swapUsedBytes: 0,
    diskUsedBytes: 0,
    diskTotalBytes: 0,
    netRxBytes: 0,
    netTxBytes: 0,
    ...overrides,
  });
}

/** Sposta `OLD_BUCKET` di `seconds` secondi (per campioni dentro lo stesso bucket). */
function inOldBucket(seconds: number): Date {
  return new Date(OLD_BUCKET.getTime() + seconds * 1000);
}

describe("rollupMonitorOnce — server_metrics", () => {
  it("aggrega i campioni più vecchi di 48h in bucket da 5 minuti e li cancella", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);

    // Tre campioni nello stesso bucket [10:00, 10:05).
    await seedMetric(db, serverId, inOldBucket(0), {
      cpuPct: 10,
      load1m: 1,
      memUsedBytes: 100,
      memTotalBytes: 1000,
      diskUsedBytes: 10,
      diskTotalBytes: 5000,
      netRxBytes: 5,
      netTxBytes: 1,
    });
    await seedMetric(db, serverId, inOldBucket(60), {
      cpuPct: 20,
      load1m: 2,
      memUsedBytes: 200,
      memTotalBytes: 1000,
      diskUsedBytes: 20,
      diskTotalBytes: 5000,
      netRxBytes: 10,
      netTxBytes: 2,
    });
    await seedMetric(db, serverId, inOldBucket(240), {
      cpuPct: 60,
      load1m: 3,
      memUsedBytes: 300,
      memTotalBytes: 2000,
      diskUsedBytes: 30,
      diskTotalBytes: 5000,
      netRxBytes: 15,
      netTxBytes: 3,
    });
    // Campione recente: NON deve essere toccato.
    await seedMetric(db, serverId, RECENT_TS, { cpuPct: 99 });
    // Campione ESATTAMENTE al cutoff: il predicato è strettamente <, resta fine.
    await seedMetric(db, serverId, CUTOFF_48H, { cpuPct: 50 });

    await rollupMonitorOnce(db, NOW);

    const rollups = await db.select().from(serverMetricsRollup);
    expect(rollups).toHaveLength(1);
    const rollup = rollups[0]!;
    expect(rollup.serverId).toBe(serverId);
    expect(rollup.ts.getTime()).toBe(OLD_BUCKET.getTime());
    expect(rollup.cpuPctAvg).toBeCloseTo(30); // (10+20+60)/3
    expect(rollup.cpuPctMax).toBe(60);
    expect(rollup.load1mAvg).toBeCloseTo(2); // (1+2+3)/3
    expect(rollup.load1mMax).toBe(3);
    expect(rollup.memUsedBytesAvg).toBe(200); // (100+200+300)/3
    expect(rollup.memUsedBytesMax).toBe(300);
    expect(rollup.memTotalBytes).toBe(2000); // max del bucket
    expect(rollup.diskUsedBytesAvg).toBe(20); // (10+20+30)/3
    expect(rollup.diskUsedBytesMax).toBe(30);
    expect(rollup.diskTotalBytes).toBe(5000); // max del bucket
    expect(rollup.netRxBytesSum).toBe(30); // 5+10+15
    expect(rollup.netTxBytesSum).toBe(6); // 1+2+3

    // I fini vecchi sono cancellati, i recenti (e il boundary) restano.
    const fine = await db.select({ ts: serverMetrics.ts }).from(serverMetrics);
    const fineTs = fine.map((r) => r.ts.getTime()).sort();
    expect(fineTs).toEqual([CUTOFF_48H.getTime(), RECENT_TS.getTime()].sort());
  });

  it("con now non allineato al bucket, il bucket a cavallo del cutoff resta intatto nei fini", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    // now = 12:02:30Z → cutoff grezzo 48h = 2026-07-11T12:02:30Z, in MEZZO al
    // bucket [12:00, 12:05). Il cutoff effettivo deve scendere al confine di
    // bucket (12:00): niente aggregazioni parziali del bucket a cavallo.
    const unalignedNow = new Date("2026-07-13T12:02:30Z");
    const straddleA = new Date("2026-07-11T12:00:30Z"); // < cutoff grezzo, bucket a cavallo
    const straddleB = new Date("2026-07-11T12:02:00Z"); // < cutoff grezzo, bucket a cavallo
    const fullyOld = new Date("2026-07-11T11:50:10Z"); // bucket [11:50, 11:55) interamente oltre
    await seedMetric(db, serverId, straddleA, { cpuPct: 10 });
    await seedMetric(db, serverId, straddleB, { cpuPct: 20 });
    await seedMetric(db, serverId, fullyOld, { cpuPct: 30 });

    await rollupMonitorOnce(db, unalignedNow);

    // Solo il bucket completo è stato aggregato…
    const rollups = await db.select().from(serverMetricsRollup);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.ts.getTime()).toBe(new Date("2026-07-11T11:50:00Z").getTime());
    expect(rollups[0]!.cpuPctAvg).toBeCloseTo(30);
    // …e il bucket a cavallo è INTATTO nei fini (nessuna cancellazione parziale).
    const fine = await db.select({ ts: serverMetrics.ts }).from(serverMetrics);
    const fineTs = fine.map((r) => r.ts.getTime()).sort();
    expect(fineTs).toEqual([straddleA.getTime(), straddleB.getTime()].sort());
  });

  it("cancella i rollup più vecchi di 90 giorni e tiene quelli più recenti", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    const rollupBase = {
      serverId,
      cpuPctAvg: 1,
      cpuPctMax: 1,
      load1mAvg: 1,
      load1mMax: 1,
      memUsedBytesAvg: 1,
      memUsedBytesMax: 1,
      memTotalBytes: 1,
      diskUsedBytesAvg: 1,
      diskUsedBytesMax: 1,
      diskTotalBytes: 1,
      netRxBytesSum: 1,
      netTxBytesSum: 1,
    };
    await db.insert(serverMetricsRollup).values({ ...rollupBase, ts: daysAgo(91) });
    await db.insert(serverMetricsRollup).values({ ...rollupBase, ts: daysAgo(89) });

    await rollupMonitorOnce(db, NOW);

    const remaining = await db
      .select({ ts: serverMetricsRollup.ts })
      .from(serverMetricsRollup);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.ts.getTime()).toBe(daysAgo(89).getTime());
  });

  it("è idempotente: rilanciato con lo stesso now non crea né altera i bucket", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    await seedMetric(db, serverId, inOldBucket(0), { cpuPct: 10 });
    await seedMetric(db, serverId, inOldBucket(60), { cpuPct: 20 });

    await rollupMonitorOnce(db, NOW);
    // Seconda chiamata a vuoto: nessuna riga nuova.
    await rollupMonitorOnce(db, NOW);
    let rollups = await db.select().from(serverMetricsRollup);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.cpuPctAvg).toBeCloseTo(15);

    // Un campione "in ritardo" nello stesso bucket già aggregato: on conflict
    // do nothing → il bucket NON cambia, ma il fine viene comunque cancellato.
    await seedMetric(db, serverId, inOldBucket(120), { cpuPct: 100 });
    await rollupMonitorOnce(db, NOW);
    rollups = await db.select().from(serverMetricsRollup);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.cpuPctAvg).toBeCloseTo(15);
    const fine = await db.select().from(serverMetrics);
    expect(fine).toHaveLength(0);
  });
});

describe("rollupMonitorOnce — check_samples", () => {
  it("aggrega gli esiti vecchi per status con latenze sui soli non-null e li cancella", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    const checkId = await seedCheck(db, serverId);

    await db.insert(checkSamples).values([
      { checkId, ts: inOldBucket(0), status: "up", latencyMs: 100 },
      { checkId, ts: inOldBucket(60), status: "up", latencyMs: 300 },
      { checkId, ts: inOldBucket(120), status: "down", latencyMs: null },
      // `unknown` non conta né come up né come down.
      { checkId, ts: inOldBucket(180), status: "unknown", latencyMs: null },
      // Recente: resta fine.
      { checkId, ts: RECENT_TS, status: "up", latencyMs: 42 },
    ]);

    await rollupMonitorOnce(db, NOW);

    const rollups = await db.select().from(checkSamplesRollup);
    expect(rollups).toHaveLength(1);
    const rollup = rollups[0]!;
    expect(rollup.checkId).toBe(checkId);
    expect(rollup.ts.getTime()).toBe(OLD_BUCKET.getTime());
    expect(rollup.upCount).toBe(2);
    expect(rollup.downCount).toBe(1);
    expect(rollup.latencyMsAvg).toBeCloseTo(200); // (100+300)/2, i null esclusi
    expect(rollup.latencyMsMax).toBe(300);

    const fine = await db.select({ ts: checkSamples.ts }).from(checkSamples);
    expect(fine).toHaveLength(1);
    expect(fine[0]!.ts.getTime()).toBe(RECENT_TS.getTime());
  });

  it("un bucket di soli null produce latenze null", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    const checkId = await seedCheck(db, serverId);
    await db.insert(checkSamples).values([
      { checkId, ts: inOldBucket(0), status: "down", latencyMs: null },
    ]);

    await rollupMonitorOnce(db, NOW);

    const rollups = await db.select().from(checkSamplesRollup);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.upCount).toBe(0);
    expect(rollups[0]!.downCount).toBe(1);
    expect(rollups[0]!.latencyMsAvg).toBeNull();
    expect(rollups[0]!.latencyMsMax).toBeNull();
  });

  it("cancella i rollup dei check più vecchi di 90 giorni", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    const checkId = await seedCheck(db, serverId);
    await db.insert(checkSamplesRollup).values([
      { checkId, ts: daysAgo(91), upCount: 1, downCount: 0 },
      { checkId, ts: daysAgo(89), upCount: 1, downCount: 0 },
    ]);

    await rollupMonitorOnce(db, NOW);

    const remaining = await db.select({ ts: checkSamplesRollup.ts }).from(checkSamplesRollup);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.ts.getTime()).toBe(daysAgo(89).getTime());
  });
});

describe("startMonitorRollupPoller", () => {
  it("con intervalMinutes <= 0 non avvia nulla", () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const stop = startMonitorRollupPoller({
        db: testDb.db,
        intervalMinutes: 0,
        signal: controller.signal,
      });
      expect(vi.getTimerCount()).toBe(0);
      stop();
      controller.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it("esegue il rollup a ogni tick e si ferma sull'abort", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    // Campione di 3 giorni fa: oltre il cutoff delle 48h rispetto a Date.now().
    await seedMetric(db, serverId, new Date(Date.now() - 3 * 24 * 60 * 60_000), {
      cpuPct: 7,
    });
    const controller = new AbortController();
    // Intervallo frazionario (~60ms) per non aspettare minuti reali nel test.
    const stop = startMonitorRollupPoller({
      db,
      intervalMinutes: 0.001,
      signal: controller.signal,
    });
    try {
      await vi.waitFor(
        async () => {
          const rollups = await db.select().from(serverMetricsRollup);
          expect(rollups).toHaveLength(1);
        },
        { timeout: 5000, interval: 50 },
      );
    } finally {
      controller.abort();
      // Lo stop è idempotente: richiamarlo dopo l'abort non deve lanciare.
      stop();
    }
  });
});
