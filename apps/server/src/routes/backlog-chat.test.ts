import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import {
  backlogChatMessages,
  backlogItems,
  backlogItemTickets,
  backlogJobs,
  projects,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import type { ChatAvailability, ChatLlm, ChatLlmInput } from "./chat-llm.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

const embeddingClient = createFakeEmbeddingClient();

// Fake ChatLlm: registra l'ultimo input (per asserire history/prompt) e emette
// delta canned. I test error/one-shot lo sostituiscono via `streamOverride`.
const FAKE_DELTAS = ["Ciao ", "dal ", "backlog."];
let lastChatInput: ChatLlmInput | null = null;
let streamOverride: ((input: ChatLlmInput) => AsyncIterable<string>) | null = null;
let availabilityOverride: ChatAvailability | null = null;

async function* defaultStream(): AsyncIterable<string> {
  for (const d of FAKE_DELTAS) yield d;
}

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
let projectId: string;

/** Parsa il payload SSE grezzo in array di eventi (i `data: {...}`). */
function parseSse(payload: string): { type: string; [k: string]: unknown }[] {
  return payload
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string });
}

async function insertItem(
  overrides: Partial<typeof backlogItems.$inferInsert> = {},
): Promise<typeof backlogItems.$inferSelect> {
  const [row] = await testDb.db
    .insert(backlogItems)
    .values({ projectId, title: "Voce di test", source: "manual", ...overrides })
    .returning();
  return row!;
}

async function readMessages(
  itemId: string,
): Promise<{ role: string; content: string; citations: unknown }[]> {
  return testDb.db
    .select({
      role: backlogChatMessages.role,
      content: backlogChatMessages.content,
      citations: backlogChatMessages.citations,
    })
    .from(backlogChatMessages)
    .where(eq(backlogChatMessages.itemId, itemId))
    .orderBy(asc(backlogChatMessages.createdAt), asc(backlogChatMessages.id));
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

beforeEach(async () => {
  lastChatInput = null;
  streamOverride = null;
  availabilityOverride = null;
  ({ projectId } = await seedRepository(testDb.db));
});

afterEach(async () => {
  await testDb.db.delete(backlogChatMessages);
  await testDb.db.delete(backlogItemTickets);
  await testDb.db.delete(backlogJobs);
  await testDb.db.delete(backlogItems);
  await testDb.db.delete(tickets);
  await testDb.db.delete(projects);
});

describe("POST /api/backlog/:id/chat", () => {
  it("senza sessione → 401", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/chat`,
      payload: { message: "ciao" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 se la voce non esiste", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${crypto.randomUUID()}/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "ciao" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("chat non servibile: 503, nessun messaggio persistito", async () => {
    const item = await insertItem();
    availabilityOverride = { available: false, reason: "no_api_key_provider" };
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "ciao" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toMatchObject({ code: "chat_unavailable" });
    expect(await readMessages(item.id)).toHaveLength(0);
  });

  it("stremma i delta + done, persiste user e assistant, porta new→refining", async () => {
    const item = await insertItem({ status: "new" });
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "Come funziona questa idea?" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = parseSse(res.payload);
    expect(events.filter((e) => e.type === "delta").map((e) => e.text).join("")).toBe(
      FAKE_DELTAS.join(""),
    );
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    // La voce è la sessione: il done echeggia l'id della voce.
    expect(done!.sessionId).toBe(item.id);

    // La transizione avviene in modo sincrono, prima dello streaming.
    const [row] = await testDb.db
      .select({ status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, item.id));
    expect(row!.status).toBe("refining");

    // L'assistant è persistito DOPO la chiusura dello stream.
    const messages = await vi.waitFor(async () => {
      const rows = await readMessages(item.id);
      expect(rows).toHaveLength(2);
      return rows;
    });
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("Come funziona questa idea?");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toBe(FAKE_DELTAS.join(""));
  });

  it("stato non-new: non regredisce (ready resta ready)", async () => {
    const item = await insertItem({ status: "ready" });
    await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "domanda" },
    });
    const [row] = await testDb.db
      .select({ status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, item.id));
    expect(row!.status).toBe("ready");
  });

  it("history: i messaggi system sono inclusi come user con prefisso [system]", async () => {
    const item = await insertItem({ status: "refining" });
    await testDb.db.insert(backlogChatMessages).values([
      { itemId: item.id, role: "user", content: "prima domanda", createdAt: new Date("2026-01-01T08:00:00Z") },
      { itemId: item.id, role: "assistant", content: "prima risposta", createdAt: new Date("2026-01-01T08:01:00Z") },
      { itemId: item.id, role: "system", content: "Esito deep dive: fattibile", createdAt: new Date("2026-01-01T08:02:00Z") },
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "nuova domanda" },
    });
    expect(res.statusCode).toBe(200);

    expect(lastChatInput).not.toBeNull();
    const msgs = lastChatInput!.messages;
    // Il messaggio system è incluso come user con prefisso [system]; fuso con la
    // domanda corrente (ruoli alternati) → ultimo turno user contiene entrambi.
    expect(msgs.some((m) => m.role === "user" && m.content.includes("[system] Esito deep dive"))).toBe(true);
    const last = msgs.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("nuova domanda");
    // Titolo/documento/metadati nel system prompt.
    expect(lastChatInput!.system).toContain(item.title);
  });

  it("errore LLM a metà stream: parziale persistito con marcatore e citations null", async () => {
    const item = await insertItem({ status: "refining" });
    const partial = "Risposta parz";
    streamOverride = async function* (): AsyncIterable<string> {
      yield partial;
      throw new Error("LLM esploso a metà stream");
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "domanda che fallisce a metà" },
    });
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.payload);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);

    // Il persister custom salva il parziale con TRUNCATION_MARKER e citations null.
    const assistant = await vi.waitFor(async () => {
      const rows = await readMessages(item.id);
      const row = rows.find((m) => m.role === "assistant");
      expect(row).toBeDefined();
      return row!;
    });
    expect(assistant.content.startsWith(partial)).toBe(true);
    expect(assistant.content).toContain("[risposta interrotta]");
    expect(assistant.citations).toBeNull();
  });

  it("i ticket d'origine finiscono nel system prompt", async () => {
    const item = await insertItem();
    const [t] = await testDb.db
      .insert(tickets)
      .values({ projectId, number: 1, title: "Voglio esportare in PDF", body: "Come utente voglio…", type: "feature", priority: "medium", source: "manual" })
      .returning({ id: tickets.id });
    await testDb.db.insert(backlogItemTickets).values({ itemId: item.id, ticketId: t!.id, role: "origin" });

    await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/chat`,
      headers: { cookie: memberCookie },
      payload: { message: "domanda" },
    });
    expect(lastChatInput!.system).toContain("Voglio esportare in PDF");
  });
});

