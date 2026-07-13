import { serverMetrics, servers, serviceChecks, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AlertThresholds } from "@stubwise/shared";
import type { MonitorCondition, NotificationEvent } from "@stubwise/notifications";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { evaluateMonitorAlertsOnce, startMonitorAlertPoller } from "./alerts.js";

// Un container Postgres per file (l'avvio costa secondi). Isolamento tra test:
// cancella i server in afterEach (cascade FK → metriche e check).
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

const NOW = new Date("2026-07-13T12:00:00Z");
const PUBLIC_URL = "https://stub.example";
const INTERVAL = 30; // secondi

// Dispatch fake che accumula gli eventi emessi.
function collector(): { events: NotificationEvent[]; dispatch: (db: Db, e: NotificationEvent) => Promise<void> } {
  const events: NotificationEvent[] = [];
  return {
    events,
    dispatch: async (_db, e) => {
      events.push(e);
    },
  };
}

type MonitorEvent = Extract<NotificationEvent, { condition: MonitorCondition }>;

function isMonitor(e: NotificationEvent): e is MonitorEvent {
  return e.kind === "monitor.alert" || e.kind === "monitor.recovered";
}

/** Estrae le condizioni dai soli eventi di monitoraggio. */
function conditionsOf(events: NotificationEvent[]): MonitorCondition[] {
  return events.filter(isMonitor).map((e) => e.condition);
}

interface ServerOverrides {
  name?: string;
  lastSeenAt?: Date | null;
  sampleIntervalSeconds?: number;
  alertThresholds?: AlertThresholds;
  activeAlerts?: Record<string, { since: string; notifiedAt: string | null }>;
}

async function seedServer(db: Db, o: ServerOverrides = {}): Promise<string> {
  const [row] = await db
    .insert(servers)
    .values({
      name: o.name ?? "srv-test",
      keyHash: `hash-${crypto.randomUUID()}`,
      sampleIntervalSeconds: o.sampleIntervalSeconds ?? INTERVAL,
      lastSeenAt: o.lastSeenAt === undefined ? NOW : o.lastSeenAt,
      ...(o.alertThresholds ? { alertThresholds: o.alertThresholds } : {}),
      ...(o.activeAlerts ? { activeAlerts: o.activeAlerts } : {}),
    })
    .returning({ id: servers.id });
  if (!row) throw new Error("insert server");
  return row.id;
}

interface MetricOverrides {
  cpuPct?: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  diskUsedBytes?: number;
  diskTotalBytes?: number;
}

async function seedMetric(db: Db, serverId: string, ts: Date, o: MetricOverrides = {}): Promise<void> {
  await db.insert(serverMetrics).values({
    serverId,
    ts,
    cpuPct: o.cpuPct ?? 0,
    load1m: 0,
    memUsedBytes: o.memUsedBytes ?? 0,
    memTotalBytes: o.memTotalBytes ?? 0,
    swapUsedBytes: 0,
    diskUsedBytes: o.diskUsedBytes ?? 0,
    diskTotalBytes: o.diskTotalBytes ?? 0,
    netRxBytes: 0,
    netTxBytes: 0,
  });
}

/** Semina `count` campioni ogni `INTERVAL` secondi che finiscono a `NOW`. */
async function seedWindow(
  db: Db,
  serverId: string,
  count: number,
  o: MetricOverrides | ((i: number) => MetricOverrides),
): Promise<void> {
  for (let i = 0; i < count; i++) {
    // i=0 il più vecchio, l'ultimo a NOW.
    const ts = new Date(NOW.getTime() - (count - 1 - i) * INTERVAL * 1000);
    const ov = typeof o === "function" ? o(i) : o;
    await seedMetric(db, serverId, ts, ov);
  }
}

async function readActiveAlerts(db: Db, serverId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ a: servers.activeAlerts })
    .from(servers)
    .where(eq(servers.id, serverId));
  return (row?.a ?? {}) as Record<string, unknown>;
}

