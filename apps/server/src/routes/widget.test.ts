import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { buildApp } from "../app.js";
import type { ChatAvailability, ChatLlm, ChatLlmInput } from "./chat-llm.js";
import {
  docChunks,
  docGenerations,
  docPages,
  projects,
  repositories,
  tickets,
  widgetConversations,
  widgetMessages,
  widgetSettings,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import {
  seedRepository,
  seedRepositoryInProject,
  seedTicket,
  startTestDb,
} from "@stubwise/db/testing";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

// Stesso fake client dell'app, usato anche per pre-embeddare i chunk: un testo
// identico → vettore identico → distanza coseno 0 → quel chunk ranka primo.
const embeddingClient = createFakeEmbeddingClient();

// Fake ChatLlm: il config endpoint usa solo isAvailable(); la chat esercita
// `stream`. `availabilityOverride` esercita il ramo chat off, `availabilityThrows`
// il ramo resiliente (isAvailable che lancia), `streamOverride` sostituisce lo
// stream canned (test error/sentinel), `lastChatInput` registra l'input (wiring).
const FAKE_DELTAS = ["Ciao! ", "Ecco ", "la ", "risposta."];
let availabilityOverride: ChatAvailability | null = null;
let availabilityThrows = false;
let lastChatInput: ChatLlmInput | null = null;
let streamOverride: ((input: ChatLlmInput) => AsyncIterable<string>) | null = null;

async function* defaultStream(): AsyncIterable<string> {
  for (const d of FAKE_DELTAS) yield d;
}

const fakeChatLlm: ChatLlm = {
  stream(input: ChatLlmInput): AsyncIterable<string> {
    lastChatInput = input;
    return (streamOverride ?? defaultStream)(input);
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
/** Cap alto (build separata sotto per il test del cap basso). */
let capApp: FastifyInstance;
/** Istanza col cap giornaliero ticket = 1 (test del limite ticket). */
let ticketCapApp: FastifyInstance;

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

/** Generazione succeeded + impostata come corrente del repo. Ritorna il gen id. */
async function seedCurrentGeneration(db: Db, repositoryId: string): Promise<string> {
  const [gen] = await db
    .insert(docGenerations)
    .values({
      repositoryId,
      status: "succeeded",
      commitSha: randomBytes(4).toString("hex"),
      trigger: "manual",
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning();
  await db
    .update(repositories)
    .set({ currentDocGenerationId: gen!.id })
    .where(eq(repositories.id, repositoryId));
  return gen!.id;
}

let widgetPageSeq = 0;

/** Pagina + chunk (embedding = quello del contenuto). Ritorna slug/title. */
async function seedPageWithChunk(
  db: Db,
  repositoryId: string,
  generationId: string,
  page: { title: string; chunkContent: string },
): Promise<{ slug: string; title: string }> {
  widgetPageSeq++;
  const [row] = await db
    .insert(docPages)
    .values({
      repositoryId,
      generationId,
      kind: "technical",
      slug: `widget-page-${widgetPageSeq}`,
      title: page.title,
      body: page.chunkContent,
      isManual: false,
    })
    .returning();
  const [vector] = await embeddingClient.embed([page.chunkContent]);
  await db.insert(docChunks).values({
    pageId: row!.id,
    repositoryId,
    generationId,
    content: page.chunkContent,
    embedding: vector,
  });
  return { slug: row!.slug, title: row!.title };
}

/** Parsa lo stream SSE grezzo negli eventi `data: {...}`. */
function parseSse(payload: string): { type: string; [k: string]: unknown }[] {
  return payload
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string });
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient,
    chatLlm: fakeChatLlm,
  });
  // Seconda istanza con cap giornaliero = 1 per il test del limite (stesso db).
  capApp = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient,
    chatLlm: fakeChatLlm,
    widgetDailyMessageCap: 1,
  });
  // Terza istanza con cap giornaliero ticket = 1 per il test del limite ticket.
  ticketCapApp = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient,
    chatLlm: fakeChatLlm,
    widgetDailyTicketCap: 1,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await capApp.close();
  await ticketCapApp.close();
  await testDb.stop();
});

