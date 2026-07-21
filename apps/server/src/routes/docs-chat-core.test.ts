/**
 * Unit test del branch `persistAssistantMessage` di streamChatResponse: la
 * persistenza pluggabile sostituisce l'insert su docChatMessages. Tutto con
 * fake (nessun testcontainer): il db fake registra gli insert per asserire
 * che il default NON viene mai eseguito quando il callback è presente.
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

/** Reply fake: hijack + stream grezzo no-op. */
function fakeReply(): FastifyReply {
  return {
    hijack: vi.fn(),
    raw: { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() },
  } as unknown as FastifyReply;
}

/** Request fake: nessuna disconnessione del client, log no-op. */
function fakeRequest(): FastifyRequest {
  return {
    raw: { on: vi.fn() },
    log: { error: vi.fn() },
  } as unknown as FastifyRequest;
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
