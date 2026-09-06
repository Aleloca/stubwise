/**
 * Unit test di streamChatResponse: il branch `persistAssistantMessage` (la
 * persistenza pluggabile sostituisce l'insert su docChatMessages) e le DUE
 * modalità di risposta (`mode: "sse"` di default, `mode: "json"` per la fase 4
 * mobile). Tutto con fake (nessun testcontainer): il db fake registra gli
 * insert, il reply fake registra hijack/write/end (sse) o send/code (json).
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@stubwise/db";
import type { ChatLlm } from "./chat-llm.js";
import { streamChatResponse } from "./docs-chat-core.js";
import type { Citation } from "./docs-rag.js";

/** Db fake: registra le chiamate a insert (il default su docChatMessages). */
function fakeDb() {
  const insert = vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) }));
  return { db: { insert } as unknown as Db, insert };
}

/** Reply fake (mode sse): hijack + stream grezzo no-op. */
function fakeReply(): FastifyReply {
  return {
    hijack: vi.fn(),
    raw: { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() },
  } as unknown as FastifyReply;
}

/**
 * Reply fake (mode json): registra ogni invio come `(body, status)` — 200 per
 * `reply.send(...)` diretto (il percorso di successo), lo status esplicito per
 * `reply.code(status).send(...)` (apiError, sul percorso di errore). Un solo
 * elenco `calls` per non dover correlare due mock separati.
 */
function fakeJsonReply(): { reply: FastifyReply; calls: { body: unknown; status: number }[] } {
  const calls: { body: unknown; status: number }[] = [];
  const reply = {
    send: vi.fn((body: unknown) => {
      calls.push({ body, status: 200 });
    }),
    code: vi.fn((status: number) => ({
      send: (body: unknown) => calls.push({ body, status }),
    })),
  } as unknown as FastifyReply;
  return { reply, calls };
}

/** Request fake: nessuna disconnessione del client, log no-op. */
function fakeRequest(): FastifyRequest {
  return {
    raw: { on: vi.fn() },
    log: { error: vi.fn() },
  } as unknown as FastifyRequest;
}

/**
 * Request fake il cui `raw.on("close", cb)` registra il listener invece di
 * ignorarlo: `disconnect()` lo invoca, simulando il client che se ne va.
 */
function fakeRequestWithDisconnect(): { request: FastifyRequest; disconnect: () => void } {
  let closeListener: (() => void) | null = null;
  const request = {
    raw: {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "close") closeListener = cb;
      }),
    },
    log: { error: vi.fn() },
  } as unknown as FastifyRequest;
  return { request, disconnect: () => closeListener?.() };
}

/** ChatLlm fake che riproduce lo stream dato (i throw simulano errori a metà). */
function fakeChatLlm(stream: () => AsyncIterable<string>): ChatLlm {
  return { stream } as unknown as ChatLlm;
}

const CITATIONS: Citation[] = [
  { slug: "pagina", title: "Pagina" } as unknown as Citation,
];

async function run(
  stream: () => AsyncIterable<string>,
): Promise<{
  persisted: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
}> {
  const { db, insert } = fakeDb();
  const persisted = vi.fn().mockResolvedValue(undefined);
  await streamChatResponse({
    db,
    chatLlm: fakeChatLlm(stream),
    request: fakeRequest(),
    reply: fakeReply(),
    sessionId: "22222222-2222-4222-8222-222222222222",
    system: "system",
    history: [{ role: "user", content: "domanda" }],
    citations: CITATIONS,
    logContext: { repositoryId: "r" },
    persistAssistantMessage: persisted,
  });
  return { persisted, insert };
}

