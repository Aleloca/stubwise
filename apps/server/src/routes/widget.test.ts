import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { ChatAvailability, ChatLlm } from "./chat-llm.js";
import { projects, widgetSettings } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

// Fake ChatLlm: il config endpoint usa solo isAvailable(); lo stream non è
// esercitato in questo task. `availabilityOverride` esercita il ramo chat off,
// `availabilityThrows` esercita il ramo resiliente (isAvailable che lancia).
let availabilityOverride: ChatAvailability | null = null;
let availabilityThrows = false;

const fakeChatLlm: ChatLlm = {
  stream(): AsyncIterable<string> {
    // Il config endpoint non stremma: se qualcuno lo invoca, è un errore di test.
    throw new Error("stream non usato nel config endpoint");
  },
  async isAvailable(): Promise<ChatAvailability> {
    if (availabilityThrows) {
      throw new Error("provider LLM misconfigurato");
    }
    return availabilityOverride ?? { available: true };
  },
};

let testDb: TestDb;
let app: FastifyInstance;

/** Seed di un progetto (+ repo) e lettura di slug/ingestionKey della superficie pubblica. */
async function seedProjectWithKey(
  db: Db,
): Promise<{ projectId: string; repositoryId: string; slug: string; ingestionKey: string }> {
  const { projectId, repositoryId } = await seedRepository(db);
  const [project] = await db
    .select({ slug: projects.slug, ingestionKey: projects.ingestionKey })
    .from(projects)
    .where(eq(projects.id, projectId));
  return {
    projectId,
    repositoryId,
    slug: project!.slug,
    ingestionKey: project!.ingestionKey,
  };
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    chatLlm: fakeChatLlm,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(() => {
  availabilityOverride = null;
  availabilityThrows = false;
});

describe("GET /widget/:slug/config", () => {
  it("senza header chiave → 401", async () => {
    const project = await seedProjectWithKey(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/config`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "invalid_ingestion_key" });
  });

  it("chiave sbagliata → 401", async () => {
    const project = await seedProjectWithKey(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/config`,
      headers: { "x-stubwise-key": "chiave-sbagliata" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("slug inesistente → 401 (indistinguibile)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/widget/slug-che-non-esiste/config",
      headers: { "x-stubwise-key": "una-chiave-qualunque" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "invalid_ingestion_key" });
  });

  it("chiave giusta, settings assenti → { enabled: false }", async () => {
    const project = await seedProjectWithKey(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/config`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ enabled: false });
  });

  it("settings disabilitati (enabled=false) → { enabled: false }", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await testDb.db.insert(widgetSettings).values({
      projectId: project.projectId,
      enabled: false,
      enabledRepositoryIds: [project.repositoryId],
    });
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/config`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
  });

  it("settings enabled con 1 repo → enabled: true + campi + chatEnabled: true", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await testDb.db.insert(widgetSettings).values({
      projectId: project.projectId,
      enabled: true,
      enabledRepositoryIds: [project.repositoryId],
      title: "Supporto Acme",
      welcomeMessage: "Benvenuto!",
      accentColor: "#0088ff",
      language: "en",
    });
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/config`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      enabled: true,
      title: "Supporto Acme",
      welcomeMessage: "Benvenuto!",
      accentColor: "#0088ff",
      language: "en",
      chatEnabled: true,
    });
  });

  it("settings enabled ma enabledRepositoryIds vuoto → chatEnabled: false", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await testDb.db.insert(widgetSettings).values({
      projectId: project.projectId,
      enabled: true,
      enabledRepositoryIds: [],
    });
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/config`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, chatEnabled: false });
  });

  it("settings enabled ma chat non disponibile (nessun provider) → chatEnabled: false", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await testDb.db.insert(widgetSettings).values({
      projectId: project.projectId,
      enabled: true,
      enabledRepositoryIds: [project.repositoryId],
    });
    availabilityOverride = { available: false, reason: "no_api_key_provider" };
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/config`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, chatEnabled: false });
  });

  it("settings enabled ma isAvailable LANCIA → 200 con chatEnabled: false (endpoint pubblico resiliente)", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await testDb.db.insert(widgetSettings).values({
      projectId: project.projectId,
      enabled: true,
      enabledRepositoryIds: [project.repositoryId],
    });
    availabilityThrows = true;
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/config`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, chatEnabled: false });
  });

  it("risposta include header CORS access-control-allow-origin: *", async () => {
    const project = await seedProjectWithKey(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/config`,
      headers: { "x-stubwise-key": project.ingestionKey, origin: "https://sito-cliente.example" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});
