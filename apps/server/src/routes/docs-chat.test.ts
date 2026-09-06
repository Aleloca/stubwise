import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
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
  repoGraphs,
  repositories,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { createFakeGraphMcpClient, seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

// Stesso fake client dell'app, usato anche per pre-embeddare i chunk: un testo
// identico → vettore identico → distanza coseno 0 → quel chunk ranka primo.
const embeddingClient = createFakeEmbeddingClient();

// Fake ChatLlm: registra l'ultimo input ricevuto (per asserire il wiring RAG) e
// emette dei delta canned. I delta concatenati = "Hello from the docs assistant.".
const FAKE_DELTAS = ["Hello ", "from ", "the ", "docs ", "assistant."];
let lastChatInput: ChatLlmInput | null = null;

// Implementazione di default: delta canned, stream completo. I test error-path
// la sostituiscono via `streamOverride` (un app singolo, deterministico).
async function* defaultStream(): AsyncIterable<string> {
  for (const d of FAKE_DELTAS) {
    yield d;
  }
}

// Override per-test dello stream del fake. Se null, si usa `defaultStream`.
let streamOverride:
  | ((input: ChatLlmInput) => AsyncIterable<string>)
  | null = null;

// Override per-test del pre-flight di disponibilità. Se null, il fake è sempre
// disponibile (default): esercita il path 503 della route iniettando l'indisponibilità.
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

async function insertProject(db: Db): Promise<{ id: string; slug: string }> {
  const { repositoryId } = await seedRepository(db);
  const [repository] = await db
    .select({ slug: repositories.slug })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  return { id: repositoryId, slug: repository!.slug };
}

async function insertCurrentGeneration(db: Db, projectId: string): Promise<string> {
  const [gen] = await db
    .insert(docGenerations)
    .values({
      repositoryId: projectId,
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
    .where(eq(repositories.id, projectId));
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
      repositoryId: projectId,
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
    repositoryId: projectId,
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

describe("POST /api/repositories/:projectId/docs/chat", () => {
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
      url: `/api/repositories/${project.id}/docs/chat`,
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
      .where(eq(docChatSessions.repositoryId, project.id));
    expect(sessions.length).toBe(1);
    // Il `done` echeggia il sessionId creato: il client lo persiste per il
    // multi-turn (riusa la stessa sessione nei turni successivi).
    expect(done!.sessionId).toBe(sessions[0]!.id);

    // L'insert del messaggio assistant avviene DOPO la chiusura dello stream
    // (vedi docs-chat-core.ts): app.inject risolve alla chiusura, quindi su una
    // macchina lenta questa lettura può correre con l'insert. Si attende.
    const messages = await vi.waitFor(async () => {
      const rows = await testDb.db
        .select()
        .from(docChatMessages)
        .where(eq(docChatMessages.sessionId, sessions[0]!.id));
      expect(rows.length).toBe(2);
      return rows;
    });
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
      url: `/api/repositories/${project.id}/docs/chat`,
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
      url: `/api/repositories/${project.id}/docs/chat`,
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
      url: `/api/repositories/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Prima domanda." },
    });
    expect(first.statusCode).toBe(200);
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.repositoryId, project.id));
    expect(session).toBeDefined();

    // Seconda chiamata con lo stesso sessionId: nessuna nuova sessione, +2 messaggi.
    const second = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { sessionId: session!.id, message: "Seconda domanda." },
    });
    expect(second.statusCode).toBe(200);

    const sessions = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.repositoryId, project.id));
    expect(sessions.length).toBe(1);

    // Come sopra: l'insert dell'assistant segue la chiusura dello stream.
    await vi.waitFor(async () => {
      const messages = await testDb.db
        .select()
        .from(docChatMessages)
        .where(eq(docChatMessages.sessionId, session!.id));
      expect(messages.length).toBe(4);
    });
  });

  it("sessionId di un altro utente: 404 (ownership verificata)", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    // Sessione creata dal member.
    const created = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda del member." },
    });
    expect(created.statusCode).toBe(200);
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.repositoryId, project.id));

    // L'admin prova a usare la sessione del member → 404.
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
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
      url: `/api/repositories/${projectA.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda nel progetto A." },
    });
    expect(created.statusCode).toBe(200);
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.repositoryId, projectA.id));

    // Stessa sessione, ma sotto projectB → 404.
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${projectB.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { sessionId: session!.id, message: "Cross-project." },
    });
    expect(res.statusCode).toBe(404);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/chat",
      headers: { cookie: memberCookie },
      payload: { message: "ciao" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("chat non servibile (nessun provider api_key): 503 chat_unavailable, nessun hijack/stream", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);
    // Pre-flight riporta indisponibile: la route deve rispondere con un 503 JSON
    // pulito PRIMA di aprire lo stream SSE.
    availabilityOverride = { available: false, reason: "no_api_key_provider" };

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Una domanda con chat indisponibile." },
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
    expect(res.json()).toMatchObject({ code: "chat_unavailable" });

    // Nessun side-effect: niente sessione né messaggi persistiti (il pre-flight
    // precede l'insert del messaggio utente e la creazione della sessione).
    const sessions = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.repositoryId, project.id));
    expect(sessions.length).toBe(0);
  });

  it("senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
      payload: { message: "ciao" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("messaggio vuoto: 400 (validazione Zod)", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("errore LLM a metà stream: evento `error`, parziale persistito con marcatore e SENZA citazioni, signal abortito", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertCurrentGeneration(testDb.db, project.id);
    const question = "Domanda che produrrà un errore a metà stream.";
    const page = await insertPageWithChunk(testDb.db, project.id, genId, {
      title: "Pagina recuperata",
      body: "Contenuto.",
      chunkContent: question,
    });

    // Fake che emette UN delta poi lancia. Osserva il signal DOPO il throw, così
    // possiamo asserire che la route abbia abortito la generazione sottostante.
    let observedSignal: AbortSignal | undefined;
    const partial = "Risposta parz";
    streamOverride = async function* (input: ChatLlmInput): AsyncIterable<string> {
      observedSignal = input.signal;
      yield partial;
      throw new Error("LLM esploso a metà stream");
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: question },
    });
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.payload);
    // Il delta parziale è stato inoltrato...
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.map((e) => e.text).join("")).toBe(partial);
    // ...poi un evento `error` (e NESSUN `done`).
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);

    // La route ha abortito il signal passato all'LLM (stop al consumo di token).
    expect(observedSignal).toBeDefined();
    expect(observedSignal!.aborted).toBe(true);

    // Persistenza: il messaggio assistant è il parziale + marcatore, citations null.
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.repositoryId, project.id));
    // L'insert del parziale avviene DOPO reply.raw.end() (docs-chat-core.ts):
    // senza attesa questa lettura è una race persa sui runner lenti (flake CI).
    const assistant = await vi.waitFor(async () => {
      const messages = await testDb.db
        .select()
        .from(docChatMessages)
        .where(eq(docChatMessages.sessionId, session!.id));
      const row = messages.find((m) => m.role === "assistant");
      expect(row).toBeDefined();
      return row!;
    });
    expect(assistant.content.startsWith(partial)).toBe(true);
    expect(assistant.content).toContain("[risposta interrotta]");
    expect(assistant.citations).toBeNull();
    // La pagina era recuperabile (citazioni esistono), ma NON sono attaccate al parziale.
    expect(page.slug).toBeTruthy();
  });

  it("errore LLM al PRIMO delta (nessun testo accumulato): evento `error`, nessun messaggio assistant persistito", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    streamOverride = async function* (): AsyncIterable<string> {
      // Generatore che lancia prima di qualsiasi yield: nessun delta emesso.
      if (Date.now() >= 0) throw new Error("LLM esploso subito");
      yield "mai";
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda che fallisce subito." },
    });
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.payload);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "delta")).toBe(false);

    // Nessun parziale → nessun messaggio assistant (solo il messaggio utente).
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.repositoryId, project.id));
    const messages = await testDb.db
      .select()
      .from(docChatMessages)
      .where(eq(docChatMessages.sessionId, session!.id));
    expect(messages.some((m) => m.role === "assistant")).toBe(false);
    expect(messages.filter((m) => m.role === "user").length).toBe(1);
  });
});

