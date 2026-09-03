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
  repoGraphs,
  repositories,
  searchHistory,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { createFakeGraphMcpClient, seedUsers } from "../test/fixtures.js";

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

// Client MCP finto verso graphify (fase 2b): nessuna rete, risponde a comando.
const fakeGraphClient = createFakeGraphMcpClient();

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
    graphMcpClient: fakeGraphClient,
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
  fakeGraphClient.reset();
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

describe("GET /api/projects/:projectId/docs/highlights", () => {
  it("changelog unificato cross-repo per data desc, topViewed aggregato, conteggi per kind", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    const repoB = await seedRepoInProject(testDb.db, projectId, "Repo Beta");
    const genA = await seedGeneration(testDb.db, repoA.id);
    const genB = await seedGeneration(testDb.db, repoB.id);

    // Pagine viste: la più vista sta in Beta.
    await testDb.db.insert(docPages).values([
      {
        repositoryId: repoA.id,
        generationId: genA,
        kind: "technical",
        slug: "alfa-arch",
        title: "Architettura Alfa",
        body: "x",
        viewCount: 5,
      },
      {
        repositoryId: repoB.id,
        generationId: genB,
        kind: "product",
        slug: "beta-start",
        title: "Beta Getting Started",
        body: "x",
        viewCount: 30,
      },
    ]);

    // Release nei due repo con date diverse (createdAt esplicito).
    await testDb.db.insert(docPages).values([
      {
        repositoryId: repoA.id,
        generationId: null,
        kind: "releases",
        slug: "release-20260720-0900-aaa1111",
        title: "Alfa vecchia",
        body: "note",
        position: -20,
        significant: false,
        createdAt: new Date("2026-07-20T09:00:00Z"),
      },
      {
        repositoryId: repoB.id,
        generationId: null,
        kind: "releases",
        slug: "release-20260724-1200-bbb2222",
        title: "Beta recente",
        body: "note",
        position: -10,
        significant: true,
        createdAt: new Date("2026-07-24T12:00:00Z"),
      },
    ]);

    // Un altro progetto che NON deve contaminare l'aggregato.
    const otherProject = await seedProject(testDb.db);
    const otherRepo = await seedRepoInProject(testDb.db, otherProject, "Estraneo");
    await testDb.db.insert(docPages).values({
      repositoryId: otherRepo.id,
      generationId: null,
      kind: "releases",
      slug: "release-20260726-0800-ccc3333",
      title: "Release estranea",
      body: "note",
      position: -5,
      createdAt: new Date("2026-07-26T08:00:00Z"),
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/docs/highlights`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      countsByKind: Record<string, number>;
      topViewed: { slug: string; repositoryId: string; repositoryName: string; kind: string }[];
      latestReleases: {
        slug: string;
        title: string;
        createdAt: string;
        significant: boolean | null;
        repositoryId: string;
        repositoryName: string;
      }[];
    };

    expect(body.countsByKind.technical).toBe(1);
    expect(body.countsByKind.product).toBe(1);
    expect(body.countsByKind.releases).toBe(2);

    // Changelog cross-repo per createdAt desc, solo repo del progetto.
    expect(body.latestReleases.map((r) => r.slug)).toEqual([
      "release-20260724-1200-bbb2222",
      "release-20260720-0900-aaa1111",
    ]);
    expect(body.latestReleases[0]!.repositoryName).toBe("Repo Beta");
    expect(body.latestReleases[0]!.significant).toBe(true);

    // topViewed aggregato: la pagina più vista del progetto, col repo d'origine.
    expect(body.topViewed[0]!.slug).toBe("beta-start");
    expect(body.topViewed[0]!.repositoryId).toBe(repoB.id);
    expect(body.topViewed.some((p) => p.kind === "releases")).toBe(false);
  });

  it("progetto senza repo: conteggi a zero e liste vuote", async () => {
    const projectId = await seedProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/docs/highlights`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      countsByKind: Record<string, number>;
      topViewed: unknown[];
      latestReleases: unknown[];
    };
    expect(body.countsByKind.releases).toBe(0);
    expect(body.topViewed).toEqual([]);
    expect(body.latestReleases).toEqual([]);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${randomUUID()}/docs/highlights`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const projectId = await seedProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/docs/highlights`,
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

describe("POST /api/projects/:projectId/docs/chat?stream=false (fase 4, mobile)", () => {
  it("risponde 200 application/json {answer, sources, sessionId} cross-repo; persistito come nel caso SSE", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    const genA = await seedGeneration(testDb.db, repoA.id);
    const question = "Domanda cross-repo in modalità JSON.";
    const page = await seedPageWithChunk(testDb.db, repoA.id, genA, {
      title: "Pagina JSON progetto",
      body: "Contenuto.",
      chunkContent: question,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat?stream=false`,
      headers: { cookie: memberCookie },
      payload: { message: question },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = res.json() as {
      answer: string;
      sources: { slug: string; repositoryId: string }[];
      sessionId: string;
    };
    expect(body.answer).toBe(FAKE_DELTAS.join(""));
    expect(body.sources.some((s) => s.slug === page.slug && s.repositoryId === repoA.id)).toBe(
      true,
    );

    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, projectId));
    expect(body.sessionId).toBe(session!.id);
    // Sessione project-level anche in modalità json: projectId valorizzato, repositoryId NULL.
    expect(session!.repositoryId).toBeNull();

    const messages = await testDb.db
      .select()
      .from(docChatMessages)
      .where(eq(docChatMessages.sessionId, session!.id));
    expect(messages.length).toBe(2);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe(FAKE_DELTAS.join(""));
  });

  it("errore LLM a metà: 502, NESSUNA persistenza (a differenza dell'SSE)", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    await seedGeneration(testDb.db, repoA.id);

    streamOverride = async function* (): AsyncIterable<string> {
      yield "parziale progetto";
      throw new Error("LLM esploso a metà (project, json)");
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat?stream=false`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda che fallisce a metà." },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { code?: string }).code).toBe("chat_generation_failed");

    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, projectId));
    const messages = await testDb.db
      .select()
      .from(docChatMessages)
      .where(eq(docChatMessages.sessionId, session!.id));
    expect(messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("default additivo: senza `stream` resta SSE", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    await seedGeneration(testDb.db, repoA.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda senza stream." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
  });

  it("sessionId di un altro progetto: 404 (ownership invariata da ?stream)", async () => {
    const projectA = await seedProject(testDb.db);
    const projectB = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectA, "Repo Alfa");
    await seedGeneration(testDb.db, repoA.id);

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectA}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda nel progetto A." },
    });
    const session = parseSse(created.payload).find((e) => e.type === "done")!.sessionId as string;

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectB}/docs/chat?stream=false`,
      headers: { cookie: memberCookie },
      payload: { sessionId: session, message: "Cross-project in json." },
    });
    expect(res.statusCode).toBe(404);
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

describe("POST /api/projects/:projectId/docs/chat — retrieval dal grafo (fase 2b)", () => {
  /** Sottografo finto senza righe `NODE`: nessuna lettura dai mirror nei test. */
  const FAKE_SUBGRAPH = "TRAVERSAL da 'fatturazione' (3 nodi)\nEDGE invoice() -> total()";

  /** Accende il toggle e registra un grafo `done` per il repository. */
  async function seedGraph(db: Db, repositoryId: string): Promise<void> {
    await db
      .update(repositories)
      .set({ graphEnabled: true })
      .where(eq(repositories.id, repositoryId));
    await db
      .insert(repoGraphs)
      .values({ repositoryId, status: "done", commitSha: "abcdef1234567890" });
  }

  it("un repo del progetto col grafo done: blocco nel system, dopo le pagine", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    const genA = await seedGeneration(testDb.db, repoA.id);
    const question = "Dove si calcola il totale della fattura?";
    await seedPageWithChunk(testDb.db, repoA.id, genA, {
      title: "Fatturazione",
      body: "Pagina fatture.",
      chunkContent: question,
    });
    await seedGraph(testDb.db, repoA.id);
    fakeGraphClient.response = FAKE_SUBGRAPH;

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: question },
    });
    expect(res.statusCode).toBe(200);

    const system = lastChatInput!.system;
    expect(system).toContain("STRUTTURA DEL CODICE");
    expect(system).toContain(FAKE_SUBGRAPH);
    // Nella variante di progetto ogni blocco è etichettato col repository.
    expect(system).toContain('=== Repository "Repo Alfa" ===');
    expect(system.indexOf("--- CONTESTO RECUPERATO ---")).toBeLessThan(
      system.indexOf("STRUTTURA DEL CODICE"),
    );
    expect(fakeGraphClient.calls.length).toBe(1);
    expect(fakeGraphClient.calls[0]!.question).toBe(question);
    expect(fakeGraphClient.calls[0]!.projectPath).toBe(`/graphs/${repoA.id}`);
  });

  it("due repo col grafo: una query per repo, budget diviso, blocchi in ordine di nome", async () => {
    const projectId = await seedProject(testDb.db);
    const repoB = await seedRepoInProject(testDb.db, projectId, "Repo Beta");
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    await seedGraph(testDb.db, repoA.id);
    await seedGraph(testDb.db, repoB.id);
    fakeGraphClient.response = FAKE_SUBGRAPH;

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Come sono collegati i due moduli?" },
    });
    expect(res.statusCode).toBe(200);

    expect(fakeGraphClient.calls.length).toBe(2);
    // Budget di default (1200) diviso per i repo interrogati: il prompt resta
    // della taglia della chat per-repo.
    expect(fakeGraphClient.calls.every((c) => c.tokenBudget === 600)).toBe(true);
    const system = lastChatInput!.system;
    expect(system.indexOf('=== Repository "Repo Alfa" ===')).toBeLessThan(
      system.indexOf('=== Repository "Repo Beta" ==='),
    );
  });

  it("nessun repo col grafo: system senza blocco e nessuna query", async () => {
    const projectId = await seedProject(testDb.db);
    const repoA = await seedRepoInProject(testDb.db, projectId, "Repo Alfa");
    await seedGeneration(testDb.db, repoA.id);
    fakeGraphClient.response = FAKE_SUBGRAPH;

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Dove si calcola il totale della fattura?" },
    });
    expect(res.statusCode).toBe(200);

    expect(fakeGraphClient.calls.length).toBe(0);
    expect(lastChatInput!.system).not.toContain("STRUTTURA DEL CODICE");
  });
});