describe("POST /api/backlog/:id/refresh-document", () => {
  const okJson = '{"document":"# Documento aggiornato\\n\\nContenuto nuovo.","suggested":{"effort":4,"reason":"più grande del previsto"}}';

  async function seedUserMessage(itemId: string, content = "raffiniamo"): Promise<void> {
    await testDb.db.insert(backlogChatMessages).values({ itemId, role: "user", content });
  }

  it("member (non admin) → 403", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refresh-document`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404 se la voce non esiste", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${crypto.randomUUID()}/refresh-document`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("503 se la chat non è servibile", async () => {
    const item = await insertItem();
    await seedUserMessage(item.id);
    availabilityOverride = { available: false };
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refresh-document`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(503);
  });

  it("409 se non ci sono messaggi nuovi", async () => {
    const item = await insertItem();
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refresh-document`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it("parse ok: aggiorna document, sostituisce suggested, inserisce marker system", async () => {
    const item = await insertItem({ document: "# Vecchio", suggested: { risk: "low" } });
    await seedUserMessage(item.id);
    streamOverride = async function* () {
      yield okJson;
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refresh-document`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { document: string; suggested: Record<string, unknown> | null };
    expect(body.document).toContain("Documento aggiornato");
    // suggested SOSTITUITO (il vecchio risk:"low" sparisce).
    expect(body.suggested).toEqual({ effort: 4, reason: "più grande del previsto" });

    // Marker system inserito.
    const msgs = await readMessages(item.id);
    expect(msgs.some((m) => m.role === "system" && m.content === "Documento aggiornato.")).toBe(true);
  });

  it("parse ok con preambolo E postambolo attorno al JSON → 200", async () => {
    const item = await insertItem({ document: "# Vecchio" });
    await seedUserMessage(item.id);
    streamOverride = async function* () {
      yield 'Ecco il documento aggiornato:\n{"document":"# Con contorno"}\nFammi sapere se va bene!';
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refresh-document`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { document: string }).document).toBe("# Con contorno");
  });

  it("parse fallito: 502 e nessuna modifica al documento", async () => {
    const item = await insertItem({ document: "# Intatto" });
    await seedUserMessage(item.id);
    streamOverride = async function* () {
      yield "questo non è JSON valido";
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refresh-document`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(502);
    const [row] = await testDb.db
      .select({ document: backlogItems.document })
      .from(backlogItems)
      .where(eq(backlogItems.id, item.id));
    expect(row!.document).toBe("# Intatto");
    // Nessun marker inserito.
    const msgs = await readMessages(item.id);
    expect(msgs.some((m) => m.role === "system")).toBe(false);
  });

  it("delta: il secondo refresh sintetizza solo i messaggi dopo l'ultimo marker", async () => {
    const item = await insertItem();
    await seedUserMessage(item.id, "PRIMO_MESSAGGIO");
    streamOverride = async function* () {
      yield '{"document":"# V1"}';
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refresh-document`,
      headers: { cookie: adminCookie },
    });
    expect(first.statusCode).toBe(200);

    // Nuovo messaggio dopo il marker.
    await seedUserMessage(item.id, "SECONDO_MESSAGGIO");
    streamOverride = async function* () {
      yield '{"document":"# V2"}';
    };
    const second = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refresh-document`,
      headers: { cookie: adminCookie },
    });
    expect(second.statusCode).toBe(200);

    // Il delta del secondo refresh contiene solo il messaggio nuovo.
    expect(lastChatInput!.system).toContain("SECONDO_MESSAGGIO");
    expect(lastChatInput!.system).not.toContain("PRIMO_MESSAGGIO");
  });

  it("409 dopo un refresh senza nuovi messaggi (solo il marker in coda)", async () => {
    const item = await insertItem();
    await seedUserMessage(item.id);
    streamOverride = async function* () {
      yield '{"document":"# V1"}';
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refresh-document`,
      headers: { cookie: adminCookie },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/api/backlog/${item.id}/refresh-document`,
      headers: { cookie: adminCookie },
    });
    expect(second.statusCode).toBe(409);
  });
});
