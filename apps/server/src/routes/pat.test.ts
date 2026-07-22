import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
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

function createPat(payload: Record<string, unknown>, cookie = adminCookie) {
  return app.inject({ method: "POST", url: "/api/pats", headers: { cookie }, payload });
}

function listPats(cookie = adminCookie) {
  return app.inject({ method: "GET", url: "/api/pats", headers: { cookie } });
}

describe("POST /api/pats", () => {
  it("crea un PAT: 201 con il token in chiaro (stw_pat_…) una sola volta + i campi patView", async () => {
    const res = await createPat({ name: "il mio token" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.id).toEqual(expect.any(String));
    expect(body.name).toBe("il mio token");
    expect(body.token).toEqual(expect.stringMatching(/^stw_pat_[0-9a-f]{48}$/));
    expect(body.lastUsedAt).toBeNull();
    expect(body.expiresAt).toBeNull();
    expect(body.createdAt).toEqual(expect.any(String));
  });

  it("con expiresAt ISO nel futuro: 201 e il token ha quella scadenza", async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const res = await createPat({ name: "con scadenza", expiresAt });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(new Date(body.expiresAt as string).getTime()).toBe(new Date(expiresAt).getTime());
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/pats", payload: { name: "X" } });
    expect(res.statusCode).toBe(401);
  });

  it("body non valido (name mancante): 400", async () => {
    const res = await createPat({});
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/pats", () => {
  it("elenca i PAT dell'utente SENZA il token in chiaro", async () => {
    const created = await createPat({ name: "elencabile" });
    const createdId = (created.json() as { id: string }).id;

    const res = await listPats();
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((p) => p.id === createdId);
    expect(found).toBeDefined();
    expect(found).not.toHaveProperty("token");
    expect(JSON.stringify(body)).not.toContain("stw_pat_");
  });
});

describe("DELETE /api/pats/:id", () => {
  it("revoca un PAT: 204 e dopo il delete quel token non autentica più (401)", async () => {
    const created = await createPat({ name: "da revocare" });
    const { id, token } = created.json() as { id: string; token: string };

    // Prima del delete il token autentica.
    const before = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);

    const del = await app.inject({ method: "DELETE", url: `/api/pats/${id}`, headers: { cookie: adminCookie } });
    expect(del.statusCode).toBe(204);

    // Dopo il delete lo stesso token non autentica più.
    const after = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("isolamento per-utente", () => {
  it("GET non elenca i PAT di un altro utente", async () => {
    const memberPat = await createPat({ name: "del member" }, memberCookie);
    const memberPatId = (memberPat.json() as { id: string }).id;

    const adminList = await listPats(adminCookie);
    const adminBody = adminList.json() as Array<{ id: string }>;
    expect(adminBody.find((p) => p.id === memberPatId)).toBeUndefined();
  });

  it("DELETE di un PAT altrui: 404 (non lo tocca)", async () => {
    const memberPat = await createPat({ name: "protetto" }, memberCookie);
    const memberPatId = (memberPat.json() as { id: string }).id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/pats/${memberPatId}`,
      headers: { cookie: adminCookie },
    });
    expect(del.statusCode).toBe(404);

    // Il token del member deve restare presente nella sua lista.
    const memberList = await listPats(memberCookie);
    const memberBody = memberList.json() as Array<{ id: string }>;
    expect(memberBody.find((p) => p.id === memberPatId)).toBeDefined();
  });
});
