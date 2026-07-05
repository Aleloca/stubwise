import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { ChatAvailability, ChatLlm } from "./chat-llm.js";
import { projects, widgetConversations, widgetMessages, widgetSettings } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedTicket, startTestDb } from "@stubwise/db/testing";

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

/** Abilita il widget per un progetto (settings enabled) col repo dato. */
async function enableWidget(db: Db, projectId: string, repositoryId: string): Promise<void> {
  await db.insert(widgetSettings).values({
    projectId,
    enabled: true,
    enabledRepositoryIds: [repositoryId],
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("POST /widget/:slug/conversations", () => {
  it("widget abilitato → 200 con conversationId uuid", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await enableWidget(testDb.db, project.projectId, project.repositoryId);
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { user: { id: "visitor-1", email: "v1@example.com", name: "Visitor Uno" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conversationId).toMatch(UUID_RE);

    // La riga è persistita col progetto e l'identità dichiarata.
    const [row] = await testDb.db
      .select()
      .from(widgetConversations)
      .where(eq(widgetConversations.id, body.conversationId));
    expect(row).toMatchObject({
      projectId: project.projectId,
      externalUserId: "visitor-1",
      externalUserEmail: "v1@example.com",
      externalUserName: "Visitor Uno",
    });
  });

  it("solo user.id (email/name assenti) → 200", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await enableWidget(testDb.db, project.projectId, project.repositoryId);
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { user: { id: "visitor-2" } },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await testDb.db
      .select()
      .from(widgetConversations)
      .where(eq(widgetConversations.id, res.json().conversationId));
    expect(row).toMatchObject({
      externalUserId: "visitor-2",
      externalUserEmail: null,
      externalUserName: null,
    });
  });

  it("body invalido (user.id vuoto) → 422", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await enableWidget(testDb.db, project.projectId, project.repositoryId);
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { user: { id: "" } },
    });
    expect(res.statusCode).toBe(422);
  });

  it("widget disabilitato (enabled=false) → 404 widget_disabled", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await testDb.db.insert(widgetSettings).values({
      projectId: project.projectId,
      enabled: false,
      enabledRepositoryIds: [project.repositoryId],
    });
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { user: { id: "visitor-1" } },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "widget_disabled" });
  });

  it("settings assenti → 404 widget_disabled", async () => {
    const project = await seedProjectWithKey(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { user: { id: "visitor-1" } },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "widget_disabled" });
  });

  it("senza header chiave → 401 (auth prima di tutto)", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await enableWidget(testDb.db, project.projectId, project.repositoryId);
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations`,
      payload: { user: { id: "visitor-1" } },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /widget/:slug/conversations/:conversationId/messages", () => {
  it("storico vuoto subito dopo la creazione → { messages: [] }", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await enableWidget(testDb.db, project.projectId, project.repositoryId);
    const created = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { user: { id: "visitor-1" } },
    });
    const { conversationId } = created.json();
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages?userId=visitor-1`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messages: [] });
  });

  it("storico con messaggi → in ordine cronologico con shape completa", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await enableWidget(testDb.db, project.projectId, project.repositoryId);
    const { ticketId } = await seedTicket(testDb.db, {
      projectId: project.projectId,
      repositoryId: project.repositoryId,
    });
    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({ projectId: project.projectId, externalUserId: "visitor-1" })
      .returning();
    const citations = [{ pageId: "p1", title: "Doc" }];
    await testDb.db.insert(widgetMessages).values([
      {
        conversationId: conv!.id,
        role: "user",
        content: "Ciao",
        createdAt: new Date("2026-07-01T10:00:00Z"),
      },
      {
        conversationId: conv!.id,
        role: "assistant",
        content: "Risposta",
        citations,
        ticketId,
        createdAt: new Date("2026-07-01T10:00:05Z"),
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/conversations/${conv!.id}/messages?userId=visitor-1`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(200);
    const { messages } = res.json();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "Ciao",
      citations: null,
      ticketId: null,
      createdAt: "2026-07-01T10:00:00.000Z",
    });
    expect(messages[0].id).toMatch(UUID_RE);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "Risposta",
      citations,
      ticketId,
      createdAt: "2026-07-01T10:00:05.000Z",
    });
  });

  it("userId sbagliato → 404 (anti-lettura cross-utente)", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await enableWidget(testDb.db, project.projectId, project.repositoryId);
    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({ projectId: project.projectId, externalUserId: "visitor-1" })
      .returning();
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/conversations/${conv!.id}/messages?userId=visitor-2`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(404);
  });

  it("conversazione di un altro progetto → 404", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await enableWidget(testDb.db, project.projectId, project.repositoryId);
    const other = await seedProjectWithKey(testDb.db);
    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({ projectId: other.projectId, externalUserId: "visitor-1" })
      .returning();
    // La chiave/slug è del PRIMO progetto, la conversazione del secondo.
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/conversations/${conv!.id}/messages?userId=visitor-1`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(404);
  });

  it("conversationId inesistente → 404", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await enableWidget(testDb.db, project.projectId, project.repositoryId);
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/conversations/00000000-0000-0000-0000-000000000000/messages?userId=visitor-1`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(404);
  });

  it("widget disabilitato (enabled=false) → 404 widget_disabled", async () => {
    const project = await seedProjectWithKey(testDb.db);
    // Prima abilito per creare la conversazione, poi disabilito.
    await enableWidget(testDb.db, project.projectId, project.repositoryId);
    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({ projectId: project.projectId, externalUserId: "visitor-1" })
      .returning();
    await testDb.db
      .update(widgetSettings)
      .set({ enabled: false })
      .where(eq(widgetSettings.projectId, project.projectId));
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/conversations/${conv!.id}/messages?userId=visitor-1`,
      headers: { "x-stubwise-key": project.ingestionKey },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "widget_disabled" });
  });
});
