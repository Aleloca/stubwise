import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedRepositoryInProject, startTestDb } from "@stubwise/db/testing";
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
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("GET /api/projects/:projectId/widget-settings", () => {
  it("senza sessione: 401", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget-settings`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/widget-settings",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("progetto vergine: 200 con i default dello schema, senza creare la riga", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: false,
      enabledRepositoryIds: [],
      title: "Assistenza",
      welcomeMessage: "Ciao! Come posso aiutarti?",
      accentColor: "#22c55e",
      language: "it",
    });
  });
});

describe("PUT /api/projects/:projectId/widget-settings", () => {
  it("admin con un repo del progetto: 200 e la GET riflette i valori", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const payload = {
      enabled: true,
      enabledRepositoryIds: [repositoryId],
      title: "Supporto",
      welcomeMessage: "Benvenuto nel supporto!",
      accentColor: "#3366ff",
      language: "en",
    };

    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: adminCookie },
      payload,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject(payload);

    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: memberCookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject(payload);
  });

  it("upsert: una seconda PUT aggiorna la riga esistente", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const base = {
      enabled: true,
      enabledRepositoryIds: [],
      title: "Primo",
      welcomeMessage: "Prima versione",
      accentColor: "#111111",
      language: "it",
    };
    const first = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: adminCookie },
      payload: base,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: adminCookie },
      payload: { ...base, title: "Secondo", enabled: false },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ title: "Secondo", enabled: false });

    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: memberCookie },
    });
    expect(get.json()).toMatchObject({ title: "Secondo", enabled: false });
  });

  it("repositoryId di un ALTRO progetto: 422", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const other = await seedRepository(testDb.db);

    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: adminCookie },
      payload: {
        enabled: true,
        enabledRepositoryIds: [other.repositoryId],
        title: "Supporto",
        welcomeMessage: "Benvenuto!",
        accentColor: "#3366ff",
        language: "it",
      },
    });
    expect(put.statusCode).toBe(422);
  });

  it("più repo dello stesso progetto: 200", async () => {
    const { projectId, repositoryId } = await seedRepository(testDb.db);
    const secondRepo = await seedRepositoryInProject(testDb.db, projectId);

    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: adminCookie },
      payload: {
        enabled: true,
        enabledRepositoryIds: [repositoryId, secondRepo],
        title: "Supporto",
        welcomeMessage: "Benvenuto!",
        accentColor: "#3366ff",
        language: "it",
      },
    });
    expect(put.statusCode).toBe(200);
  });

  it("progetto inesistente: 404", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/widget-settings",
      headers: { cookie: adminCookie },
      payload: {
        enabled: false,
        enabledRepositoryIds: [],
        title: "Assistenza",
        welcomeMessage: "Ciao!",
        accentColor: "#22c55e",
        language: "it",
      },
    });
    expect(put.statusCode).toBe(404);
  });

  it("da member (non admin): 403", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/widget-settings`,
      headers: { cookie: memberCookie },
      payload: {
        enabled: true,
        enabledRepositoryIds: [],
        title: "Supporto",
        welcomeMessage: "Benvenuto!",
        accentColor: "#3366ff",
        language: "it",
      },
    });
    expect(put.statusCode).toBe(403);
  });
});