beforeEach(() => {
  availabilityOverride = null;
  availabilityThrows = false;
  lastChatInput = null;
  streamOverride = null;
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

  it("senza header chiave → 401 (auth prima di tutto)", async () => {
    const project = await seedProjectWithKey(testDb.db);
    await enableWidget(testDb.db, project.projectId, project.repositoryId);
    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({ projectId: project.projectId, externalUserId: "visitor-1" })
      .returning();
    const res = await app.inject({
      method: "GET",
      url: `/widget/${project.slug}/conversations/${conv!.id}/messages?userId=visitor-1`,
    });
    expect(res.statusCode).toBe(401);
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

describe("POST /widget/:slug/conversations/:conversationId/messages", () => {
  /** Progetto abilitato con un repo documentato + una conversazione pronta. */
  async function setupChat(
    db: Db,
    opts: { userId?: string } = {},
  ): Promise<{
    project: Awaited<ReturnType<typeof seedProjectWithKey>>;
    conversationId: string;
    genId: string;
  }> {
    const project = await seedProjectWithKey(db);
    await enableWidget(db, project.projectId, project.repositoryId);
    const genId = await seedCurrentGeneration(db, project.repositoryId);
    const [conv] = await db
      .insert(widgetConversations)
      .values({ projectId: project.projectId, externalUserId: opts.userId ?? "visitor-1" })
      .returning();
    return { project, conversationId: conv!.id, genId };
  }

  it("stream normale → delta + done con citazioni; user+assistant persistiti; lastMessageAt aggiornato", async () => {
    const { project, conversationId, genId } = await setupChat(testDb.db);
    const question = "Come attivo le notifiche via email?";
    const page = await seedPageWithChunk(testDb.db, project.repositoryId, genId, {
      title: "Notifiche email",
      chunkContent: question,
    });

    const before = await testDb.db
      .select({ lastMessageAt: widgetConversations.lastMessageAt })
      .from(widgetConversations)
      .where(eq(widgetConversations.id, conversationId));

    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: question, userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = parseSse(res.payload);
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.map((e) => e.text).join("")).toBe(FAKE_DELTAS.join(""));
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done!.conversationId).toBe(conversationId);
    const citations = done!.citations as { slug: string }[];
    expect(citations.some((c) => c.slug === page.slug)).toBe(true);
    // Registro customer service nel system prompt.
    expect(lastChatInput!.system).toContain("customer-support");

    // Persistenza: user + assistant; last message user in coda dello storico.
    const messages = await vi.waitFor(async () => {
      const rows = await testDb.db
        .select()
        .from(widgetMessages)
        .where(eq(widgetMessages.conversationId, conversationId));
      expect(rows.length).toBe(2);
      return rows;
    });
    const user = messages.find((m) => m.role === "user");
    const assistant = messages.find((m) => m.role === "assistant");
    expect(user?.content).toBe(question);
    expect(assistant?.content).toBe(FAKE_DELTAS.join(""));
    const stored = assistant?.citations as { slug: string }[] | null;
    expect(stored?.some((c) => c.slug === page.slug)).toBe(true);
    expect(lastChatInput!.messages.at(-1)).toEqual({ role: "user", content: question });

    // lastMessageAt avanzato rispetto a prima dell'invio.
    const after = await testDb.db
      .select({ lastMessageAt: widgetConversations.lastMessageAt })
      .from(widgetConversations)
      .where(eq(widgetConversations.id, conversationId));
    expect(after[0]!.lastMessageAt.getTime()).toBeGreaterThanOrEqual(
      before[0]!.lastMessageAt.getTime(),
    );
  });

  it("history oltre la finestra: il primo messaggio passato all'LLM è sempre `user` (no 400 Anthropic)", async () => {
    // Regressione: la finestra è limit(WIDGET_HISTORY_PAIRS*2) in DESC + reverse.
    // Con uno storico dispari (post-insert del nuovo user) il primo elemento della
    // finestra sarebbe un `assistant` → l'API Messages richiede il primo `user`.
    const { project, conversationId } = await setupChat(testDb.db);
    // 11 coppie già persistite (22 messaggi): oltre la finestra di 10 coppie.
    const seed: { conversationId: string; role: string; content: string; createdAt: Date }[] = [];
    for (let i = 0; i < 11; i++) {
      const base = new Date(`2026-07-01T10:00:00Z`).getTime() + i * 2000;
      seed.push({ conversationId, role: "user", content: `domanda ${i}`, createdAt: new Date(base) });
      seed.push({
        conversationId,
        role: "assistant",
        content: `risposta ${i}`,
        createdAt: new Date(base + 1000),
      });
    }
    await testDb.db.insert(widgetMessages).values(seed);

    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: "nuova domanda", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(200);
    // Il nuovo user + i 22 seed = storico dispari a monte: senza il fix il primo
    // elemento della finestra sarebbe un `assistant`.
    expect(lastChatInput!.messages[0]!.role).toBe("user");
    // L'ultimo resta il messaggio corrente.
    expect(lastChatInput!.messages.at(-1)).toEqual({ role: "user", content: "nuova domanda" });
  });

  it("widget abilitato ma senza repo esposti → 404 widget_disabled, nessun messaggio persistito", async () => {
    // Il config dichiara chatEnabled=false con enabledRepositoryIds vuoto; il POST
    // deve IMPORLO (un client che ignora il config non deve bruciare budget LLM).
    const project = await seedProjectWithKey(testDb.db);
    await testDb.db.insert(widgetSettings).values({
      projectId: project.projectId,
      enabled: true,
      enabledRepositoryIds: [],
    });
    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({ projectId: project.projectId, externalUserId: "visitor-1" })
      .returning();
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conv!.id}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: "ciao", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "widget_disabled" });
    const rows = await testDb.db
      .select()
      .from(widgetMessages)
      .where(eq(widgetMessages.conversationId, conv!.id));
    expect(rows.length).toBe(0);
  });

  it("sentinel SPEZZATO su più delta → i delta non contengono mai il marker; ticket_proposal col JSON; content = solo visible", async () => {
    const { project, conversationId, genId } = await seedChatWithoutContext(testDb.db);
    void genId;
    // Stream che emette testo + il blocco sentinel spezzato a metà marker.
    const proposalJson = '{"title":"Bug login","body":"Non funziona","type":"bug"}';
    streamOverride = async function* (): AsyncIterable<string> {
      yield "Mi dispiace, ";
      yield "registro il problema.";
      yield "\n\n<<<TICK"; // marker spezzato
      yield "ET_PROPOSAL\n";
      yield proposalJson;
      yield "\nTICKET_PROPOSAL>>>";
    };

    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: "Il login non va", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.payload);
    const deltaText = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    // Nessun delta contiene un pezzo del marker.
    expect(deltaText).not.toContain("<<<");
    expect(deltaText).not.toContain("TICKET_PROPOSAL");
    expect(deltaText.trim()).toBe("Mi dispiace, registro il problema.");

    const proposalEvent = events.find((e) => e.type === "ticket_proposal");
    expect(proposalEvent).toBeDefined();
    expect(proposalEvent!.proposal).toEqual({
      title: "Bug login",
      body: "Non funziona",
      type: "bug",
    });
    expect(events.some((e) => e.type === "done")).toBe(true);

    // Content persistito = solo il visible (senza il blocco sentinel).
    const assistant = await vi.waitFor(async () => {
      const rows = await testDb.db
        .select()
        .from(widgetMessages)
        .where(eq(widgetMessages.conversationId, conversationId));
      const row = rows.find((m) => m.role === "assistant");
      expect(row).toBeDefined();
      return row!;
    });
    expect(assistant.content).toBe("Mi dispiace, registro il problema.");
    expect(assistant.content).not.toContain("TICKET_PROPOSAL");
  });

  it("sentinel con JSON malformato → nessun ticket_proposal, ma done regolare", async () => {
    const { project, conversationId } = await seedChatWithoutContext(testDb.db);
    streamOverride = async function* (): AsyncIterable<string> {
      yield "Risposta. ";
      yield "\n\n<<<TICKET_PROPOSAL\n{non valido\nTICKET_PROPOSAL>>>";
    };

    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: "domanda", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.payload);
    expect(events.some((e) => e.type === "ticket_proposal")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(true);
    const deltaText = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(deltaText).not.toContain("TICKET_PROPOSAL");
  });

  it("stream che LANCIA a metà (con inizio sentinel) → evento error; parziale persistito col marker, senza frammento sentinel; delta senza marker", async () => {
    const { project, conversationId } = await seedChatWithoutContext(testDb.db);
    // Lo stream emette del testo visibile, POI l'inizio (parziale) del marcatore
    // sentinel, e infine LANCIA: è il caso peggiore, l'interruzione cade dove il
    // marcatore sta per aprirsi.
    streamOverride = async function* (): AsyncIterable<string> {
      yield "Sto verificando";
      yield " il problema.";
      yield "\n\n<<<TICKET_PROP"; // marcatore parziale, mai completato
      throw new Error("LLM esploso a metà stream");
    };

    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: "il login non va", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.payload);
    // L'endpoint segnala l'errore con un evento SSE `error`.
    expect(events.some((e) => e.type === "error")).toBe(true);
    // I delta inoltrati non contengono mai il frammento del marcatore.
    const deltaText = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(deltaText).not.toContain("<<<");
    expect(deltaText).not.toContain("TICKET_PROP");

    // Il parziale persistito ha il marcatore di troncamento e NON contiene il
    // frammento sentinel (che sarebbe finito nello storico GET verbatim).
    const assistant = await vi.waitFor(async () => {
      const rows = await testDb.db
        .select()
        .from(widgetMessages)
        .where(eq(widgetMessages.conversationId, conversationId));
      const row = rows.find((m) => m.role === "assistant");
      expect(row).toBeDefined();
      return row!;
    });
    expect(assistant.content).toContain("_[risposta interrotta]_");
    expect(assistant.content).not.toContain("<<<TICKET_PROP");
    expect(assistant.content).toContain("Sto verificando il problema.");
  });

  it("cap giornaliero: secondo messaggio → 429 widget_chat_cap_reached", async () => {
    // capApp ha widgetDailyMessageCap = 1: il primo passa, il secondo è respinto.
    const { project, conversationId, genId } = await setupChat(testDb.db);
    void genId;
    const first = await capApp.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: "primo", userId: "visitor-1" },
    });
    expect(first.statusCode).toBe(200);
    // Attende l'insert dell'user message (il cap conta i role=user).
    await vi.waitFor(async () => {
      const rows = await testDb.db
        .select()
        .from(widgetMessages)
        .where(eq(widgetMessages.conversationId, conversationId));
      expect(rows.some((m) => m.role === "user")).toBe(true);
    });

    const second = await capApp.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: "secondo", userId: "visitor-1" },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ code: "widget_chat_cap_reached" });
  });

  it("conversazione di un altro utente (userId sbagliato) → 404", async () => {
    const { project, conversationId } = await setupChat(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: "intrusione", userId: "visitor-altro" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("widget disabilitato → 404 widget_disabled", async () => {
    const { project, conversationId } = await setupChat(testDb.db);
    await testDb.db
      .update(widgetSettings)
      .set({ enabled: false })
      .where(eq(widgetSettings.projectId, project.projectId));
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: "ciao", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "widget_disabled" });
  });

  it("chat non disponibile → 503 chat_unavailable, nessun messaggio persistito", async () => {
    const { project, conversationId } = await setupChat(testDb.db);
    availabilityOverride = { available: false, reason: "no_api_key_provider" };
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: "ciao", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "chat_unavailable" });
    const rows = await testDb.db
      .select()
      .from(widgetMessages)
      .where(eq(widgetMessages.conversationId, conversationId));
    expect(rows.length).toBe(0);
  });

  it("body invalido (userId mancante) → 422", async () => {
    const { project, conversationId } = await setupChat(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: "ciao" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("senza header chiave → 401", async () => {
    const { project, conversationId } = await setupChat(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/messages`,
      payload: { content: "ciao", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("retrieval FILTRATO: 2 repo documentati, widget con 1 repo → citazioni solo di quello", async () => {
    // Progetto con due repo, entrambi documentati; il widget espone SOLO repoA.
    const project = await seedProjectWithKey(testDb.db);
    const repoA = project.repositoryId;
    const repoB = await seedRepositoryInProject(testDb.db, project.projectId);
    await testDb.db.insert(widgetSettings).values({
      projectId: project.projectId,
      enabled: true,
      enabledRepositoryIds: [repoA], // solo A
    });
    const genA = await seedCurrentGeneration(testDb.db, repoA);
    const genB = await seedCurrentGeneration(testDb.db, repoB);
    const token = `filttok${randomBytes(4).toString("hex")}`;
    const contentA = `Il ${token} di A gestisce le notifiche.`;
    const contentB = `Il ${token} di B gestisce i pagamenti.`;
    const pageA = await seedPageWithChunk(testDb.db, repoA, genA, {
      title: "A doc",
      chunkContent: contentA,
    });
    const pageB = await seedPageWithChunk(testDb.db, repoB, genB, {
      title: "B doc",
      chunkContent: contentB,
    });
    const [conv] = await testDb.db
      .insert(widgetConversations)
      .values({ projectId: project.projectId, externalUserId: "visitor-1" })
      .returning();

    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conv!.id}/messages`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { content: token, userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.payload);
    const done = events.find((e) => e.type === "done");
    const citations = (done!.citations as { slug: string }[]) ?? [];
    expect(citations.some((c) => c.slug === pageA.slug)).toBe(true);
    expect(citations.some((c) => c.slug === pageB.slug)).toBe(false);
  });
});

describe("POST /widget/:slug/conversations/:conversationId/tickets", () => {
  /** Progetto abilitato + una conversazione con identità e alcuni messaggi. */
  async function setupTicketConversation(
    db: Db,
    opts: {
      userId?: string;
      email?: string | null;
      name?: string | null;
      language?: "it" | "en";
      enabledRepositoryIds?: string[];
    } = {},
  ): Promise<{
    project: Awaited<ReturnType<typeof seedProjectWithKey>>;
    conversationId: string;
  }> {
    const project = await seedProjectWithKey(db);
    await db.insert(widgetSettings).values({
      projectId: project.projectId,
      enabled: true,
      enabledRepositoryIds: opts.enabledRepositoryIds ?? [project.repositoryId],
      language: opts.language ?? "it",
    });
    const [conv] = await db
      .insert(widgetConversations)
      .values({
        projectId: project.projectId,
        externalUserId: opts.userId ?? "visitor-1",
        externalUserEmail: opts.email ?? null,
        externalUserName: opts.name ?? null,
      })
      .returning();
    return { project, conversationId: conv!.id };
  }

  it("creazione felice: ticket in DB (source widget), body con proposta+identità+trascrizione, messaggio assistant collegato (it), lastMessageAt avanzato", async () => {
    const { project, conversationId } = await setupTicketConversation(testDb.db, {
      email: "mario@example.com",
      name: "Mario Rossi",
      language: "it",
    });
    // Trascrizione: due messaggi utente/assistente prima della conferma.
    await testDb.db.insert(widgetMessages).values([
      {
        conversationId,
        role: "user",
        content: "Il login non funziona",
        createdAt: new Date("2026-07-01T10:00:00Z"),
      },
      {
        conversationId,
        role: "assistant",
        content: "Mi dispiace, verifico.",
        createdAt: new Date("2026-07-01T10:00:05Z"),
      },
    ]);
    const before = await testDb.db
      .select({ lastMessageAt: widgetConversations.lastMessageAt })
      .from(widgetConversations)
      .where(eq(widgetConversations.id, conversationId));

    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: {
        title: "Login rotto",
        body: "Non riesco ad autenticarmi.",
        type: "bug",
        userId: "visitor-1",
      },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.ticketId).toMatch(UUID_RE);
    expect(typeof out.number).toBe("number");

    // Ticket persistito col progetto e source widget.
    const [ticket] = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.id, out.ticketId));
    expect(ticket).toMatchObject({
      projectId: project.projectId,
      title: "Login rotto",
      type: "bug",
      priority: "medium",
      source: "widget",
      number: out.number,
    });
    // Body = proposta + separatore + identità + trascrizione.
    expect(ticket!.body).toContain("Non riesco ad autenticarmi.");
    expect(ticket!.body).toContain("\n\n---\n\n");
    expect(ticket!.body).toContain("mario@example.com");
    expect(ticket!.body).toContain("Mario Rossi");
    expect(ticket!.body).toContain("visitor-1");
    expect(ticket!.body).toContain("Il login non funziona");
    expect(ticket!.body).toContain("Mi dispiace, verifico.");

    // Messaggio assistant di conferma, collegato al ticket, in italiano.
    const rows = await testDb.db
      .select()
      .from(widgetMessages)
      .where(eq(widgetMessages.conversationId, conversationId));
    const confirm = rows.find((m) => m.ticketId === out.ticketId);
    expect(confirm).toBeDefined();
    expect(confirm!.role).toBe("assistant");
    expect(confirm!.content).toBe(`Segnalazione registrata: #${out.number}`);

    // lastMessageAt avanzato.
    const after = await testDb.db
      .select({ lastMessageAt: widgetConversations.lastMessageAt })
      .from(widgetConversations)
      .where(eq(widgetConversations.id, conversationId));
    expect(after[0]!.lastMessageAt.getTime()).toBeGreaterThanOrEqual(
      before[0]!.lastMessageAt.getTime(),
    );
  });

  it("il numero ticket incrementa next_ticket_number (secondo ticket → number successivo)", async () => {
    const { project, conversationId } = await setupTicketConversation(testDb.db);
    const first = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { title: "Uno", body: "primo", type: "bug", userId: "visitor-1" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { title: "Due", body: "secondo", type: "feedback", userId: "visitor-1" },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().number).toBe(first.json().number + 1);
  });

  it("conferma in inglese → content assistant in inglese", async () => {
    const { project, conversationId } = await setupTicketConversation(testDb.db, {
      language: "en",
    });
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { title: "Broken", body: "It fails", type: "bug", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(200);
    const rows = await testDb.db
      .select()
      .from(widgetMessages)
      .where(eq(widgetMessages.conversationId, conversationId));
    const confirm = rows.find((m) => m.ticketId === res.json().ticketId);
    expect(confirm!.content).toBe(`Report submitted: #${res.json().number}`);
  });

  it("funziona a chat spenta (enabledRepositoryIds vuoto) → ticket creato lo stesso", async () => {
    const { project, conversationId } = await setupTicketConversation(testDb.db, {
      enabledRepositoryIds: [],
    });
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { title: "Segnalazione", body: "problema", type: "bug", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ticketId).toMatch(UUID_RE);
  });

  it("userId sbagliato → 404 (anti cross-utente)", async () => {
    const { project, conversationId } = await setupTicketConversation(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { title: "T", body: "b", type: "bug", userId: "visitor-altro" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("widget disabilitato → 404 widget_disabled", async () => {
    const { project, conversationId } = await setupTicketConversation(testDb.db);
    await testDb.db
      .update(widgetSettings)
      .set({ enabled: false })
      .where(eq(widgetSettings.projectId, project.projectId));
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { title: "T", body: "b", type: "bug", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "widget_disabled" });
  });

  it("type non ammesso (task) → 422", async () => {
    const { project, conversationId } = await setupTicketConversation(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { title: "T", body: "b", type: "task", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("senza header chiave → 401", async () => {
    const { project, conversationId } = await setupTicketConversation(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      payload: { title: "T", body: "b", type: "bug", userId: "visitor-1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("cap giornaliero ticket: secondo ticket → 429 widget_ticket_cap_reached", async () => {
    // ticketCapApp ha widgetDailyTicketCap = 1: il primo passa, il secondo è
    // respinto PRIMA di creare qualsiasi cosa (istanza separata, stesso db).
    const { project, conversationId } = await setupTicketConversation(testDb.db);
    const first = await ticketCapApp.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { title: "Uno", body: "primo", type: "bug", userId: "visitor-1" },
    });
    expect(first.statusCode).toBe(200);

    const second = await ticketCapApp.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { title: "Due", body: "secondo", type: "bug", userId: "visitor-1" },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ code: "widget_ticket_cap_reached" });

    // Il secondo ticket NON è stato creato: un solo ticket widget per il progetto.
    const rows = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, project.projectId));
    expect(rows).toHaveLength(1);
  });

  it("trascrizione vuota + identità null → body con solo ID esterno, sezione trascrizione omessa", async () => {
    // Nessun messaggio prima della conferma e name/email null: il blocco identità
    // mostra solo l'ID esterno e la sezione trascrizione non compare.
    const { project, conversationId } = await setupTicketConversation(testDb.db, {
      userId: "solo-id",
      email: null,
      name: null,
      language: "it",
    });
    const res = await app.inject({
      method: "POST",
      url: `/widget/${project.slug}/conversations/${conversationId}/tickets`,
      headers: { "x-stubwise-key": project.ingestionKey },
      payload: { title: "Segnalazione", body: "corpo proposta", type: "bug", userId: "solo-id" },
    });
    expect(res.statusCode).toBe(200);
    const [ticket] = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.id, res.json().ticketId));
    const body = ticket!.body!;
    // Identità: solo l'ID esterno, niente Nome/Email.
    expect(body).toContain("**Segnalato da**");
    expect(body).toContain("ID esterno: solo-id");
    expect(body).not.toContain("Nome:");
    expect(body).not.toContain("Email:");
    // Sezione trascrizione omessa (nessun messaggio) e proposta presente col heading.
    expect(body).not.toContain("Trascrizione della conversazione");
    expect(body).toContain("**Segnalazione**");
    expect(body).toContain("corpo proposta");
  });
});

/** Come setupChat ma senza pagine documentate: usato dai test sentinel/error. */
async function seedChatWithoutContext(
  db: Db,
): Promise<{ project: Awaited<ReturnType<typeof seedProjectWithKey>>; conversationId: string; genId: string }> {
  const project = await seedProjectWithKey(db);
  await enableWidget(db, project.projectId, project.repositoryId);
  const genId = await seedCurrentGeneration(db, project.repositoryId);
  const [conv] = await db
    .insert(widgetConversations)
    .values({ projectId: project.projectId, externalUserId: "visitor-1" })
    .returning();
  return { project, conversationId: conv!.id, genId };
}