describe("POST /api/repositories/:repositoryId/docs/chat?stream=false (fase 4, mobile)", () => {
  it("risponde 200 application/json {answer, sources, sessionId}; il messaggio assistant è persistito come nel caso SSE", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertCurrentGeneration(testDb.db, project.id);
    const question = "Domanda in modalità JSON non-streaming.";
    const page = await insertPageWithChunk(testDb.db, project.id, genId, {
      title: "Pagina JSON",
      body: "Contenuto.",
      chunkContent: question,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat?stream=false`,
      headers: { cookie: memberCookie },
      payload: { message: question },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = res.json() as { answer: string; sources: { slug: string }[]; sessionId: string };
    expect(body.answer).toBe(FAKE_DELTAS.join(""));
    expect(body.sources.some((s) => s.slug === page.slug)).toBe(true);

    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.repositoryId, project.id));
    expect(body.sessionId).toBe(session!.id);

    // Persistito esattamente come nel caso SSE: 2 messaggi (user + assistant),
    // l'assistant col testo intero e le citazioni.
    const messages = await testDb.db
      .select()
      .from(docChatMessages)
      .where(eq(docChatMessages.sessionId, session!.id));
    expect(messages.length).toBe(2);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe(FAKE_DELTAS.join(""));
    const stored = assistant?.citations as { slug: string }[] | null;
    expect(stored?.some((c) => c.slug === page.slug)).toBe(true);
  });

  it("errore LLM a metà: 502 {code, message}, NESSUNA persistenza (a differenza dell'SSE che appende il TRUNCATION_MARKER)", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    streamOverride = async function* (): AsyncIterable<string> {
      yield "parziale che non deve arrivare da nessuna parte";
      throw new Error("LLM esploso a metà (json)");
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat?stream=false`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda che fallisce a metà." },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json() as { code?: string; message: string };
    expect(body.code).toBe("chat_generation_failed");

    // Nessun messaggio assistant: né il completo né un parziale con marcatore
    // (quel comportamento è SOLO dell'SSE, vedi docs-chat-core.ts).
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.repositoryId, project.id));
    const messages = await testDb.db
      .select()
      .from(docChatMessages)
      .where(eq(docChatMessages.sessionId, session!.id));
    expect(messages.some((m) => m.role === "assistant")).toBe(false);
    expect(messages.filter((m) => m.role === "user").length).toBe(1);
  });

  it("default additivo: senza il parametro `stream` la rotta resta SSE (comportamento di sempre)", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda senza il parametro stream." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
  });

  it("?stream=maybe: 400 di validazione Zod (valore non fra quelli accettati)", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat?stream=maybe`,
      headers: { cookie: memberCookie },
      payload: { message: "ciao" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("chat non servibile (nessun provider api_key): 503 PRIMA di consumare l'LLM, anche in modalità json", async () => {
    availabilityOverride = { available: false };
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat?stream=false`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda con chat indisponibile." },
    });
    expect(res.statusCode).toBe(503);
  });

  it("sessionId di un altro utente: 404 (stessa ownership della sse, invariata da ?stream)", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    const created = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda del member." },
    });
    const doneEvent = parseSse(created.payload).find((e) => e.type === "done");
    const session = doneEvent!.sessionId as string;

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat?stream=false`,
      headers: { cookie: adminCookie },
      payload: { sessionId: session, message: "Intrusione in json." },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/repositories/:projectId/docs/chat/sessions[/:id/messages]", () => {
  it("elenca le sessioni dell'utente e i loro messaggi", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);

    await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda per lo storico." },
    });

    const sessionsRes = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/chat/sessions`,
      headers: { cookie: memberCookie },
    });
    expect(sessionsRes.statusCode).toBe(200);
    const sessions = sessionsRes.json() as { id: string }[];
    expect(sessions.length).toBeGreaterThan(0);

    const messagesRes = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/chat/sessions/${sessions[0]!.id}/messages`,
      headers: { cookie: memberCookie },
    });
    expect(messagesRes.statusCode).toBe(200);
    const messages = messagesRes.json() as { id: string; role: string; content: string }[];
    expect(messages.length).toBe(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    // Ogni messaggio espone l'`id` (chiave React lato client).
    expect(messages.every((m) => typeof m.id === "string" && m.id.length > 0)).toBe(true);
  });

  it("messaggi di una sessione altrui: 404", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);
    await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Domanda member." },
    });
    const [session] = await testDb.db
      .select()
      .from(docChatSessions)
      .where(eq(docChatSessions.repositoryId, project.id));

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/chat/sessions/${session!.id}/messages`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/repositories/:repositoryId/docs/chat — retrieval dal grafo (fase 2b)", () => {
  /**
   * Sottografo finto: volutamente SENZA righe `NODE ... [src=... loc=L..]`, così
   * il parser non produce ancore e l'estrattore di snippet non lancia `git` su
   * un mirror inesistente. Qui si verifica l'INNESTO nel prompt, non la lettura
   * dai mirror (coperta da snippets.test.ts su un bare repo vero).
   */
  const FAKE_SUBGRAPH = "TRAVERSAL da 'sessione' (2 nodi)\nEDGE login() -> createSession()";

  /** Accende il toggle e registra un grafo dello stato dato per il repository. */
  async function seedGraph(
    db: Db,
    repositoryId: string,
    values: Partial<typeof repoGraphs.$inferInsert> = {},
  ): Promise<void> {
    await db
      .update(repositories)
      .set({ graphEnabled: true })
      .where(eq(repositories.id, repositoryId));
    await db
      .insert(repoGraphs)
      .values({ repositoryId, status: "done", commitSha: "abcdef1234567890", ...values });
  }

  async function ask(repositoryId: string, message: string): Promise<number> {
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/docs/chat`,
      headers: { cookie: memberCookie },
      payload: { message },
    });
    return res.statusCode;
  }

  it("grafo done: il blocco entra nel system DOPO le pagine, con la domanda corrente", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertCurrentGeneration(testDb.db, project.id);
    const question = "Chi crea la sessione al login?";
    await insertPageWithChunk(testDb.db, project.id, genId, {
      title: "Sessioni",
      body: "Pagina sessioni.",
      chunkContent: question,
    });
    await seedGraph(testDb.db, project.id);
    fakeGraphClient.response = FAKE_SUBGRAPH;

    expect(await ask(project.id, question)).toBe(200);

    const system = lastChatInput!.system;
    expect(system).toContain("STRUTTURA DEL CODICE");
    expect(system).toContain(FAKE_SUBGRAPH);
    // ORDINE: il blocco cita "la documentazione recuperata sopra", quindi deve
    // stare DOPO il contesto documentale.
    expect(system.indexOf("--- CONTESTO RECUPERATO ---")).toBeLessThan(
      system.indexOf("STRUTTURA DEL CODICE"),
    );

    // Una sola query, con la DOMANDA UTENTE e il project_path del repository.
    expect(fakeGraphClient.calls.length).toBe(1);
    expect(fakeGraphClient.calls[0]!.question).toBe(question);
    expect(fakeGraphClient.calls[0]!.projectPath).toBe(`/graphs/${project.id}`);
  });

  it("nessun grafo per il repository: system senza blocco, chat normale", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);
    fakeGraphClient.response = FAKE_SUBGRAPH;

    expect(await ask(project.id, "Chi crea la sessione al login?")).toBe(200);

    expect(lastChatInput!.system).not.toContain("STRUTTURA DEL CODICE");
    // Gating in SQL: senza riga repo_graphs non si interroga nemmeno graphify.
    expect(fakeGraphClient.calls.length).toBe(0);
  });

  it("grafo done ma query a vuoto (graphify giù / grafo vuoto): system senza blocco", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);
    await seedGraph(testDb.db, project.id);
    // Il client fail-open ritorna null: la chat non deve accorgersene.
    fakeGraphClient.response = null;

    expect(await ask(project.id, "Chi crea la sessione al login?")).toBe(200);

    expect(fakeGraphClient.calls.length).toBe(1);
    expect(lastChatInput!.system).not.toContain("STRUTTURA DEL CODICE");
  });

  it("toggle graphEnabled spento (grafo done residuo): non si interroga il grafo", async () => {
    const project = await insertProject(testDb.db);
    await insertCurrentGeneration(testDb.db, project.id);
    await seedGraph(testDb.db, project.id);
    await testDb.db
      .update(repositories)
      .set({ graphEnabled: false })
      .where(eq(repositories.id, project.id));
    fakeGraphClient.response = FAKE_SUBGRAPH;

    expect(await ask(project.id, "Chi crea la sessione al login?")).toBe(200);

    expect(fakeGraphClient.calls.length).toBe(0);
    expect(lastChatInput!.system).not.toContain("STRUTTURA DEL CODICE");
  });
});
