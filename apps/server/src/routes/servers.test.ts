import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { checkSamples, serverMetrics, serverProjects, servers, serviceChecks } from "@stubwise/db";
import { eq } from "drizzle-orm";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    monitorRateLimit: { max: 10_000, timeWindow: "1 minute" },
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function createServer(payload: Record<string, unknown>, cookie = adminCookie) {
  return app.inject({
    method: "POST",
    url: "/api/servers",
    headers: { cookie },
    payload,
  });
}

/** Crea un server via API e restituisce id + chiave in chiaro. */
async function createServerReturning(
  name: string,
): Promise<{ id: string; key: string }> {
  const res = await createServer({ name });
  if (res.statusCode !== 201) throw new Error(`create server fallito: ${res.statusCode} ${res.body}`);
  const body = res.json() as { id: string; key: string };
  return { id: body.id, key: body.key };
}

describe("POST /api/servers", () => {
  it("l'admin crea un server: 201 con la chiave in chiaro (sk_… + 48 hex) UNA volta", async () => {
    const res = await createServer({ name: "web-01" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.id).toEqual(expect.any(String));
    expect(body.name).toBe("web-01");
    expect(body.key).toEqual(expect.stringMatching(/^sk_[0-9a-f]{48}$/));
    // Lo stato di un server appena creato: mai connesso.
    expect(body.status).toBe("never_connected");
    // La chiave non è mai persistita in chiaro: in DB c'è solo key_hash.
    const [row] = await testDb.db
      .select()
      .from(servers)
      .where(eq(servers.id, body.id as string));
    expect(row).toBeDefined();
    expect(row!.keyHash).toEqual(expect.any(String));
    expect(row!.keyHash).not.toBe(body.key);
    expect(JSON.stringify(row)).not.toContain(body.key as string);
  });

  it("un member non può creare server: 403", async () => {
    const res = await createServer({ name: "negato" }, memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/servers", payload: { name: "X" } });
    expect(res.statusCode).toBe(401);
  });

  it("body non valido (name mancante): 400", async () => {
    const res = await createServer({});
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/servers", () => {
  it("elenca i server con stato calcolato, progetti, conteggio check e recentCpu; mai la chiave", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const projectName = "Progetto di test";

    // never_connected: last_seen_at null.
    const { id: neverId } = await createServerReturning("mai-visto");

    // online: last_seen_at recente.
    const { id: onlineId } = await createServerReturning("online-01");
    await testDb.db
      .update(servers)
      .set({ lastSeenAt: new Date(), sampleIntervalSeconds: 30 })
      .where(eq(servers.id, onlineId));
    // Associa il server online al progetto.
    await app.inject({
      method: "PATCH",
      url: `/api/servers/${onlineId}`,
      headers: { cookie: adminCookie },
      payload: { projectIds: [projectId] },
    });
    // Campioni fini: 25 valori cpu (ne devono tornare gli ultimi 20, dal più vecchio).
    const base = Date.now() - 25 * 30_000;
    const cpuRows = Array.from({ length: 25 }, (_, i) => ({
      serverId: onlineId,
      ts: new Date(base + i * 30_000),
      cpuPct: i,
      load1m: 0.5,
      memUsedBytes: 100,
      memTotalBytes: 1000,
      swapUsedBytes: 0,
      diskUsedBytes: 100,
      diskTotalBytes: 1000,
      netRxBytes: 0,
      netTxBytes: 0,
    }));
    await testDb.db.insert(serverMetrics).values(cpuRows);
    // Due check: uno up (enabled), uno down (enabled), uno up ma disabilitato.
    await testDb.db.insert(serviceChecks).values([
      { serverId: onlineId, type: "http", name: "up-1", target: "http://x", lastStatus: "up" },
      { serverId: onlineId, type: "tcp", name: "down-1", target: "x:1", lastStatus: "down" },
      {
        serverId: onlineId,
        type: "http",
        name: "disabled-up",
        target: "http://y",
        lastStatus: "up",
        enabled: false,
      },
    ]);

    // offline: last_seen_at oltre 3× l'intervallo.
    const { id: offlineId } = await createServerReturning("offline-01");
    await testDb.db
      .update(servers)
      .set({ lastSeenAt: new Date(Date.now() - 3 * 30_000 - 1000), sampleIntervalSeconds: 30 })
      .where(eq(servers.id, offlineId));

    const res = await app.inject({ method: "GET", url: "/api/servers", headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, unknown>>;
    // Nessun campo chiave in NESSUNA riga.
    expect(JSON.stringify(list)).not.toContain("sk_");
    for (const s of list) {
      expect(s).not.toHaveProperty("key");
      expect(s).not.toHaveProperty("keyHash");
    }

    const never = list.find((s) => s.id === neverId)!;
    expect(never.status).toBe("never_connected");

    const online = list.find((s) => s.id === onlineId)!;
    expect(online.status).toBe("online");
    expect(online.projects).toEqual([{ id: projectId, name: projectName }]);
    expect(online.checksUp).toBe(1);
    expect(online.checksDown).toBe(1);
    // recentCpu: ultimi 20, dal più vecchio (5) al più recente (24).
    expect(online.recentCpu).toEqual(Array.from({ length: 20 }, (_, i) => i + 5));

    const offline = list.find((s) => s.id === offlineId)!;
    expect(offline.status).toBe("offline");
    expect(offline.recentCpu).toEqual([]);
    expect(offline.projects).toEqual([]);
  });

  it("filtro ?projectId= restituisce solo i server associati a quel progetto", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const { id: assocId } = await createServerReturning("assoc");
    await createServerReturning("non-assoc");
    await app.inject({
      method: "PATCH",
      url: `/api/servers/${assocId}`,
      headers: { cookie: adminCookie },
      payload: { projectIds: [projectId] },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/servers?projectId=${projectId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string }>;
    expect(list.map((s) => s.id)).toEqual([assocId]);
  });

  it("filtro ?projectId= su un server multi-progetto: la risposta porta ENTRAMBI i progetti", async () => {
    const { projectId: p1 } = await seedRepository(testDb.db);
    const { projectId: p2 } = await seedRepository(testDb.db);
    const { id } = await createServerReturning("multi-progetto");
    await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
      payload: { projectIds: [p1, p2] },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/servers?projectId=${p1}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; projects: { id: string }[] }>;
    expect(list.map((s) => s.id)).toEqual([id]);
    // Il filtro seleziona i server, non taglia le associazioni: i progetti
    // restano tutti.
    expect(list[0]!.projects.map((p) => p.id).sort()).toEqual([p1, p2].sort());
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/servers" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/servers/:id", () => {
  it("dettaglio con gli stessi campi della lista", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const { id } = await createServerReturning("dettaglio");
    await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
      payload: { projectIds: [projectId] },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.id).toBe(id);
    expect(body.status).toBe("never_connected");
    expect(body.projects).toEqual([{ id: projectId, name: "Progetto di test" }]);
    expect(body.recentCpu).toEqual([]);
    expect(body.checksUp).toBe(0);
    expect(body.checksDown).toBe(0);
    expect(body).not.toHaveProperty("key");
    expect(body).not.toHaveProperty("keyHash");
  });

  it("con campioni: services/disks/metricsAt dall'ULTIMO campione", async () => {
    const { id } = await createServerReturning("dettaglio-servizi");
    const oldTs = new Date(Date.now() - 60_000);
    const newTs = new Date();
    const baseSample = {
      serverId: id,
      cpuPct: 10,
      load1m: 0.5,
      memUsedBytes: 100,
      memTotalBytes: 1000,
      swapUsedBytes: 0,
      diskUsedBytes: 100,
      diskTotalBytes: 1000,
      netRxBytes: 0,
      netTxBytes: 0,
    };
    const newServices = [
      {
        source: "docker" as const,
        name: "caddy",
        state: "running",
        cpuPct: 1.5,
        memBytes: 1024,
        restarts: null,
      },
    ];
    const newDisks = [{ mount: "/", usedBytes: 100, totalBytes: 1000 }];
    await testDb.db.insert(serverMetrics).values([
      {
        ...baseSample,
        ts: oldTs,
        services: [
          {
            source: "pm2" as const,
            name: "vecchio",
            state: "online",
            cpuPct: 9,
            memBytes: 1,
            restarts: 0,
          },
        ],
        disks: [{ mount: "/vecchio", usedBytes: 1, totalBytes: 2 }],
      },
      { ...baseSample, ts: newTs, services: newServices, disks: newDisks },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.services).toEqual(newServices);
    expect(body.disks).toEqual(newDisks);
    expect(body.metricsAt).toBe(newTs.toISOString());
  });

  it("senza campioni: services/disks vuoti e metricsAt null", async () => {
    const { id } = await createServerReturning("dettaglio-senza-campioni");
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.services).toEqual([]);
    expect(body.disks).toEqual([]);
    expect(body.metricsAt).toBeNull();
  });

  it("server inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/servers/00000000-0000-0000-0000-000000000000",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/servers/:id", () => {
  it("aggiorna name, sampleIntervalSeconds e alertThresholds", async () => {
    const { id } = await createServerReturning("da-aggiornare");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
      payload: {
        name: "aggiornato",
        sampleIntervalSeconds: 60,
        alertThresholds: { cpuPct: 80, memPct: 85, diskPct: 88, sustainedMinutes: 10 },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.name).toBe("aggiornato");
    expect(body.sampleIntervalSeconds).toBe(60);
    expect(body.alertThresholds).toEqual({
      cpuPct: 80,
      memPct: 85,
      diskPct: 88,
      sustainedMinutes: 10,
    });
    expect(body).not.toHaveProperty("keyHash");
  });

  it("projectIds sincronizza server_projects (replace completo)", async () => {
    const { projectId: p1 } = await seedRepository(testDb.db);
    const { projectId: p2 } = await seedRepository(testDb.db);
    const { id } = await createServerReturning("sync-progetti");

    // Prima associazione: [p1].
    await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
      payload: { projectIds: [p1] },
    });
    let res = await app.inject({ method: "GET", url: `/api/servers/${id}`, headers: { cookie: adminCookie } });
    expect((res.json() as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual([p1]);

    // Replace: [p2].
    await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
      payload: { projectIds: [p2] },
    });
    res = await app.inject({ method: "GET", url: `/api/servers/${id}`, headers: { cookie: adminCookie } });
    expect((res.json() as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual([p2]);

    // projectIds omesso: NON tocca le associazioni.
    await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
      payload: { name: "solo-nome" },
    });
    res = await app.inject({ method: "GET", url: `/api/servers/${id}`, headers: { cookie: adminCookie } });
    expect((res.json() as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual([p2]);

    // projectIds vuoto: azzera.
    await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
      payload: { projectIds: [] },
    });
    res = await app.inject({ method: "GET", url: `/api/servers/${id}`, headers: { cookie: adminCookie } });
    expect((res.json() as { projects: unknown[] }).projects).toEqual([]);
  });

  it("projectIds con duplicati: 200 e una sola riga di associazione", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const { id } = await createServerReturning("dedup-progetti");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
      payload: { projectIds: [projectId, projectId] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual([
      projectId,
    ]);
    const links = await testDb.db
      .select()
      .from(serverProjects)
      .where(eq(serverProjects.serverId, id));
    expect(links).toHaveLength(1);
  });

  it("atomicità: name valido + projectId inesistente → 422 e name invariato in DB", async () => {
    const { id } = await createServerReturning("atomico");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
      payload: {
        name: "non-deve-applicarsi",
        projectIds: ["00000000-0000-0000-0000-000000000000"],
      },
    });
    expect(res.statusCode).toBe(422);
    const [row] = await testDb.db.select().from(servers).where(eq(servers.id, id));
    expect(row!.name).toBe("atomico");
  });

  it("projectId inesistente: 422", async () => {
    const { id } = await createServerReturning("progetto-ko");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
      payload: { projectIds: ["00000000-0000-0000-0000-000000000000"] },
    });
    expect(res.statusCode).toBe(422);
  });

  it("un member non può aggiornare: 403", async () => {
    const { id } = await createServerReturning("protetto");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: memberCookie },
      payload: { name: "hack" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("server inesistente: 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/servers/00000000-0000-0000-0000-000000000000",
      headers: { cookie: adminCookie },
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/servers/:id/regenerate-key", () => {
  it("nuova chiave in risposta, hash aggiornato; la vecchia non autentica più", async () => {
    const { id, key: oldKey } = await createServerReturning("rigenera");

    // La vecchia chiave autentica su /monitor/config.
    const before = await app.inject({
      method: "GET",
      url: "/monitor/config",
      headers: { "x-stubwise-server-key": oldKey },
    });
    expect(before.statusCode).toBe(200);

    const [oldRow] = await testDb.db.select().from(servers).where(eq(servers.id, id));

    const res = await app.inject({
      method: "POST",
      url: `/api/servers/${id}/regenerate-key`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { key: string };
    expect(body.key).toEqual(expect.stringMatching(/^sk_[0-9a-f]{48}$/));
    expect(body.key).not.toBe(oldKey);

    // Hash aggiornato in DB.
    const [newRow] = await testDb.db.select().from(servers).where(eq(servers.id, id));
    expect(newRow!.keyHash).not.toBe(oldRow!.keyHash);

    // La vecchia chiave non autentica più.
    const afterOld = await app.inject({
      method: "GET",
      url: "/monitor/config",
      headers: { "x-stubwise-server-key": oldKey },
    });
    expect(afterOld.statusCode).toBe(401);

    // La nuova sì.
    const afterNew = await app.inject({
      method: "GET",
      url: "/monitor/config",
      headers: { "x-stubwise-server-key": body.key },
    });
    expect(afterNew.statusCode).toBe(200);
  });

  it("un member non può rigenerare: 403", async () => {
    const { id } = await createServerReturning("rigen-protetto");
    const res = await app.inject({
      method: "POST",
      url: `/api/servers/${id}/regenerate-key`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("server inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/servers/00000000-0000-0000-0000-000000000000/regenerate-key",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/servers/:id", () => {
  it("elimina il server: 204 con cascade su metrics e checks", async () => {
    const { id } = await createServerReturning("da-eliminare");
    await testDb.db.insert(serverMetrics).values({
      serverId: id,
      ts: new Date(),
      cpuPct: 1,
      load1m: 0.1,
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
      .values({ serverId: id, type: "http", name: "c", target: "http://x" })
      .returning({ id: serviceChecks.id });
    await testDb.db.insert(checkSamples).values({
      checkId: check!.id,
      ts: new Date(),
      status: "up",
      latencyMs: 5,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);

    const metrics = await testDb.db.select().from(serverMetrics).where(eq(serverMetrics.serverId, id));
    expect(metrics).toHaveLength(0);
    const checks = await testDb.db.select().from(serviceChecks).where(eq(serviceChecks.serverId, id));
    expect(checks).toHaveLength(0);
    const samples = await testDb.db
      .select()
      .from(checkSamples)
      .where(eq(checkSamples.checkId, check!.id));
    expect(samples).toHaveLength(0);

    // Un secondo delete è 404.
    const again = await app.inject({
      method: "DELETE",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(again.statusCode).toBe(404);
  });

  it("un member non può eliminare: 403", async () => {
    const { id } = await createServerReturning("del-protetto");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/servers/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
