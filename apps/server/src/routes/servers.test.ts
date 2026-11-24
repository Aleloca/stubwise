import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { checkSamples, environmentServers, projectEnvironments, projects, repositories, roles, serverEpisodes, serverMetrics, serverProjects, servers, serviceChecks, users } from "@stubwise/db";
import type { ServerDetail, ServerView } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedRepositoryInProject, startTestDb } from "@stubwise/db/testing";
import { addMember, createUserWithPat, seedUsers } from "../test/fixtures.js";

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

/**
 * Area 8, F4a: un server si lega a un progetto dagli AMBIENTI (per
 * repository). Un ambiente `production` del progetto, una repository (la
 * prima del progetto se non data).
 */
async function linkToProject(serverId: string, projectId: string, repositoryId?: string): Promise<void> {
  const repo = repositoryId ?? (await testDb.db.select({ id: repositories.id }).from(repositories).where(eq(repositories.projectId, projectId)))[0]!.id;
  const [env] = await testDb.db.insert(projectEnvironments).values({ projectId, name: `env-${Math.random()}`, kind: "staging" }).returning();
  await testDb.db.insert(environmentServers).values({ environmentId: env!.id, repositoryId: repo, serverId });
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

describe("⌘K (rimandi, lotto 5): la ricerca dei server", () => {
  it("per codice, nome o hostname, fra i server che chi cerca vede, col progetto da cui aprirlo; sotto i 2 caratteri niente", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const { projectId } = await seedRepository(testDb.db);
    // Il progetto del server NON è il primo visibile (per codice): così «da dove si apre» si vede.
    const code = `Z${tag.toUpperCase()}`;
    await testDb.db.update(projects).set({ code }).where(eq(projects.id, projectId));
    const { projectId: earlier } = await seedRepository(testDb.db);
    await testDb.db.update(projects).set({ code: `A${tag.toUpperCase()}` }).where(eq(projects.id, earlier));
    const seen = await createServerReturning(`cerca-${tag}-visto`);
    const hidden = await createServerReturning(`cerca-${tag}-nascosto`);
    await testDb.db.update(servers).set({ hostname: `db-${tag}.interno` }).where(eq(servers.id, seen.id));
    await linkToProject(seen.id, projectId);
    const member = await createUserWithPat(app, `cerca-${tag}@acme.com`);
    await addMember(app, projectId, member.id, "developer");
    await addMember(app, earlier, member.id, "developer");
    const search = async (headers: Record<string, string>, q: string) =>
      ((await app.inject({ method: "GET", url: `/api/servers/search?q=${encodeURIComponent(q)}`, headers })).json() as { items: { code: string; name: string; projectCode: string }[] }).items;
    const [{ number }] = (await testDb.db.select({ number: servers.number }).from(servers).where(eq(servers.id, seen.id))) as [{ number: number }];
    expect(await search(member.headers, `cerca-${tag}`)).toEqual([{ code: `SRV-${number}`, name: `cerca-${tag}-visto`, projectCode: code }]);
    expect((await search(member.headers, `db-${tag}`)).map((r) => r.name)).toEqual([`cerca-${tag}-visto`]);
    expect((await search(member.headers, `srv-${number}`)).map((r) => r.code)).toContain(`SRV-${number}`);
    expect(await search(member.headers, "c")).toEqual([]);
    // Chi vede tutti (il full admin): anche il server senza ambienti, aperto dal primo progetto visibile.
    const forAdmin = await search({ cookie: adminCookie }, `cerca-${tag}`);
    expect(forAdmin.map((r) => r.name).sort()).toEqual([`cerca-${tag}-nascosto`, `cerca-${tag}-visto`]);
    expect(forAdmin.find((r) => r.name.endsWith("visto"))!.projectCode).toBe(code);
    void hidden;
  });
});

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
    await linkToProject(onlineId, projectId);
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

    const res = await app.inject({ method: "GET", url: "/api/servers", headers: { cookie: adminCookie } });
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
    await linkToProject(assocId, projectId);
    const res = await app.inject({
      method: "GET",
      url: `/api/servers?projectId=${projectId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string }>;
    expect(list.map((s) => s.id)).toEqual([assocId]);
  });

  it("filtro ?projectId= su un server multi-progetto: la risposta porta ENTRAMBI i progetti", async () => {
    const { projectId: p1 } = await seedRepository(testDb.db);
    const { projectId: p2 } = await seedRepository(testDb.db);
    const { id } = await createServerReturning("multi-progetto");
    await linkToProject(id, p1);
    await linkToProject(id, p2);
    const res = await app.inject({
      method: "GET",
      url: `/api/servers?projectId=${p1}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; projects: { id: string }[] }>;
    expect(list.map((s) => s.id)).toEqual([id]);
    // Il filtro seleziona i server, non taglia le associazioni: i progetti
    // (dei suoi ambienti) restano tutti.
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
    await linkToProject(id, projectId);
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
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
      headers: { cookie: adminCookie },
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
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.services).toEqual([]);
    expect(body.disks).toEqual([]);
    expect(body.metricsAt).toBeNull();
  });

  // 23 set 2026 (hub di progetto, tappa 3): la memoria è un campo AGGIUNTO
  // al dettaglio. I due test qui sotto sono nuovi; quelli sopra sono rimasti
  // come erano, ed è la prova che nessuna forma preesistente è cambiata.
  it("memoria dall'ULTIMO campione, non da uno qualunque", async () => {
    const { id } = await createServerReturning("dettaglio-memoria");
    const baseSample = {
      serverId: id,
      cpuPct: 10,
      load1m: 0.5,
      swapUsedBytes: 0,
      diskUsedBytes: 100,
      diskTotalBytes: 1000,
      netRxBytes: 0,
      netTxBytes: 0,
    };
    await testDb.db.insert(serverMetrics).values([
      { ...baseSample, ts: new Date(Date.now() - 60_000), memUsedBytes: 1, memTotalBytes: 2 },
      { ...baseSample, ts: new Date(), memUsedBytes: 3_000, memTotalBytes: 8_000 },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.memUsedBytes).toBe(3_000);
    expect(body.memTotalBytes).toBe(8_000);
  });

  it("memoria senza campioni: null, mai 0", async () => {
    const { id } = await createServerReturning("dettaglio-memoria-vuota");
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
    });
    const body = res.json() as Record<string, unknown>;
    expect(body.memUsedBytes).toBeNull();
    expect(body.memTotalBytes).toBeNull();
  });

  it("server inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/servers/00000000-0000-0000-0000-000000000000",
      headers: { cookie: adminCookie },
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

  it("area 8, F4a-4 = b: `projectIds` si accetta (un web in cache) ma si IGNORA: nessun legame, i progetti vengono dagli ambienti", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const { projectId: other } = await seedRepository(testDb.db);
    const { id } = await createServerReturning("progetti-dagli-ambienti");
    await linkToProject(id, projectId, repositoryId);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/servers/${id}`,
      headers: { cookie: adminCookie },
      payload: { name: "rinominato", projectIds: [other, "00000000-0000-0000-0000-000000000000"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "rinominato", projects: [{ id: projectId }] });
    expect(await testDb.db.select().from(serverProjects).where(eq(serverProjects.serverId, id))).toEqual([]);
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

// Area 8, F4a, S2: la vista nella forma del prototipo. Gli ambienti e i
// progetti di un server sono SOLO quelli dei progetti che chi guarda vede;
// salute, codice, episodi e permessi li calcola il server.
describe("area 8, F4a, S2: la proiezione per l'app", () => {
  async function lead(projectId: string) {
    const u = await createUserWithPat(app, `l-${Math.random().toString(16).slice(2, 8)}@acme.com`);
    await addMember(app, projectId, u.id, "project_lead");
    return u;
  }

  it("riga: SRV-n, salute, ambienti e progetti dei SOLI progetti visibili; orfano se nessun ambiente", async () => {
    const { projectId: pA, repositoryId: rA } = await seedRepository(testDb.db);
    const { projectId: pB, repositoryId: rB } = await seedRepository(testDb.db);
    const { id } = await createServerReturning("condiviso");
    await linkToProject(id, pA, rA);
    await linkToProject(id, pB, rB);
    const { id: orphanId } = await createServerReturning("orfano");
    const u = await lead(pA);
    const rows = (await app.inject({ method: "GET", url: "/api/servers", headers: u.headers })).json() as ServerView[];
    const row = rows.find((r) => r.id === id)!;
    const [db] = await testDb.db.select({ number: servers.number }).from(servers).where(eq(servers.id, id));
    expect(row).toMatchObject({ code: `SRV-${db!.number}`, work: "none", orphan: false, health: { health: "never_connected", since: null, reasons: [] } });
    expect(row.environments.map((e) => e.projectId)).toEqual([pA]);
    expect(row.environments[0]).toMatchObject({ kind: "staging", repositoryId: rA });
    expect(row.projects.map((p) => p.id)).toEqual([pA]);
    expect(rows.some((r) => r.id === orphanId)).toBe(false);
    const asAdmin = (await app.inject({ method: "GET", url: "/api/servers", headers: { cookie: adminCookie } })).json() as ServerView[];
    expect(asAdmin.find((r) => r.id === orphanId)).toMatchObject({ orphan: true, environments: [] });
    expect(asAdmin.find((r) => r.id === id)!.environments.map((e) => e.projectId).sort()).toEqual([pA, pB].sort());
  });

  it("dettaglio: controlli, episodi dal più recente, la salute da un episodio aperto, le produzioni visibili, canManage dal server", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const { id } = await createServerReturning("dettaglio-f4a");
    await testDb.db.update(servers).set({ lastSeenAt: new Date(), sampleIntervalSeconds: 30 }).where(eq(servers.id, id));
    const [env] = await testDb.db.insert(projectEnvironments).values({ projectId, name: "produzione", kind: "production" }).returning();
    await testDb.db.insert(environmentServers).values({ environmentId: env!.id, repositoryId, serverId: id });
    await testDb.db.insert(serviceChecks).values({ serverId: id, type: "http", name: "home", target: "https://x", lastStatus: "down" });
    const old = new Date(Date.now() - 48 * 3_600_000);
    await testDb.db.insert(serverEpisodes).values([
      { serverId: id, severity: "down", reasons: [{ kind: "agent_silent" }], startedAt: old, recoveredAt: new Date(old.getTime() + 600_000) },
      { serverId: id, severity: "trouble", reasons: [{ kind: "cpu", valuePct: 97, thresholdPct: 95 }], startedAt: new Date(Date.now() - 600_000) },
    ]);
    const u = await lead(projectId);
    const d = (await app.inject({ method: "GET", url: `/api/servers/${id}`, headers: u.headers })).json() as ServerDetail;
    expect(d.checks.map((c) => c.name)).toEqual(["home"]);
    expect(JSON.stringify(d.checks)).not.toContain("dsnEncrypted");
    expect(d.episodes.map((e) => e.severity)).toEqual(["trouble", "down"]);
    expect(d.episodes[0]!.recoveredAt).toBeNull();
    expect(d.health).toMatchObject({ health: "trouble", reasons: [{ kind: "cpu" }] });
    expect(d.productionProjects).toEqual([{ id: projectId, code: expect.any(String), name: "Progetto di test" }]);
    expect(d.canManage).toBe(false);
    const asAdmin = (await app.inject({ method: "GET", url: `/api/servers/${id}`, headers: { cookie: adminCookie } })).json() as ServerDetail;
    expect(asAdmin.canManage).toBe(true);
  });

  it("per codice: SRV-n → il dettaglio; invisibile, inesistente o storto → 404", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const { projectId: other } = await seedRepository(testDb.db);
    const { id } = await createServerReturning("per-codice");
    await linkToProject(id, projectId, repositoryId);
    const [db] = await testDb.db.select({ number: servers.number }).from(servers).where(eq(servers.id, id));
    const u = await lead(projectId);
    const stranger = await lead(other);
    const byCode = (headers: Record<string, string>, code: string) => app.inject({ method: "GET", url: `/api/servers/by-code/${code}`, headers });
    const ok = await byCode(u.headers, `SRV-${db!.number}`);
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as ServerDetail).id).toBe(id);
    expect((await byCode(u.headers, `srv-${db!.number}`)).statusCode).toBe(200);
    expect((await byCode(stranger.headers, `SRV-${db!.number}`)).statusCode).toBe(404);
    expect((await byCode(u.headers, "SRV-999999")).statusCode).toBe(404);
    expect((await byCode(u.headers, "storto")).statusCode).toBe(404);
  });
});

// Area 8, F4a, S4: crea un server già in un ambiente, in UNA transazione
// (monitor.manage più environments.manage in quel progetto); la risposta con
// la chiave porta l'URL dell'istanza per il comando d'installazione.
describe("area 8, F4a, S4: crea con un ambiente", () => {
  async function monitorManager(projectId?: string, preset = "project_lead") {
    const u = await createUserWithPat(app, `m-${Math.random().toString(16).slice(2, 8)}@acme.com`);
    const [role] = await testDb.db.insert(roles).values({ name: `mon-${Math.random()}`, scope: "instance", permissions: ["monitor.manage"] }).returning();
    await testDb.db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, u.id));
    if (projectId) await addMember(app, projectId, u.id, preset);
    return u;
  }
  const count = async () => (await testDb.db.select({ id: servers.id }).from(servers)).length;

  it("con environments.manage: il server nasce già nell'ambiente (per le repository date), con la chiave e l'ingestUrl", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const [env] = await testDb.db.insert(projectEnvironments).values({ projectId, name: "produzione", kind: "production" }).returning();
    const u = await monitorManager(projectId);
    const res = await app.inject({ method: "POST", url: "/api/servers", headers: u.headers, payload: { name: "nuovo", environment: { environmentId: env!.id, repositoryIds: [repositoryId] } } });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { id: string; key: string; ingestUrl: string; code: string; environments: { environmentId: string }[] };
    expect(body.key).toMatch(/^sk_/);
    expect(body.ingestUrl).toBe("https://stubwise.example.com");
    expect(body.code).toMatch(/^SRV-\d+$/);
    expect(body.environments.map((e) => e.environmentId)).toEqual([env!.id]);
    const links = await testDb.db.select().from(environmentServers).where(eq(environmentServers.serverId, body.id));
    expect(links).toEqual([expect.objectContaining({ environmentId: env!.id, repositoryId, serverId: body.id })]);
  });

  it("senza environments.manage in quel progetto: 403; progetto invisibile o ambiente inesistente: 404; repository di un altro progetto: 400 — sempre nessun server", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const { repositoryId: foreignRepo } = await seedRepository(testDb.db);
    const [env] = await testDb.db.insert(projectEnvironments).values({ projectId, name: "staging", kind: "staging" }).returning();
    const outsider = await monitorManager();
    const contributor = await monitorManager(projectId, "contributor");
    const before = await count();
    const post = (headers: Record<string, string>, environment: object) => app.inject({ method: "POST", url: "/api/servers", headers, payload: { name: "x", environment } });
    expect((await post(contributor.headers, { environmentId: env!.id, repositoryIds: [repositoryId] })).statusCode).toBe(403);
    expect((await post(outsider.headers, { environmentId: env!.id, repositoryIds: [repositoryId] })).statusCode).toBe(404);
    expect((await post({ cookie: adminCookie }, { environmentId: "00000000-0000-4000-8000-000000000000", repositoryIds: [repositoryId] })).statusCode).toBe(404);
    expect((await post({ cookie: adminCookie }, { environmentId: env!.id, repositoryIds: [foreignRepo] })).statusCode).toBe(400);
    expect(await count()).toBe(before);
  });

  it("senza repositoryIds: TUTTE le repository del progetto, e l'ambiente intero (`serverId`), come il form degli ambienti", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const [env] = await testDb.db.insert(projectEnvironments).values({ projectId, name: "tutto", kind: "staging" }).returning();
    const res = await app.inject({ method: "POST", url: "/api/servers", headers: { cookie: adminCookie }, payload: { name: "intero", environment: { environmentId: env!.id } } });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { id: string }).id;
    expect(await testDb.db.select().from(environmentServers).where(eq(environmentServers.serverId, id))).toEqual([
      expect.objectContaining({ environmentId: env!.id, repositoryId, serverId: id }),
    ]);
    const [after] = await testDb.db.select({ serverId: projectEnvironments.serverId }).from(projectEnvironments).where(eq(projectEnvironments.id, env!.id));
    expect(after!.serverId).toBe(id);
  });

  it("review F4a (renderer): per tutto il progetto, le eccezioni per repository VINCONO (restano dove sono)", async () => {
    const { projectId, repositoryId: a } = await seedRepository(testDb.db);
    const b = await seedRepositoryInProject(testDb.db, projectId);
    const c = await seedRepositoryInProject(testDb.db, projectId);
    const [env] = await testDb.db.insert(projectEnvironments).values({ projectId, name: "eccezioni", kind: "staging" }).returning();
    const { id: srv2 } = await createServerReturning("srv-a");
    const { id: srv3 } = await createServerReturning("srv-b");
    await testDb.db.insert(environmentServers).values([
      { environmentId: env!.id, repositoryId: a, serverId: srv2 },
      { environmentId: env!.id, repositoryId: b, serverId: srv3 },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/servers", headers: { cookie: adminCookie }, payload: { name: "srv-tutti", environment: { environmentId: env!.id } } });
    expect(res.statusCode, res.body).toBe(201);
    const srv7 = (res.json() as { id: string }).id;
    const rows = await testDb.db.select().from(environmentServers).where(eq(environmentServers.environmentId, env!.id));
    expect(Object.fromEntries(rows.map((r) => [r.repositoryId, r.serverId]))).toEqual({ [a]: srv2, [b]: srv3, [c]: srv7 });
    const [after] = await testDb.db.select({ serverId: projectEnvironments.serverId }).from(projectEnvironments).where(eq(projectEnvironments.id, env!.id));
    expect(after!.serverId).toBe(srv7);
  });

  it("rigenerare la chiave porta anche l'ingestUrl", async () => {
    const { id } = await createServerReturning("rigenera-url");
    const res = await app.inject({ method: "POST", url: `/api/servers/${id}/regenerate-key`, headers: { cookie: adminCookie } });
    expect(res.json()).toMatchObject({ key: expect.stringMatching(/^sk_/), ingestUrl: "https://stubwise.example.com" });
  });
});

// Review F4a, I1: `?projectId=` di un progetto invisibile risponde come un
// progetto che non esiste, anche a chi ha monitor.view.
describe("review F4a: ?projectId= di un progetto invisibile", () => {
  it("monitor.view senza essere membro di P: 404, nessun server di P", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const { id } = await createServerReturning("di-p");
    await linkToProject(id, projectId, repositoryId);
    const u = await createUserWithPat(app, `v-${Math.random().toString(16).slice(2, 8)}@acme.com`);
    const [role] = await testDb.db.insert(roles).values({ name: `view-${Math.random()}`, scope: "instance", permissions: ["monitor.view"] }).returning();
    await testDb.db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, u.id));
    const res = await app.inject({ method: "GET", url: `/api/servers?projectId=${projectId}`, headers: u.headers });
    expect(res.statusCode).toBe(404);
    // Senza filtro il server lo vede (monitor.view), ma senza gli ambienti di P.
    const all = (await app.inject({ method: "GET", url: "/api/servers", headers: u.headers })).json() as ServerView[];
    expect(all.find((s) => s.id === id)).toMatchObject({ environments: [], projects: [] });
  });
});

// Area 8, F4b, S2: la chiave pubblica d'istanza per il comando
// d'installazione con le operazioni (monitor.manage). Mai la privata.
describe("area 8, F4b: GET /api/servers/command-key", () => {
  it("monitor.manage: la pubblica (sempre la stessa), mai la privata; senza permesso 403", async () => {
    const a = await app.inject({ method: "GET", url: "/api/servers/command-key", headers: { cookie: adminCookie } });
    expect(a.statusCode, a.body).toBe(200);
    const { publicKey } = a.json() as { publicKey: string };
    expect(publicKey).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    expect(a.body).not.toContain("PRIVATE");
    const b = await app.inject({ method: "GET", url: "/api/servers/command-key", headers: { cookie: adminCookie } });
    expect((b.json() as { publicKey: string }).publicKey).toBe(publicKey);
    expect((await app.inject({ method: "GET", url: "/api/servers/command-key", headers: { cookie: memberCookie } })).statusCode).toBe(403);
  });
});