async function seedCheck(
  db: Db,
  serverId: string,
  o: {
    name?: string;
    enabled?: boolean;
    lastStatus?: "up" | "down" | "unknown";
    lastError?: string | null;
    downNotifiedAt?: Date | null;
  } = {},
): Promise<string> {
  const [row] = await db
    .insert(serviceChecks)
    .values({
      serverId,
      type: "http",
      name: o.name ?? "check-test",
      target: "https://example.test",
      enabled: o.enabled ?? true,
      lastStatus: o.lastStatus ?? "unknown",
      lastError: o.lastError ?? null,
      downNotifiedAt: o.downNotifiedAt ?? null,
    })
    .returning({ id: serviceChecks.id });
  if (!row) throw new Error("insert check");
  return row.id;
}

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

describe("evaluateMonitorAlertsOnce — offline", () => {
  it("server offline → alert una volta sola, poi anti-spam; risalita → recovered e chiave rimossa", async () => {
    const { db } = testDb;
    // lastSeenAt vecchio di 4×intervallo (120s > soglia 90s) → offline.
    const offlineSeen = new Date(NOW.getTime() - 4 * INTERVAL * 1000);
    const serverId = await seedServer(db, { name: "srv-off", lastSeenAt: offlineSeen });

    const c1 = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c1.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c1.events).toHaveLength(1);
    const ev = c1.events[0]!;
    expect(ev.kind).toBe("monitor.alert");
    if (ev.kind !== "monitor.alert") throw new Error("narrow");
    expect(ev.condition).toBe("offline");
    expect(ev.serverName).toBe("srv-off");
    expect(ev.url).toBe(`${PUBLIC_URL}/monitor/servers/${serverId}`);
    const alerts1 = await readActiveAlerts(db, serverId);
    expect(alerts1.offline).toMatchObject({ notifiedAt: expect.any(String) });

    // Seconda valutazione, ancora offline: nessun nuovo evento (anti-spam).
    const c2 = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c2.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c2.events).toHaveLength(0);

    // Torna online: recovered e chiave rimossa.
    await db.update(servers).set({ lastSeenAt: NOW }).where(eq(servers.id, serverId));
    const c3 = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c3.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c3.events).toHaveLength(1);
    expect(c3.events[0]!.kind).toBe("monitor.recovered");
    expect(conditionsOf(c3.events)).toEqual(["offline"]);
    const alerts3 = await readActiveAlerts(db, serverId);
    expect(alerts3.offline).toBeUndefined();
  });

  it("never_connected (lastSeenAt null) → nessun alert", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db, { lastSeenAt: null });
    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c.events).toHaveLength(0);
    expect(await readActiveAlerts(db, serverId)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Soglie sostenute
// ---------------------------------------------------------------------------

describe("evaluateMonitorAlertsOnce — soglie sostenute", () => {
  it("cpu sopra soglia per tutta la finestra con campioni sufficienti → alert", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    // 5 minuti @30s ≈ 10 campioni attesi; minimo 50% = 5. Seminiamo 6 a 97%.
    await seedWindow(db, serverId, 6, { cpuPct: 97 });

    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c.events).toHaveLength(1);
    expect(c.events[0]!.kind).toBe("monitor.alert");
    expect(conditionsOf(c.events)).toEqual(["cpu"]);
    expect((await readActiveAlerts(db, serverId)).cpu).toBeDefined();
  });

  it("cpu sopra soglia da MENO di sustainedMinutes (campioni recenti sotto soglia) → niente", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    // 8 campioni nella finestra: i 3 più recenti sotto soglia → non TUTTI sforano.
    await seedWindow(db, serverId, 8, (i) => ({ cpuPct: i < 5 ? 99 : 20 }));

    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c.events).toHaveLength(0);
    expect((await readActiveAlerts(db, serverId)).cpu).toBeUndefined();
  });

  it("campioni troppo radi (sotto il 50% degli attesi) → niente anche se tutti sforano", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    // Solo 3 campioni (< 5 minimo) tutti a 99%.
    await seedWindow(db, serverId, 3, { cpuPct: 99 });

    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c.events).toHaveLength(0);
  });

  it("soglia null → niente anche con cpu al 100%", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db, {
      alertThresholds: { cpuPct: null, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
    });
    await seedWindow(db, serverId, 8, { cpuPct: 100 });

    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c.events).toHaveLength(0);
  });

  it("memoria in percentuale oltre soglia → alert mem", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    // 95% > soglia 90.
    await seedWindow(db, serverId, 6, { memUsedBytes: 950, memTotalBytes: 1000 });

    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(conditionsOf(c.events)).toContain("mem");
  });

  it("disco in percentuale oltre soglia → alert disk", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    await seedWindow(db, serverId, 6, { diskUsedBytes: 950, diskTotalBytes: 1000 });

    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(conditionsOf(c.events)).toContain("disk");
  });

  it("rientro cpu → recovered e chiave rimossa", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    await seedWindow(db, serverId, 6, { cpuPct: 97 });

    const c1 = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c1.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect((await readActiveAlerts(db, serverId)).cpu).toBeDefined();

    // Sostituisci con campioni sotto soglia.
    await db.delete(serverMetrics).where(eq(serverMetrics.serverId, serverId));
    await seedWindow(db, serverId, 6, { cpuPct: 20 });

    const c2 = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c2.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c2.events).toHaveLength(1);
    expect(c2.events[0]!.kind).toBe("monitor.recovered");
    expect(conditionsOf(c2.events)).toEqual(["cpu"]);
    expect((await readActiveAlerts(db, serverId)).cpu).toBeUndefined();
  });

  it("alert cpu attivo + campioni radi nella finestra → NESSUN recovered, la chiave resta", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    await seedWindow(db, serverId, 6, { cpuPct: 97 });
    await evaluateMonitorAlertsOnce({ db, dispatch: collector().dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect((await readActiveAlerts(db, serverId)).cpu).toBeDefined();

    // Finestra con evidenza insufficiente: 2 campioni sotto soglia (< 50% dei
    // 10 attesi). Nessun recovered per pura assenza di dati.
    await db.delete(serverMetrics).where(eq(serverMetrics.serverId, serverId));
    await seedWindow(db, serverId, 2, { cpuPct: 20 });

    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c.events).toHaveLength(0);
    expect((await readActiveAlerts(db, serverId)).cpu).toBeDefined();
  });

  it("alert cpu attivo + soglia portata a null → chiave rimossa SENZA eventi", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    await seedWindow(db, serverId, 6, { cpuPct: 97 });
    await evaluateMonitorAlertsOnce({ db, dispatch: collector().dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect((await readActiveAlerts(db, serverId)).cpu).toBeDefined();

    // L'utente disattiva la soglia cpu mentre l'alert è attivo.
    await db
      .update(servers)
      .set({ alertThresholds: { cpuPct: null, memPct: 90, diskPct: 90, sustainedMinutes: 5 } })
      .where(eq(servers.id, serverId));

    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    // Nessun recovered (disattivare una soglia non è un rientro) e chiave pulita.
    expect(c.events).toHaveLength(0);
    expect((await readActiveAlerts(db, serverId)).cpu).toBeUndefined();
  });

  it("offline non valuta le soglie: un alert cpu attivo resta finché il server non torna online", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    await seedWindow(db, serverId, 6, { cpuPct: 97 });
    // Prima valutazione online: scatta l'alert cpu.
    await evaluateMonitorAlertsOnce({ db, dispatch: collector().dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect((await readActiveAlerts(db, serverId)).cpu).toBeDefined();

    // Ora il server va offline (nessun campione recente sopra soglia da valutare).
    await db
      .update(servers)
      .set({ lastSeenAt: new Date(NOW.getTime() - 4 * INTERVAL * 1000) })
      .where(eq(servers.id, serverId));
    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    // L'alert cpu NON viene risolto (non valutabile da offline); scatta offline.
    expect(conditionsOf(c.events)).toContain("offline");
    expect(c.events.map((e) => e.kind)).not.toContain("monitor.recovered");
    expect((await readActiveAlerts(db, serverId)).cpu).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Check down (contratto downNotifiedAt con B1)
// ---------------------------------------------------------------------------

describe("evaluateMonitorAlertsOnce — check down", () => {
  it("check down non notificato → alert check_down + downNotifiedAt scritto; poi anti-spam", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    const checkId = await seedCheck(db, serverId, {
      name: "api",
      lastStatus: "down",
      lastError: "connection refused",
      downNotifiedAt: null,
    });

    const c1 = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c1.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c1.events).toHaveLength(1);
    expect(c1.events[0]!.kind).toBe("monitor.alert");
    expect(conditionsOf(c1.events)).toEqual(["check_down"]);
    const [check1] = await db
      .select({ dn: serviceChecks.downNotifiedAt })
      .from(serviceChecks)
      .where(eq(serviceChecks.id, checkId));
    expect(check1!.dn).not.toBeNull();

    // Già notificato: niente.
    const c2 = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c2.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c2.events).toHaveLength(0);
  });

  it("check risalito con downNotifiedAt valorizzato → recovered + downNotifiedAt azzerato", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    const checkId = await seedCheck(db, serverId, {
      lastStatus: "up",
      downNotifiedAt: new Date(NOW.getTime() - 60_000),
    });

    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c.events).toHaveLength(1);
    expect(c.events[0]!.kind).toBe("monitor.recovered");
    expect(conditionsOf(c.events)).toEqual(["check_down"]);
    const [check] = await db
      .select({ dn: serviceChecks.downNotifiedAt })
      .from(serviceChecks)
      .where(eq(serviceChecks.id, checkId));
    expect(check!.dn).toBeNull();
  });

  it("check disabilitato e down → nessun alert", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db);
    await seedCheck(db, serverId, { enabled: false, lastStatus: "down", downNotifiedAt: null });
    const c = collector();
    await evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW);
    expect(c.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Robustezza
// ---------------------------------------------------------------------------

describe("evaluateMonitorAlertsOnce — robustezza", () => {
  it("un server con thresholds jsonb malformati non blocca gli altri e non lancia", async () => {
    const { db } = testDb;
    const badId = await seedServer(db, { name: "srv-bad" });
    // Sporca il jsonb con una stringa (non un oggetto).
    await db
      .update(servers)
      .set({ alertThresholds: sql`'"garbage"'::jsonb` as never })
      .where(eq(servers.id, badId));
    // Server sano, offline: deve comunque essere notificato.
    const goodId = await seedServer(db, {
      name: "srv-good",
      lastSeenAt: new Date(NOW.getTime() - 4 * INTERVAL * 1000),
    });

    const c = collector();
    await expect(
      evaluateMonitorAlertsOnce({ db, dispatch: c.dispatch, publicUrl: PUBLIC_URL }, NOW),
    ).resolves.toBeUndefined();
    const offline = c.events.filter(isMonitor).find((e) => e.condition === "offline");
    expect(offline).toBeDefined();
    expect(offline!.serverName).toBe("srv-good");
    expect(offline!.url).toBe(`${PUBLIC_URL}/monitor/servers/${goodId}`);
  });

  it("un dispatch che lancia non propaga e lo stato anti-spam risulta comunque persistito", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db, {
      lastSeenAt: new Date(NOW.getTime() - 4 * INTERVAL * 1000),
    });
    const throwing = async (): Promise<void> => {
      throw new Error("boom");
    };
    await expect(
      evaluateMonitorAlertsOnce({ db, dispatch: throwing, publicUrl: PUBLIC_URL }, NOW),
    ).resolves.toBeUndefined();
    // Persist-before-notify: activeAlerts è scritto PRIMA del dispatch, quindi
    // anche con la notifica fallita l'anti-spam riflette realtà committata
    // (meglio una notifica persa di un doppio alert).
    expect((await readActiveAlerts(db, serverId)).offline).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

describe("startMonitorAlertPoller", () => {
  it("con intervalMinutes <= 0 non avvia nulla", () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const stop = startMonitorAlertPoller({
        db: testDb.db,
        publicUrl: PUBLIC_URL,
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

  it("valuta a ogni tick e si ferma sull'abort", async () => {
    const { db } = testDb;
    const serverId = await seedServer(db, {
      lastSeenAt: new Date(Date.now() - 10 * 60_000), // offline abbondante
    });
    const c = collector();
    const controller = new AbortController();
    const stop = startMonitorAlertPoller({
      db,
      dispatch: c.dispatch,
      publicUrl: PUBLIC_URL,
      intervalMinutes: 0.001,
      signal: controller.signal,
    });
    try {
      await vi.waitFor(
        () => {
          expect(conditionsOf(c.events)).toContain("offline");
        },
        { timeout: 5000, interval: 50 },
      );
      const alerts = await readActiveAlerts(db, serverId);
      expect(alerts.offline).toBeDefined();
    } finally {
      controller.abort();
      stop();
    }
  });
});
