import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { buildApp } from "../app.js";
import type { ChatLlm, ChatLlmInput } from "./chat-llm.js";
import {
  docChatMessages,
  docChatSessions,
  docChunks,
  docGenerations,
  docPages,
  projects,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedGitAccount, startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

// Stesso fake client dell'app, usato anche per pre-embeddare i chunk: un testo
// identico → vettore identico → distanza coseno 0 → quel chunk ranka primo.
const embeddingClient = createFakeEmbeddingClient();

// Fake ChatLlm: registra l'ultimo input ricevuto (per asserire il wiring RAG) e
// emette dei delta canned. I delta concatenati = "Hello from the docs assistant.".
const FAKE_DELTAS = ["Hello ", "from ", "the ", "docs ", "assistant."];
let lastChatInput: ChatLlmInput | null = null;
const fakeChatLlm: ChatLlm = {
  async *stream(input: ChatLlmInput): AsyncIterable<string> {
    lastChatInput = input;
    for (const d of FAKE_DELTAS) {
      yield d;
    }
  },
};

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

let projectSeq = 0;

async function insertProject(db: Db): Promise<{ id: string; slug: string }> {
  projectSeq++;
  const slug = `docs-chat-proj-${projectSeq}`;
  const gitAccountId = await seedGitAccount(db);
  const [project] = await db
    .insert(projects)
    .values({
      name: `Docs Chat Project ${projectSeq}`,
      slug,
      provider: "github",
      gitAccountId,
      repoUrl: "https://github.com/acme/demo",
      defaultBranch: "main",
      ingestionKey: `ingestion-${slug}`,
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  return { id: project.id, slug: project.slug };
}

async function insertCurrentGeneration(db: Db, projectId: string): Promise<string> {
  const [gen] = await db
    .insert(docGenerations)
    .values({
      projectId,
      status: "succeeded",
      commitSha: randomBytes(4).toString("hex"),
      trigger: "manual",
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning();
  if (!gen) throw new Error("insert della generazione non ha restituito la riga");
  await db.update(projects).set({ currentDocGenerationId: gen.id }).where(eq(projects.id, projectId));
  return gen.id;
}

let pageSeq = 0;

async function insertPageWithChunk(
  db: Db,
  projectId: string,
  generationId: string,
  page: { title: string; body: string; chunkContent: string },
): Promise<{ slug: string; title: string }> {
  pageSeq++;
  const [row] = await db
    .insert(docPages)
    .values({
      projectId,
      generationId,
      kind: "technical",
      slug: `chat-page-${pageSeq}`,
      title: page.title,
      body: page.body,
      isManual: false,
    })
    .returning();
  if (!row) throw new Error("insert della pagina non ha restituito la riga");

  const [vector] = await embeddingClient.embed([page.chunkContent]);
  await db.insert(docChunks).values({
    pageId: row.id,
    projectId,
    generationId,
    content: page.chunkContent,
    embedding: vector,
  });
  return { slug: row.slug, title: row.title };
}

/** Parsa il payload SSE grezzo in array di eventi (i `data: {...}` parsati). */
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
});

describe("POST /api/projects/:projectId/docs/chat", () => {
  it("nuova sessione: stremma i delta + done con citazioni, persiste sessione e 2 messaggi", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertCurrentGeneration(testDb.db, project.id);
    const question = "Come funziona l'autenticazione con cookie di sessione?";
    const page = await insertPageWithChunk(testDb.db, project.id, genId, {
      title: "Autenticazione",
      body: "Pagina auth.",
      // Il chunk coincide con la domanda → match semantico perfetto → citata.
      chunkContent: question,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/chat`,
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
    const citations = done!.citations as { slug: string; title: string }[];
    expect(citations.some((c) => c.slug === page.slug && c.title === page.title)).toBe(true);

    // Persistenza: 1 sessione, 2 messaggi (user + assistant).
    const sessions = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, project.id));
    expect(sessions.length).toBe(1);

    const messages = await testDb.db
      .select()
      .from(docChatMessages)
      .where(eq(docChatMessages.sessionId, sessions[0]!.id));
    expect(messages.length).toBe(2);
    const user = messages.find((m) => m.role === "user");
    const assistant = messages.find((m) => m.role === "assistant");
    expect(user?.content).toBe(question);
    // Contenuto assistant = delta concatenati.
    expect(assistant?.content).toBe(FAKE_DELTAS.join(""));
    // Citazioni persistite e riferiscono la pagina recuperata.
    const stored = assistant?.citations as { slug: string }[] | null;
    expect(stored?.some((c) => c.slug === page.slug)).toBe(true);
  });

  it("wiring RAG: il contesto recuperato è passato al ChatLlm nel system prompt", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertCurrentGeneration(testDb.db, project.id);
    const distinctive = "Il modulo Zqwpayments gestisce gli incassi ricorrenti.";
    const page = await insertPageWithChunk(testDb.db, project.id, genId, {
      title: "Pagamenti Zqwpayments",
      body: distinctive,
      chunkContent: distinctive,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: distinctive },
    });
    expect(res.statusCode).toBe(200);

    // Il fake ha ricevuto il system prompt col contenuto del chunk e il titolo.
    expect(lastChatInput).not.toBeNull();
    expect(lastChatInput!.system).toContain(distinctive);
    expect(lastChatInput!.system).toContain(page.title);
    // Lo storico passato include la domanda corrente in coda (role user).
    const last = lastChatInput!.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toBe(distinctive);
  });

  it("anti-allucinazione + doppio registro: il system prompt contiene le istruzioni esplicite", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Una domanda qualsiasi senza contesto rilevante." },
    });
    expect(res.statusCode).toBe(200);

    const system = lastChatInput!.system;
    // Anti-allucinazione: rispondere solo dal contesto / dirlo se non basta.
    expect(system).toContain("SOLO DAL CONTESTO");
    expect(system.toLowerCase()).toContain("non inventare");
    // Doppio registro: tecnico vs capability.
    expect(system).toContain("TECNICA");
    expect(system).toContain("CAPABILITY");
    // Citazioni richieste.
    expect(system).toContain("CITA SEMPRE");
  });

  it("sessionId esistente: riusa la sessione e appende i messaggi (niente nuova sessione)", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    // Prima chiamata: crea la sessione.
    const first = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Prima domanda." },
    });
    expect(first.statusCode).toBe(200);
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, project.id));
    expect(session).toBeDefined();

    // Seconda chiamata con lo stesso sessionId: nessuna nuova sessione, +2 messaggi.
    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { sessionId: session!.id, message: "Seconda domanda." },
    });
    expect(second.statusCode).toBe(200);

    const sessions = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, project.id));
    expect(sessions.length).toBe(1);

    const messages = await testDb.db
      .select()
      .from(docChatMessages)
      .where(eq(docChatMessages.sessionId, session!.id));
    expect(messages.length).toBe(4);
  });

  it("sessionId di un altro utente: 404 (ownership verificata)", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    // Sessione creata dal member.
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda del member." },
    });
    expect(created.statusCode).toBe(200);
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, project.id));

    // L'admin prova a usare la sessione del member → 404.
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/chat`,
      headers: { cookie: adminCookie },
      payload: { sessionId: session!.id, message: "Intrusione." },
    });
    expect(res.statusCode).toBe(404);
  });

  it("sessionId di un altro progetto: 404", async () => {
    const projectA = await insertProject(testDb.db);
    const projectB = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, projectA.id);

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectA.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda nel progetto A." },
    });
    expect(created.statusCode).toBe(200);
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, projectA.id));

    // Stessa sessione, ma sotto projectB → 404.
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectB.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { sessionId: session!.id, message: "Cross-project." },
    });
    expect(res.statusCode).toBe(404);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/docs/chat",
      headers: { cookie: memberCookie },
      payload: { message: "ciao" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/chat`,
      payload: { message: "ciao" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("messaggio vuoto: 400 (validazione Zod)", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/projects/:projectId/docs/chat/sessions[/:id/messages]", () => {
  it("elenca le sessioni dell'utente e i loro messaggi", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda per lo storico." },
    });

    const sessionsRes = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/chat/sessions`,
      headers: { cookie: memberCookie },
    });
    expect(sessionsRes.statusCode).toBe(200);
    const sessions = sessionsRes.json() as { id: string }[];
    expect(sessions.length).toBeGreaterThan(0);

    const messagesRes = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/chat/sessions/${sessions[0]!.id}/messages`,
      headers: { cookie: memberCookie },
    });
    expect(messagesRes.statusCode).toBe(200);
    const messages = messagesRes.json() as { role: string; content: string }[];
    expect(messages.length).toBe(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
  });

  it("messaggi di una sessione altrui: 404", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda member." },
    });
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.projectId, project.id));

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/chat/sessions/${session!.id}/messages`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
