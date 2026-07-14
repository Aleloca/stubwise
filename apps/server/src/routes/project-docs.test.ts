import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { buildApp } from "../app.js";
import type { ChatAvailability, ChatLlm, ChatLlmInput } from "./chat-llm.js";
import {
  docChatMessages,
  docChatSessions,
  docChunks,
  docGenerations,
  docPages,
  gitAccounts,
  projects,
  repositories,
  searchHistory,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

// Stesso fake client deterministico (hash → vettore) dei test docs: testo
// identico → distanza coseno 0 → quel chunk ranka primo.
const embeddingClient = createFakeEmbeddingClient();

const FAKE_DELTAS = ["Hello ", "from ", "the ", "project ", "docs."];
let lastChatInput: ChatLlmInput | null = null;

async function* defaultStream(): AsyncIterable<string> {
  for (const d of FAKE_DELTAS) yield d;
}

let streamOverride: ((input: ChatLlmInput) => AsyncIterable<string>) | null = null;
let availabilityOverride: ChatAvailability | null = null;

const fakeChatLlm: ChatLlm = {
  stream(input: ChatLlmInput): AsyncIterable<string> {
    lastChatInput = input;
    return (streamOverride ?? defaultStream)(input);
  },
  async isAvailable(): Promise<ChatAvailability> {
    return availabilityOverride ?? { available: true };
  },
};

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

/** Crea un progetto vuoto e ne restituisce l'id. */
async function seedProject(db: Db): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({ name: "Progetto", slug: `progetto-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  return project.id;
}

/** Crea un repository nel progetto dato e ne restituisce id/slug/name. */
async function seedRepoInProject(
  db: Db,
  projectId: string,
  name: string,
): Promise<{ id: string; slug: string; name: string }> {
  const [account] = await db
    .insert(gitAccounts)
    .values({ name: `Account ${randomUUID()}`, provider: "github", encryptedCredentials: "blob" })
    .returning();
  const slug = `repo-${randomUUID()}`;
  const [repo] = await db
    .insert(repositories)
    .values({
      projectId,
      name,
      slug,
      provider: "github",
      gitAccountId: account!.id,
      repoUrl: "https://example.com/repo.git",
      defaultBranch: "main",
    })
    .returning();
  if (!repo) throw new Error("insert del repository non ha restituito la riga");
  return { id: repo.id, slug, name };
}

/** Generazione succeeded; la imposta come corrente del repo. */
async function seedGeneration(db: Db, repositoryId: string): Promise<string> {
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
  if (!gen) throw new Error("insert della generazione non ha restituito la riga");
  await db
    .update(repositories)
    .set({ currentDocGenerationId: gen.id })
    .where(eq(repositories.id, repositoryId));
  return gen.id;
}

let pageSeq = 0;

/** Pagina + chunk il cui embedding è quello del contenuto (fake client). */
async function seedPageWithChunk(
  db: Db,
  repositoryId: string,
  generationId: string,
  page: { title: string; body: string; chunkContent: string },
): Promise<{ slug: string; title: string }> {
  pageSeq++;
  const [row] = await db
    .insert(docPages)
    .values({
      repositoryId,
      generationId,
      kind: "technical",
      slug: `proj-page-${pageSeq}`,
      title: page.title,
      body: page.body,
      isManual: false,
    })
    .returning();
  if (!row) throw new Error("insert della pagina non ha restituito la riga");
  const [vector] = await embeddingClient.embed([page.chunkContent]);
  await db.insert(docChunks).values({
    pageId: row.id,
    repositoryId,
    generationId,
    content: page.chunkContent,
    embedding: vector,
  });
  return { slug: row.slug, title: row.title };
}

/** Parsa il payload SSE grezzo in array di eventi. */
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
  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(() => {
  lastChatInput = null;
  streamOverride = null;
  availabilityOverride = null;
});

describe("GET /api/projects/:projectId/docs/spaces", () => {
  it("elenca i repo-spazi del progetto col conteggio pagine, non quelli di altri progetti", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    const repoB = await seedRepoInProject(testDb.db, projectId, "Repo Beta");
    const genA = await seedGeneration(testDb.db, repoA.id);
    await seedPageWithChunk(testDb.db, repoA.id, genA, {
      title: "Auth",
      body: "Pagina auth.",
      chunkContent: "auth alfa",
    });

    // Un altro progetto con un repo che NON deve comparire.
    const otherProject = await seedProject(testDb.db);
    const otherRepo = await seedRepoInProject(testDb.db, otherProject, "Repo Estraneo");

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/docs/spaces`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const spaces = res.json() as { repositoryId: string; pageCount: number; name: string }[];

    const ids = spaces.map((s) => s.repositoryId);
    expect(ids).toContain(repoA.id);
    expect(ids).toContain(repoB.id);
    expect(ids).not.toContain(otherRepo.id);

    const alfa = spaces.find((s) => s.repositoryId === repoA.id);
    expect(alfa!.pageCount).toBe(1);
    // Repo del progetto senza documentazione: pageCount 0.
    const beta = spaces.find((s) => s.repositoryId === repoB.id);
    expect(beta!.pageCount).toBe(0);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${randomUUID()}/docs/spaces`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const projectId = await seedProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/docs/spaces`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/projects/:projectId/docs/search", () => {
  it("ricerca cross-repo: risultati da più repo col repository annotato, nessuna riga in doc_search_history", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    const repoB = await seedRepoInProject(testDb.db, projectId, "Repo Beta");
    const genA = await seedGeneration(testDb.db, repoA.id);
    const genB = await seedGeneration(testDb.db, repoB.id);
    await seedPageWithChunk(testDb.db, repoA.id, genA, {
      title: "Modulo Alfa",
      body: "Il modulo di Alfa.",
      chunkContent: "Il modulo di Alfa gestisce gli accessi.",
    });
    await seedPageWithChunk(testDb.db, repoB.id, genB, {
      title: "Modulo Beta",
      body: "Il modulo di Beta.",
      chunkContent: "Il modulo di Beta gestisce le imposte.",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/docs/search?q=modulo`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const results = res.json() as {
      repositoryId: string;
      repositoryName: string;
      repositorySlug: string;
      slug: string;
    }[];

    const repoIds = new Set(results.map((r) => r.repositoryId));
    expect(repoIds.has(repoA.id)).toBe(true);
    expect(repoIds.has(repoB.id)).toBe(true);
    // Ogni risultato è annotato col repository.
    expect(results.every((r) => typeof r.repositoryName === "string" && r.repositorySlug)).toBe(
      true,
    );

    // D5: NESSUNA persistenza di cronologia per la ricerca di progetto. La
    // cronologia resta per-repository: nessuna riga per i repo coinvolti.
    const historyForRepoA = await testDb.db
      .select()
      .from(searchHistory)
      .where(eq(searchHistory.repositoryId, repoA.id));
    const historyForRepoB = await testDb.db
      .select()
      .from(searchHistory)
      .where(eq(searchHistory.repositoryId, repoB.id));
    expect(historyForRepoA.length).toBe(0);
    expect(historyForRepoB.length).toBe(0);
  });

  it("q vuota (soli spazi): 400", async () => {
    const projectId = await seedProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/docs/search?q=%20%20`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${randomUUID()}/docs/search?q=ciao`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/projects/:projectId/docs/chat", () => {
  it("nuova sessione PROJECT-LEVEL (projectId valorizzato, repositoryId null), stream delta+done, persiste messaggi+citazioni", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    const genA = await seedGeneration(testDb.db, repoA.id);
    const question = "Come funziona l'autenticazione cross-repo?";
    const page = await seedPageWithChunk(testDb.db, repoA.id, genA, {
      title: "Autenticazione",
      body: "Pagina auth.",
      chunkContent: question,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: question },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = parseSse(res.payload);
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.map((e) => e.text).join("")).toBe(FAKE_DELTAS.join(""));
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    const citations = done!.citations as { slug: string; repositoryId: string }[];
    expect(citations.some((c) => c.slug === page.slug && c.repositoryId === repoA.id)).toBe(true);

    // Sessione PROJECT-LEVEL: projectId valorizzato, repositoryId NULL (CHECK XOR).
    const sessions = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, projectId));
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.repositoryId).toBeNull();
    expect(sessions[0]!.projectId).toBe(projectId);
    expect(done!.sessionId).toBe(sessions[0]!.id);

    const messages = await testDb.db
      .select()
      .from(docChatMessages)
      .where(eq(docChatMessages.sessionId, sessions[0]!.id));
    expect(messages.length).toBe(2);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe(FAKE_DELTAS.join(""));
    const stored = assistant?.citations as { slug: string; repositoryId: string }[] | null;
    expect(stored?.some((c) => c.slug === page.slug && c.repositoryId === repoA.id)).toBe(true);
  });

  it("wiring RAG cross-repo: il system prompt include il contesto di entrambi i repo", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    const repoB = await seedRepoInProject(testDb.db, projectId, "Repo Beta");
    const genA = await seedGeneration(testDb.db, repoA.id);
    const genB = await seedGeneration(testDb.db, repoB.id);
    const distinctiveA = "Il modulo Zqwauth di Alfa firma i cookie.";
    const distinctiveB = "Il modulo Zqwbilling di Beta calcola le imposte.";
    await seedPageWithChunk(testDb.db, repoA.id, genA, {
      title: "Zqwauth",
      body: distinctiveA,
      chunkContent: distinctiveA,
    });
    await seedPageWithChunk(testDb.db, repoB.id, genB, {
      title: "Zqwbilling",
      body: distinctiveB,
      chunkContent: distinctiveB,
    });

    // Query full-text che tocca entrambi (token comune "modulo").
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "modulo Zqwauth Zqwbilling" },
    });
    expect(res.statusCode).toBe(200);
    expect(lastChatInput).not.toBeNull();
    expect(lastChatInput!.system).toContain("Repo Alfa");
    expect(lastChatInput!.system).toContain("Repo Beta");
  });

  it("riusa una sessione esistente (stesso sessionId, +2 messaggi, nessuna nuova sessione)", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    await seedGeneration(testDb.db, repoA.id);

    const first = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Prima domanda." },
    });
    expect(first.statusCode).toBe(200);
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, projectId));
    expect(session).toBeDefined();

    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { sessionId: session!.id, message: "Seconda domanda." },
    });
    expect(second.statusCode).toBe(200);

    const sessions = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, projectId));
    expect(sessions.length).toBe(1);
    const messages = await testDb.db
      .select()
      .from(docChatMessages)
      .where(eq(docChatMessages.sessionId, session!.id));
    expect(messages.length).toBe(4);
  });

  it("sessione di un altro utente: 404", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    await seedGeneration(testDb.db, repoA.id);

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda del member." },
    });
    expect(created.statusCode).toBe(200);
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, projectId));

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: adminCookie },
      payload: { sessionId: session!.id, message: "Intrusione." },
    });
    expect(res.statusCode).toBe(404);
  });

  it("chat non servibile (nessun provider api_key): 503, nessun hijack/stream, nessun side-effect", async () => {
    const projectId = await seedProject(testDb.db);
    await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    availabilityOverride = { available: false, reason: "no_api_key_provider" };

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda con chat indisponibile." },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
    expect(res.json()).toMatchObject({ code: "chat_unavailable" });

    const sessions = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, projectId));
    expect(sessions.length).toBe(0);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${randomUUID()}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "ciao" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401; messaggio vuoto: 400", async () => {
    const projectId = await seedProject(testDb.db);
    const noAuth = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      payload: { message: "ciao" },
    });
    expect(noAuth.statusCode).toBe(401);

    const empty = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "" },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("errore LLM a metà stream: evento error, parziale persistito con marcatore e senza citazioni", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    const genA = await seedGeneration(testDb.db, repoA.id);
    const question = "Domanda che produrrà un errore.";
    await seedPageWithChunk(testDb.db, repoA.id, genA, {
      title: "Pagina",
      body: "Contenuto.",
      chunkContent: question,
    });

    let observedSignal: AbortSignal | undefined;
    const partial = "Risposta parz";
    streamOverride = async function* (input: ChatLlmInput): AsyncIterable<string> {
      observedSignal = input.signal;
      yield partial;
      throw new Error("LLM esploso a metà stream");
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: question },
    });
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.payload);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(observedSignal!.aborted).toBe(true);

    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, projectId));

    // La persistenza del parziale avviene DOPO `reply.raw.end()`, che è ciò che
    // sblocca `app.inject`: quando interroghiamo il DB l'insert async può non
    // essere ancora completato. Attendiamo che il messaggio assistant compaia
    // (elimina la race — era la causa del flake ricorrente in CI).
    await vi.waitFor(async () => {
      const messages = await testDb.db
        .select()
        .from(docChatMessages)
        .where(eq(docChatMessages.sessionId, session!.id));
      const assistant = messages.find((m) => m.role === "assistant");
      expect(assistant?.content.startsWith(partial)).toBe(true);
      expect(assistant?.content).toContain("[risposta interrotta]");
      expect(assistant?.citations).toBeNull();
    });
  });
});

describe("GET /api/projects/:projectId/docs/chat/sessions[/:id/messages]", () => {
  it("elenca le sessioni dell'utente e i loro messaggi, scoped a (projectId, userId)", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    await seedGeneration(testDb.db, repoA.id);

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda per lo storico." },
    });

    const sessionsRes = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/docs/chat/sessions`,
      headers: { cookie: memberCookie },
    });
    expect(sessionsRes.statusCode).toBe(200);
    const sessions = sessionsRes.json() as { id: string }[];
    expect(sessions.length).toBeGreaterThan(0);

    const messagesRes = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/docs/chat/sessions/${sessions[0]!.id}/messages`,
      headers: { cookie: memberCookie },
    });
    expect(messagesRes.statusCode).toBe(200);
    const messages = messagesRes.json() as { role: string }[];
    expect(messages.length).toBe(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");

    // L'admin non vede le sessioni del member (scoping per utente).
    const adminSessions = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/docs/chat/sessions`,
      headers: { cookie: adminCookie },
    });
    expect((adminSessions.json() as unknown[]).length).toBe(0);
  });

  it("messaggi di una sessione altrui: 404", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    await seedGeneration(testDb.db, repoA.id);
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda member." },
    });
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(and(eq(docChatSessions.projectId, projectId)));

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/docs/chat/sessions/${session!.id}/messages`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
