import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import {
  checkSamples,
  checkSamplesRollup,
  decrypt,
  serverMetrics,
  serverMetricsRollup,
  serviceChecks,
} from "@stubwise/db";
import { eq, sql } from "drizzle-orm";
import { METRICS_POINT_LIMIT } from "./servers-checks.js";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
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

/** Crea un server via API e restituisce id + chiave in chiaro. */
async function createServerReturning(name: string): Promise<{ id: string; key: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/servers",
    headers: { cookie: adminCookie },
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`create server fallito: ${res.statusCode} ${res.body}`);
  const body = res.json() as { id: string; key: string };
  return { id: body.id, key: body.key };
}

function postCheck(serverId: string, payload: Record<string, unknown>, cookie = adminCookie) {
  return app.inject({
    method: "POST",
    url: `/api/servers/${serverId}/checks`,
    headers: { cookie },
    payload,
  });
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

describe("POST /api/servers/:id/checks", () => {
  it("check http: target in chiaro, dsnEncrypted null, hasDsn false", async () => {
    const { id } = await createServerReturning("checks-http");
    const res = await postCheck(id, {
      type: "http",
      name: "api-health",
      target: "https://api.example.com/health",
      intervalSeconds: 30,
      enabled: true,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.type).toBe("http");
    expect(body.target).toBe("https://api.example.com/health");
    expect(body.hasDsn).toBe(false);
    expect(body.lastStatus).toBe("unknown");

    const [row] = await testDb.db
      .select()
      .from(serviceChecks)
      .where(eq(serviceChecks.id, body.id as string));
    expect(row!.target).toBe("https://api.example.com/health");
    expect(row!.dsnEncrypted).toBeNull();
  });

  it("check postgres: DSN cifrato, target vuoto, DSN mai in risposta", async () => {
    const { id } = await createServerReturning("checks-pg");
    const dsn = "postgres://user:s3cret@db.internal:5432/app";
    const res = await postCheck(id, {
      type: "postgres",
      name: "db-primary",
      target: dsn,
      intervalSeconds: 60,
      enabled: true,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    // Il DSN non compare MAI nella risposta.
    expect(JSON.stringify(body)).not.toContain("s3cret");
    expect(JSON.stringify(body)).not.toContain(dsn);
    expect(body.target).toBe("");
    expect(body.hasDsn).toBe(true);
    expect(body).not.toHaveProperty("dsnEncrypted");

    // In DB: solo dsnEncrypted, decifrabile al DSN originale; target vuoto.
    const [row] = await testDb.db
      .select()
      .from(serviceChecks)
      .where(eq(serviceChecks.id, body.id as string));
    expect(row!.target).toBe("");
    expect(row!.dsnEncrypted).not.toBeNull();
    expect(row!.dsnEncrypted).not.toContain("s3cret");
    expect(decrypt(row!.dsnEncrypted!, ENCRYPTION_KEY)).toBe(dsn);
  });

  it("un member non può creare check: 403", async () => {
    const { id } = await createServerReturning("checks-403");
    const res = await postCheck(
      id,
      { type: "http", name: "x", target: "http://x", intervalSeconds: 30, enabled: true },
      memberCookie,
    );
    expect(res.statusCode).toBe(403);
  });

  it("server inesistente: 404", async () => {
    const res = await postCheck(NIL_UUID, {
      type: "http",
      name: "x",
      target: "http://x",
      intervalSeconds: 30,
      enabled: true,
    });
    expect(res.statusCode).toBe(404);
  });

  it("body non valido (intervalSeconds fuori range): 400", async () => {
    const { id } = await createServerReturning("checks-400");
    const res = await postCheck(id, {
      type: "http",
      name: "x",
      target: "http://x",
      intervalSeconds: 1,
      enabled: true,
    });
    expect(res.statusCode).toBe(400);
  });

  it("il check http creato compare in GET /monitor/config (filo end-to-end)", async () => {
    const { id, key } = await createServerReturning("checks-e2e");
    const created = await postCheck(id, {
      type: "http",
      name: "e2e-health",
      target: "https://e2e.example.com/health",
      intervalSeconds: 45,
      enabled: true,
    });
    const checkId = (created.json() as { id: string }).id;

    const cfg = await app.inject({
      method: "GET",
      url: "/monitor/config",
      headers: { "x-stubwise-server-key": key },
    });
    expect(cfg.statusCode).toBe(200);
    const body = cfg.json() as { checks: Array<{ id: string; target: string; name: string }> };
    const found = body.checks.find((c) => c.id === checkId);
    expect(found).toBeDefined();
    expect(found!.target).toBe("https://e2e.example.com/health");
    expect(found!.name).toBe("e2e-health");
  });
});

describe("PUT /api/servers/:id/checks/:checkId", () => {
  it("aggiorna nome/target/interval/enabled di un check http", async () => {
    const { id } = await createServerReturning("put-http");
    const created = await postCheck(id, {
      type: "http",
      name: "old",
      target: "http://old",
      intervalSeconds: 30,
      enabled: true,
    });
    const checkId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PUT",
      url: `/api/servers/${id}/checks/${checkId}`,
      headers: { cookie: adminCookie },
      payload: { name: "new", target: "http://new", intervalSeconds: 120, enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.name).toBe("new");
    expect(body.target).toBe("http://new");
    expect(body.intervalSeconds).toBe(120);
    expect(body.enabled).toBe(false);
    expect(body.hasDsn).toBe(false);
  });

  it("check DB: target presente ri-cifra il DSN; target assente lascia il DSN invariato", async () => {
    const { id } = await createServerReturning("put-pg");
    const dsn1 = "postgres://u:pw1@h:5432/a";
    const created = await postCheck(id, {
      type: "postgres",
      name: "db",
      target: dsn1,
      intervalSeconds: 60,
      enabled: true,
    });
    const checkId = (created.json() as { id: string }).id;

    // target assente: DSN invariato, aggiorna solo il nome.
    const res1 = await app.inject({
      method: "PUT",
      url: `/api/servers/${id}/checks/${checkId}`,
      headers: { cookie: adminCookie },
      payload: { name: "db-rinominato" },
    });
    expect(res1.statusCode).toBe(200);
    expect((res1.json() as { name: string }).name).toBe("db-rinominato");
    let [row] = await testDb.db
      .select()
      .from(serviceChecks)
      .where(eq(serviceChecks.id, checkId));
    expect(decrypt(row!.dsnEncrypted!, ENCRYPTION_KEY)).toBe(dsn1);
    expect(row!.target).toBe("");

    // target presente: ri-cifra al nuovo DSN.
    const dsn2 = "postgres://u:pw2@h:5432/b";
    const res2 = await app.inject({
      method: "PUT",
      url: `/api/servers/${id}/checks/${checkId}`,
      headers: { cookie: adminCookie },
      payload: { target: dsn2 },
    });
    expect(res2.statusCode).toBe(200);
    expect(JSON.stringify(res2.json())).not.toContain("pw2");
    [row] = await testDb.db.select().from(serviceChecks).where(eq(serviceChecks.id, checkId));
    expect(decrypt(row!.dsnEncrypted!, ENCRYPTION_KEY)).toBe(dsn2);
    expect(row!.target).toBe("");
  });

  it("cambio type senza target: 400 in entrambe le direzioni (db→http e http→db)", async () => {
    const { id } = await createServerReturning("put-type-no-target");
    const pg = await postCheck(id, {
      type: "postgres",
      name: "pg",
      target: "postgres://u:pw@h:5432/a",
      intervalSeconds: 60,
      enabled: true,
    });
    const pgId = (pg.json() as { id: string }).id;
    const res1 = await app.inject({
      method: "PUT",
      url: `/api/servers/${id}/checks/${pgId}`,
      headers: { cookie: adminCookie },
      payload: { type: "http" },
    });
    expect(res1.statusCode).toBe(400);
    expect((res1.json() as { code: string }).code).toBe("target_required_for_type_change");

    const http = await postCheck(id, {
      type: "http",
      name: "h",
      target: "http://h",
      intervalSeconds: 30,
      enabled: true,
    });
    const httpId = (http.json() as { id: string }).id;
    const res2 = await app.inject({
      method: "PUT",
      url: `/api/servers/${id}/checks/${httpId}`,
      headers: { cookie: adminCookie },
      payload: { type: "postgres" },
    });
    expect(res2.statusCode).toBe(400);
    expect((res2.json() as { code: string }).code).toBe("target_required_for_type_change");

    // Nessuna modifica applicata: i due check restano com'erano.
    const [pgRow] = await testDb.db.select().from(serviceChecks).where(eq(serviceChecks.id, pgId));
    expect(pgRow!.type).toBe("postgres");
    const [httpRow] = await testDb.db
      .select()
      .from(serviceChecks)
      .where(eq(serviceChecks.id, httpId));
    expect(httpRow!.type).toBe("http");
    expect(httpRow!.target).toBe("http://h");
  });

  it("cambio type CON target: postgres→http azzera il DSN, http→postgres cifra e azzera target", async () => {
    const { id } = await createServerReturning("put-type-with-target");

    // postgres → http: dsnEncrypted azzerato, target in chiaro.
    const pg = await postCheck(id, {
      type: "postgres",
      name: "pg",
      target: "postgres://u:oldpw@h:5432/a",
      intervalSeconds: 60,
      enabled: true,
    });
    const pgId = (pg.json() as { id: string }).id;
    const res1 = await app.inject({
      method: "PUT",
      url: `/api/servers/${id}/checks/${pgId}`,
      headers: { cookie: adminCookie },
      payload: { type: "http", target: "http://nuovo" },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json() as Record<string, unknown>;
    expect(body1.type).toBe("http");
    expect(body1.target).toBe("http://nuovo");
    expect(body1.hasDsn).toBe(false);
    const [pgRow] = await testDb.db.select().from(serviceChecks).where(eq(serviceChecks.id, pgId));
    expect(pgRow!.dsnEncrypted).toBeNull();
    expect(pgRow!.target).toBe("http://nuovo");

    // http → postgres: DSN cifrato, target vuoto, mai il DSN in risposta.
    const http = await postCheck(id, {
      type: "http",
      name: "h",
      target: "http://h",
      intervalSeconds: 30,
      enabled: true,
    });
    const httpId = (http.json() as { id: string }).id;
    const dsn = "postgres://u:newpw@h:5432/b";
    const res2 = await app.inject({
      method: "PUT",
      url: `/api/servers/${id}/checks/${httpId}`,
      headers: { cookie: adminCookie },
      payload: { type: "postgres", target: dsn },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json() as Record<string, unknown>;
    expect(JSON.stringify(body2)).not.toContain("newpw");
    expect(body2.type).toBe("postgres");
    expect(body2.target).toBe("");
    expect(body2.hasDsn).toBe(true);
    const [httpRow] = await testDb.db
      .select()
      .from(serviceChecks)
      .where(eq(serviceChecks.id, httpId));
    expect(httpRow!.target).toBe("");
    expect(decrypt(httpRow!.dsnEncrypted!, ENCRYPTION_KEY)).toBe(dsn);
  });

  it("check di un altro server (mismatch :id/:checkId): 404", async () => {
    const { id: serverA } = await createServerReturning("put-owner-a");
    const { id: serverB } = await createServerReturning("put-owner-b");
    const created = await postCheck(serverA, {
      type: "http",
      name: "a",
      target: "http://a",
      intervalSeconds: 30,
      enabled: true,
    });
    const checkId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PUT",
      url: `/api/servers/${serverB}/checks/${checkId}`,
      headers: { cookie: adminCookie },
      payload: { name: "hack" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può aggiornare: 403", async () => {
    const { id } = await createServerReturning("put-403");
    const created = await postCheck(id, {
      type: "http",
      name: "a",
      target: "http://a",
      intervalSeconds: 30,
      enabled: true,
    });
    const checkId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PUT",
      url: `/api/servers/${id}/checks/${checkId}`,
      headers: { cookie: memberCookie },
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("check inesistente: 404", async () => {
    const { id } = await createServerReturning("put-404");
    const res = await app.inject({
      method: "PUT",
      url: `/api/servers/${id}/checks/${NIL_UUID}`,
      headers: { cookie: adminCookie },
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/servers/:id/checks", () => {
  it("elenca i check con stato corrente e hasDsn; mai il DSN in chiaro né dsnEncrypted", async () => {
    const { id } = await createServerReturning("get-checks");
    const httpCreated = await postCheck(id, {
      type: "http",
      name: "http-c",
      target: "http://c",
      intervalSeconds: 30,
      enabled: true,
    });
    const httpId = (httpCreated.json() as { id: string }).id;
    const dsn = "mysql://u:topsecret@h:3306/d";
    await postCheck(id, {
      type: "mysql",
      name: "mysql-c",
      target: dsn,
      intervalSeconds: 60,
      enabled: true,
    });
    // Simula uno stato corrente sul check http.
    const downSince = new Date();
    await testDb.db
      .update(serviceChecks)
      .set({
        lastStatus: "down",
        lastCheckedAt: downSince,
        lastLatencyMs: 1234,
        lastError: "timeout",
        downSince,
      })
      .where(eq(serviceChecks.id, httpId));

    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}/checks`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, unknown>>;
    expect(JSON.stringify(list)).not.toContain("topsecret");
    for (const c of list) {
      expect(c).not.toHaveProperty("dsnEncrypted");
    }
    const http = list.find((c) => c.id === httpId)!;
    expect(http.lastStatus).toBe("down");
    expect(http.lastLatencyMs).toBe(1234);
    expect(http.lastError).toBe("timeout");
    expect(http.lastCheckedAt).toEqual(expect.any(String));
    expect(http.downSince).toEqual(expect.any(String));
    expect(http.hasDsn).toBe(false);

    const mysql = list.find((c) => c.name === "mysql-c")!;
    expect(mysql.hasDsn).toBe(true);
    expect(mysql.target).toBe("");
  });

  it("server inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${NIL_UUID}/checks`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const { id } = await createServerReturning("get-checks-401");
    const res = await app.inject({ method: "GET", url: `/api/servers/${id}/checks` });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/servers/:id/checks/:checkId", () => {
  it("elimina il check: 204 con cascade su check_samples", async () => {
    const { id } = await createServerReturning("del-check");
    const created = await postCheck(id, {
      type: "http",
      name: "c",
      target: "http://c",
      intervalSeconds: 30,
      enabled: true,
    });
    const checkId = (created.json() as { id: string }).id;
    await testDb.db
      .insert(checkSamples)
      .values({ checkId, ts: new Date(), status: "up", latencyMs: 5 });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/servers/${id}/checks/${checkId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    const checks = await testDb.db
      .select()
      .from(serviceChecks)
      .where(eq(serviceChecks.id, checkId));
    expect(checks).toHaveLength(0);
    const samples = await testDb.db
      .select()
      .from(checkSamples)
      .where(eq(checkSamples.checkId, checkId));
    expect(samples).toHaveLength(0);
  });

  it("check di un altro server (mismatch): 404", async () => {
    const { id: serverA } = await createServerReturning("del-owner-a");
    const { id: serverB } = await createServerReturning("del-owner-b");
    const created = await postCheck(serverA, {
      type: "http",
      name: "a",
      target: "http://a",
      intervalSeconds: 30,
      enabled: true,
    });
    const checkId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/servers/${serverB}/checks/${checkId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    // Il check esiste ancora.
    const checks = await testDb.db
      .select()
      .from(serviceChecks)
      .where(eq(serviceChecks.id, checkId));
    expect(checks).toHaveLength(1);
  });

  it("un member non può eliminare: 403", async () => {
    const { id } = await createServerReturning("del-check-403");
    const created = await postCheck(id, {
      type: "http",
      name: "c",
      target: "http://c",
      intervalSeconds: 30,
      enabled: true,
    });
    const checkId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/servers/${id}/checks/${checkId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("check inesistente: 404", async () => {
    const { id } = await createServerReturning("del-check-404");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/servers/${id}/checks/${NIL_UUID}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/servers/:id/metrics", () => {
  /** Seed di un campione fine (raw) e un rollup 5m per un server. */
  async function seedMetrics(serverId: string, rawTs: Date, rollupTs: Date): Promise<void> {
    await testDb.db.insert(serverMetrics).values({
      serverId,
      ts: rawTs,
      cpuPct: 42.5,
      load1m: 1.5,
      memUsedBytes: 500,
      memTotalBytes: 1000,
      swapUsedBytes: 10,
      diskUsedBytes: 300,
      diskTotalBytes: 1000,
      netRxBytes: 111,
      netTxBytes: 222,
    });
    await testDb.db.insert(serverMetricsRollup).values({
      serverId,
      ts: rollupTs,
      cpuPctAvg: 40,
      cpuPctMax: 88,
      load1mAvg: 1.2,
      load1mMax: 2.4,
      memUsedBytesAvg: 480,
      memUsedBytesMax: 620,
      memTotalBytes: 1000,
      diskUsedBytesAvg: 280,
      diskUsedBytesMax: 320,
      diskTotalBytes: 1000,
      netRxBytesSum: 9999,
      netTxBytesSum: 8888,
    });
  }

  it("range <= 48h: legge i campioni fini con resolution raw", async () => {
    const { id } = await createServerReturning("metrics-raw");
    const rawTs = new Date(Date.now() - 30 * 60_000); // 30 min fa
    const rollupTs = new Date(Date.now() - 7 * 24 * 3600_000); // 7 giorni fa
    await seedMetrics(id, rawTs, rollupTs);

    const from = new Date(Date.now() - 3600_000).toISOString(); // 1h fa
    const to = new Date().toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      resolution: string;
      truncated: boolean;
      points: Array<Record<string, unknown>>;
    };
    expect(body.resolution).toBe("raw");
    expect(body.truncated).toBe(false);
    expect(body.points).toHaveLength(1);
    const p = body.points[0]!;
    expect(p.cpuPct).toBe(42.5);
    expect(p.memUsedBytes).toBe(500);
    expect(p.netRxBytes).toBe(111);
    expect(p.netTxBytes).toBe(222);
    expect(p.ts).toEqual(expect.any(String));
    // I punti raw NON hanno i campi del rollup.
    expect(p).not.toHaveProperty("cpuPctAvg");
  });

  it("range > 48h: legge il rollup con resolution 5m", async () => {
    const { id } = await createServerReturning("metrics-rollup");
    const rawTs = new Date(Date.now() - 30 * 60_000);
    const rollupTs = new Date(Date.now() - 7 * 24 * 3600_000);
    await seedMetrics(id, rawTs, rollupTs);

    const from = new Date(Date.now() - 8 * 24 * 3600_000).toISOString(); // 8 giorni fa
    const to = new Date().toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      resolution: string;
      truncated: boolean;
      points: Array<Record<string, unknown>>;
    };
    expect(body.resolution).toBe("5m");
    expect(body.truncated).toBe(false);
    expect(body.points).toHaveLength(1);
    const p = body.points[0]!;
    expect(p.cpuPctAvg).toBe(40);
    expect(p.cpuPctMax).toBe(88);
    expect(p.netRxBytesSum).toBe(9999);
    expect(p).not.toHaveProperty("cpuPct");
  });

  it("boundary esatto 48h: raw (<=)", async () => {
    const { id } = await createServerReturning("metrics-boundary");
    const to = new Date();
    const from = new Date(to.getTime() - 48 * 3600_000); // esattamente 48h
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}/metrics?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { resolution: string }).resolution).toBe("raw");
  });

  it("oltre METRICS_POINT_LIMIT punti nel range: tiene i più RECENTI e truncated true", async () => {
    const { id } = await createServerReturning("metrics-trunc");
    // LIMIT+1 campioni a 1 secondo di distanza, dentro un range corto (raw).
    const base = new Date(Date.now() - 3 * 3600_000);
    await testDb.db.execute(sql`
      insert into server_metrics
        (server_id, ts, cpu_pct, load_1m, mem_used_bytes, mem_total_bytes,
         swap_used_bytes, disk_used_bytes, disk_total_bytes, net_rx_bytes, net_tx_bytes)
      select ${id}::uuid, ${base.toISOString()}::timestamptz + make_interval(secs => i),
             i, 0.5, 100, 1000, 0, 100, 1000, 0, 0
      from generate_series(0, ${METRICS_POINT_LIMIT}) as i
    `);

    const from = new Date(base.getTime() - 60_000).toISOString();
    const to = new Date().toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      truncated: boolean;
      points: Array<{ ts: string; cpuPct: number }>;
    };
    expect(body.truncated).toBe(true);
    expect(body.points).toHaveLength(METRICS_POINT_LIMIT);
    // Ordine ts ascendente e finestra ancorata ai punti più RECENTI: il primo
    // campione (i=0) è l'unico scartato, l'ultimo (i=LIMIT) è presente.
    const first = body.points[0]!;
    const last = body.points.at(-1)!;
    expect(first.cpuPct).toBe(1);
    expect(last.cpuPct).toBe(METRICS_POINT_LIMIT);
    expect(new Date(last.ts).getTime()).toBe(base.getTime() + METRICS_POINT_LIMIT * 1000);
    expect(new Date(first.ts).getTime()).toBeLessThan(new Date(last.ts).getTime());
  });

  it("checkId opzionale: aggiunge checkPoints (raw: status+latencyMs)", async () => {
    const { id } = await createServerReturning("metrics-check-raw");
    const created = await postCheck(id, {
      type: "http",
      name: "c",
      target: "http://c",
      intervalSeconds: 30,
      enabled: true,
    });
    const checkId = (created.json() as { id: string }).id;
    const sampleTs = new Date(Date.now() - 20 * 60_000);
    await testDb.db
      .insert(checkSamples)
      .values({ checkId, ts: sampleTs, status: "up", latencyMs: 77 });

    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date().toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&checkId=${checkId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      resolution: string;
      checkPoints: Array<Record<string, unknown>>;
    };
    expect(body.resolution).toBe("raw");
    expect(body.checkPoints).toHaveLength(1);
    expect(body.checkPoints[0]!.status).toBe("up");
    expect(body.checkPoints[0]!.latencyMs).toBe(77);
  });

  it("checkId opzionale su range lungo: checkPoints dal rollup (upCount/downCount/avg/max)", async () => {
    const { id } = await createServerReturning("metrics-check-rollup");
    const created = await postCheck(id, {
      type: "http",
      name: "c",
      target: "http://c",
      intervalSeconds: 30,
      enabled: true,
    });
    const checkId = (created.json() as { id: string }).id;
    const rollupTs = new Date(Date.now() - 7 * 24 * 3600_000);
    await testDb.db.insert(checkSamplesRollup).values({
      checkId,
      ts: rollupTs,
      upCount: 9,
      downCount: 1,
      latencyMsAvg: 50,
      latencyMsMax: 120,
    });

    const from = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    const to = new Date().toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&checkId=${checkId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      resolution: string;
      checkPoints: Array<Record<string, unknown>>;
    };
    expect(body.resolution).toBe("5m");
    expect(body.checkPoints).toHaveLength(1);
    expect(body.checkPoints[0]!.upCount).toBe(9);
    expect(body.checkPoints[0]!.downCount).toBe(1);
    expect(body.checkPoints[0]!.latencyMsAvg).toBe(50);
    expect(body.checkPoints[0]!.latencyMsMax).toBe(120);
  });

  it("checkId di un altro server: 404", async () => {
    const { id: serverA } = await createServerReturning("metrics-check-a");
    const { id: serverB } = await createServerReturning("metrics-check-b");
    const created = await postCheck(serverA, {
      type: "http",
      name: "a",
      target: "http://a",
      intervalSeconds: 30,
      enabled: true,
    });
    const checkId = (created.json() as { id: string }).id;
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date().toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${serverB}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&checkId=${checkId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("server inesistente: 404", async () => {
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date().toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${NIL_UUID}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("from >= to: 400", async () => {
    const { id } = await createServerReturning("metrics-bad-range");
    const to = new Date(Date.now() - 3600_000).toISOString();
    const from = new Date().toISOString(); // from dopo to
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("from/to mancanti: 400", async () => {
    const { id } = await createServerReturning("metrics-missing");
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}/metrics`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("senza sessione: 401", async () => {
    const { id } = await createServerReturning("metrics-401");
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date().toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/api/servers/${id}/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