describe("streamChatResponse — persistAssistantMessage", () => {
  it("risposta completa: callback con testo intero, citazioni e truncated:false; nessun insert default", async () => {
    const { persisted, insert } = await run(async function* () {
      yield "ciao ";
      yield "mondo";
    });
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveBeenCalledWith({
      content: "ciao mondo",
      citations: CITATIONS,
      truncated: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("errore a metà stream CON testo parziale: callback con truncated:true; nessun insert default", async () => {
    const { persisted, insert } = await run(async function* () {
      yield "parziale";
      throw new Error("LLM esploso");
    });
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveBeenCalledWith({
      content: "parziale",
      citations: CITATIONS,
      truncated: true,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("errore con ZERO testo accumulato: callback NON chiamato e nessun insert (come il default)", async () => {
    const { persisted, insert } = await run(async function* () {
      yield* [] as string[];
      throw new Error("LLM morto subito");
    });
    expect(persisted).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("streamChatResponse — la persistenza precede la chiusura della risposta", () => {
  // Le UI fanno refetch dello storico appena ricevono `done`: se l'insert
  // avvenisse dopo reply.raw.end(), il refetch potrebbe non vedere l'ultimo
  // messaggio assistant (race osservata come flake in CI su docs-chat.test.ts).
  // Quando `done` viene emesso, lo storico DEVE già essere consistente.

  function orderProbes(reply: FastifyReply) {
    const raw = reply.raw as unknown as {
      end: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
    };
    return {
      endCalled: () => raw.end.mock.calls.length > 0,
      doneWritten: () =>
        raw.write.mock.calls.some((c) => String(c[0]).includes('"done"')),
    };
  }

  const okStream = async function* () {
    yield "risposta";
  };

  it("callback custom: atteso PRIMA di done e di end", async () => {
    const reply = fakeReply();
    const probes = orderProbes(reply);
    let endAtPersist: boolean | null = null;
    let doneAtPersist: boolean | null = null;
    const persist = vi.fn(async () => {
      endAtPersist = probes.endCalled();
      doneAtPersist = probes.doneWritten();
    });
    const { db } = fakeDb();
    await streamChatResponse({
      db,
      chatLlm: fakeChatLlm(okStream),
      request: fakeRequest(),
      reply,
      sessionId: "22222222-2222-4222-8222-222222222222",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: CITATIONS,
      logContext: { repositoryId: "r" },
      persistAssistantMessage: persist,
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(endAtPersist).toBe(false);
    expect(doneAtPersist).toBe(false);
    // La risposta viene comunque chiusa con il `done` dopo la persistenza.
    expect(probes.doneWritten()).toBe(true);
    expect(probes.endCalled()).toBe(true);
  });

  it("default (insert su docChatMessages): atteso PRIMA di done e di end", async () => {
    const reply = fakeReply();
    const probes = orderProbes(reply);
    let endAtInsert: boolean | null = null;
    let doneAtInsert: boolean | null = null;
    const values = vi.fn(async () => {
      endAtInsert = probes.endCalled();
      doneAtInsert = probes.doneWritten();
    });
    const db = { insert: vi.fn(() => ({ values })) } as unknown as Db;
    await streamChatResponse({
      db,
      chatLlm: fakeChatLlm(okStream),
      request: fakeRequest(),
      reply,
      sessionId: "22222222-2222-4222-8222-222222222222",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: CITATIONS,
      logContext: { repositoryId: "r" },
    });
    expect(values).toHaveBeenCalledTimes(1);
    expect(endAtInsert).toBe(false);
    expect(doneAtInsert).toBe(false);
    expect(probes.doneWritten()).toBe(true);
    expect(probes.endCalled()).toBe(true);
  });

  it("persistenza che FALLISCE: niente done (il client tratta la risposta come troncata), stream comunque chiuso", async () => {
    const reply = fakeReply();
    const probes = orderProbes(reply);
    const persist = vi.fn().mockRejectedValue(new Error("db down"));
    const { db } = fakeDb();
    const request = fakeRequest();
    await streamChatResponse({
      db,
      chatLlm: fakeChatLlm(okStream),
      request,
      reply,
      sessionId: "22222222-2222-4222-8222-222222222222",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: CITATIONS,
      logContext: { repositoryId: "r" },
      persistAssistantMessage: persist,
    });
    expect(probes.doneWritten()).toBe(false);
    expect(probes.endCalled()).toBe(true);
    expect(
      (request.log.error as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(0);
  });
});

describe("streamChatResponse — mode: json (fase 4, mobile, ?stream=false)", () => {
  const okStream = async function* () {
    yield "ciao ";
    yield "mondo";
  };

  it("risposta completa: reply.send({answer, sources, sessionId}) col default insert su docChatMessages (come sse)", async () => {
    const { db, insert } = fakeDb();
    const { reply, calls } = fakeJsonReply();
    await streamChatResponse({
      db,
      chatLlm: fakeChatLlm(okStream),
      request: fakeRequest(),
      reply,
      sessionId: "22222222-2222-4222-8222-222222222222",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: CITATIONS,
      logContext: { repositoryId: "r" },
      mode: "json",
    });
    expect(calls).toEqual([
      {
        status: 200,
        body: {
          answer: "ciao mondo",
          sources: CITATIONS,
          sessionId: "22222222-2222-4222-8222-222222222222",
        },
      },
    ]);
    // Stessa persistenza del completo in sse: insert col testo intero + citazioni.
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("persistAssistantMessage: chiamato con truncated:false sul completamento, come il ramo `completed` della sse", async () => {
    const persisted = vi.fn().mockResolvedValue(undefined);
    const { db, insert } = fakeDb();
    const { reply } = fakeJsonReply();
    await streamChatResponse({
      db,
      chatLlm: fakeChatLlm(okStream),
      request: fakeRequest(),
      reply,
      sessionId: "22222222-2222-4222-8222-222222222222",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: CITATIONS,
      logContext: { repositoryId: "r" },
      persistAssistantMessage: persisted,
      mode: "json",
    });
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveBeenCalledWith({
      content: "ciao mondo",
      citations: CITATIONS,
      truncated: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("errore LLM a metà: 502 chat_generation_failed, NESSUNA persistenza — a differenza della sse che salva il parziale", async () => {
    const { db, insert } = fakeDb();
    const { reply, calls } = fakeJsonReply();
    const request = fakeRequest();
    await streamChatResponse({
      db,
      chatLlm: fakeChatLlm(async function* () {
        yield "parziale";
        throw new Error("LLM esploso a metà");
      }),
      request,
      reply,
      sessionId: "22222222-2222-4222-8222-222222222222",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: CITATIONS,
      logContext: { repositoryId: "r" },
      mode: "json",
    });
    expect(calls).toEqual([
      { status: 502, body: { code: "chat_generation_failed", message: expect.any(String) } },
    ]);
    // Il testo parziale ("parziale") NON viene mai persistito: a differenza
    // della sse (che lo salva con TRUNCATION_MARKER), un client json non ha
    // ricevuto NESSUN byte di questa risposta — non c'è "già visto" da tenere.
    expect(insert).not.toHaveBeenCalled();
    expect(
      (request.log.error as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(0);
  });

  it("errore LLM al PRIMO delta (nessun testo accumulato): stesso 502, nessuna persistenza", async () => {
    const { db, insert } = fakeDb();
    const { reply, calls } = fakeJsonReply();
    await streamChatResponse({
      db,
      chatLlm: fakeChatLlm(async function* () {
        yield* [] as string[];
        throw new Error("LLM morto subito");
      }),
      request: fakeRequest(),
      reply,
      sessionId: "22222222-2222-4222-8222-222222222222",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: CITATIONS,
      logContext: { repositoryId: "r" },
      mode: "json",
    });
    expect(calls).toEqual([
      { status: 502, body: { code: "chat_generation_failed", message: expect.any(String) } },
    ]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("persistenza (default insert) fallita sul completo: 502 chat_persist_failed, NESSUNA risposta di successo mandata", async () => {
    const values = vi.fn().mockRejectedValue(new Error("db down"));
    const db = { insert: vi.fn(() => ({ values })) } as unknown as Db;
    const { reply, calls } = fakeJsonReply();
    const request = fakeRequest();
    await streamChatResponse({
      db,
      chatLlm: fakeChatLlm(okStream),
      request,
      reply,
      sessionId: "22222222-2222-4222-8222-222222222222",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: CITATIONS,
      logContext: { repositoryId: "r" },
      mode: "json",
    });
    expect(calls).toEqual([
      { status: 502, body: { code: "chat_persist_failed", message: expect.any(String) } },
    ]);
    expect(
      (request.log.error as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(0);
  });

  it("persistAssistantMessage fallita sul completo: 502 chat_persist_failed", async () => {
    const persisted = vi.fn().mockRejectedValue(new Error("worker down"));
    const { db } = fakeDb();
    const { reply, calls } = fakeJsonReply();
    await streamChatResponse({
      db,
      chatLlm: fakeChatLlm(okStream),
      request: fakeRequest(),
      reply,
      sessionId: "22222222-2222-4222-8222-222222222222",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: CITATIONS,
      logContext: { backlogItemId: "b" },
      persistAssistantMessage: persisted,
      mode: "json",
    });
    expect(calls).toEqual([
      { status: 502, body: { code: "chat_persist_failed", message: expect.any(String) } },
    ]);
  });

  it("client disconnesso durante la generazione: nessun send, nessuna persistenza (il socket è già chiuso)", async () => {
    const { db, insert } = fakeDb();
    const { reply, calls } = fakeJsonReply();
    const { request, disconnect } = fakeRequestWithDisconnect();
    const persisted = vi.fn().mockResolvedValue(undefined);
    await streamChatResponse({
      db,
      chatLlm: fakeChatLlm(async function* () {
        yield "parziale";
        disconnect(); // il client se ne va DOPO il primo delta, PRIMA della fine
        yield "mai visto";
      }),
      request,
      reply,
      sessionId: "22222222-2222-4222-8222-222222222222",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: CITATIONS,
      logContext: { repositoryId: "r" },
      persistAssistantMessage: persisted,
      mode: "json",
    });
    expect(calls).toEqual([]);
    expect(persisted).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("mode omesso: resta sse (default), NON json — nessuna reply.send, hijack chiamato", async () => {
    const { db } = fakeDb();
    const reply = fakeReply();
    await streamChatResponse({
      db,
      chatLlm: fakeChatLlm(okStream),
      request: fakeRequest(),
      reply,
      sessionId: "22222222-2222-4222-8222-222222222222",
      system: "system",
      history: [{ role: "user", content: "domanda" }],
      citations: CITATIONS,
      logContext: { repositoryId: "r" },
      // Nessun `mode`: deve comportarsi come "sse" (compatibilità coi call site
      // esistenti/i test sse sopra, che non lo passano).
    });
    expect(reply.hijack).toHaveBeenCalledTimes(1);
  });
});
