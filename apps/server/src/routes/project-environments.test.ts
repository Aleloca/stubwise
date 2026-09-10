import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { projectEnvironments, servers } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedEnvironment, seedRepository, startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let projectId: string;

const MISSING_UUID = "00000000-0000-0000-0000-000000000000";

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
  ({ projectId } = await seedRepository(testDb.db));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function createEnvironment(
  body: { name: string; kind: string; url?: string | null; serverId?: string | null },
  cookie = adminCookie,
  pid = projectId,
) {
  return app.inject({
    method: "POST",
    url: `/api/projects/${pid}/environments`,
    headers: { cookie },
    payload: body,
  });
}

describe("GET /api/projects/:projectId/environments", () => {
  it("lista vuota per un progetto nuovo senza ambienti extra oltre `test` — qui il progetto è isolato dal seed", async () => {
    const { projectId: freshProjectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${freshProjectId}/environments`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("un member può leggere (non è un segreto, solo anagrafica)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/environments`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/environments`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${MISSING_UUID}/environments`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/projects/:projectId/environments", () => {
  it("l'admin crea un ambiente: 201 con id/projectId/name/kind/url/serverId", async () => {
    const res = await createEnvironment({ name: "staging", kind: "staging", url: "https://staging.acme.test" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: expect.any(String),
      projectId,
      name: "staging",
      kind: "staging",
      url: "https://staging.acme.test",
      serverId: null,
    });
  });

  it("url/serverId assenti → null", async () => {
    const res = await createEnvironment({ name: "prod", kind: "production" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ url: null, serverId: null });
  });

  it("serverId di un server esistente: collegato", async () => {
    const [server] = await testDb.db
      .insert(servers)
      .values({ name: "vps-env-test", keyHash: `hash-${crypto.randomUUID()}` })
      .returning();
    const res = await createEnvironment({ name: "staging-eu", kind: "staging", serverId: server!.id });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ serverId: server!.id });
  });

  it("serverId inesistente: 400", async () => {
    const res = await createEnvironment({ name: "staging-bad-server", kind: "staging", serverId: MISSING_UUID });
    expect(res.statusCode).toBe(400);
  });

  it("nome duplicato sullo stesso progetto: 409", async () => {
    await createEnvironment({ name: "staging-dup", kind: "staging" });
    const again = await createEnvironment({ name: "staging-dup", kind: "production" });
    expect(again.statusCode).toBe(409);
  });

  it("kind fuori enum: 400 (validazione Zod)", async () => {
    const res = await createEnvironment({ name: "canary", kind: "canary" });
    expect(res.statusCode).toBe(400);
  });

  it("progetto inesistente: 404", async () => {
    const res = await createEnvironment({ name: "x", kind: "test" }, adminCookie, MISSING_UUID);
    expect(res.statusCode).toBe(404);
  });

  it("un member non può creare: 403", async () => {
    const res = await createEnvironment({ name: "staging-member", kind: "staging" }, memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/environments`,
      payload: { name: "x", kind: "test" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/projects/:projectId/environments/:environmentId", () => {
  it("aggiorna nome/url/serverId; kind resta invariato anche se il body lo tenta", async () => {
    const created = await createEnvironment({ name: "to-patch", kind: "staging" });
    const environmentId = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: adminCookie },
      // `kind` non è nello schema di patch: passarlo non deve cambiarlo.
      payload: { name: "patched", url: "https://patched.acme.test", kind: "production" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "patched", url: "https://patched.acme.test", kind: "staging" });
  });

  it("campi assenti restano invariati (vera PATCH)", async () => {
    const created = await createEnvironment({ name: "to-patch-partial", kind: "staging", url: "https://a.test" });
    const environmentId = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: adminCookie },
      payload: { name: "renamed-only" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "renamed-only", url: "https://a.test" });
  });

  it("url: null azzera esplicitamente", async () => {
    const created = await createEnvironment({ name: "to-clear-url", kind: "staging", url: "https://a.test" });
    const environmentId = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: adminCookie },
      payload: { url: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: null });
  });

  it("ambiente inesistente: 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${MISSING_UUID}`,
      headers: { cookie: adminCookie },
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può modificare: 403", async () => {
    const created = await createEnvironment({ name: "to-patch-member", kind: "staging" });
    const environmentId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: memberCookie },
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/projects/:projectId/environments/:environmentId", () => {
  it("elimina un ambiente non-test: 204", async () => {
    const created = await createEnvironment({ name: "to-delete", kind: "staging" });
    const environmentId = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);

    const rows = await testDb.db
      .select()
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, environmentId));
    expect(rows).toHaveLength(0);
  });

  it("l'ambiente `test` NON si cancella: 409, riga intatta", async () => {
    const testEnvironmentId = await seedEnvironment(testDb.db, projectId, { name: "test-protetto", kind: "test" });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/environments/${testEnvironmentId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "test_environment_immutable" });

    const rows = await testDb.db
      .select()
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, testEnvironmentId));
    expect(rows).toHaveLength(1);
  });

  it("ambiente inesistente: 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/environments/${MISSING_UUID}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può eliminare: 403", async () => {
    const created = await createEnvironment({ name: "to-delete-member", kind: "staging" });
    const environmentId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);

    const rows = await testDb.db
      .select()
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, environmentId));
    expect(rows).toHaveLength(1);
  });
});
