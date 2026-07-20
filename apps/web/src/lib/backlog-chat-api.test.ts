import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { postBacklogChatStream, type BacklogChatHandlers } from "./backlog-chat-api";

/**
 * Test dello stream SSE della chat backlog: la fetch è mockata con Response che
 * incapsulano un ReadableStream di chunk arbitrari, così si esercitano i casi
 * di framing reali (evento spezzato tra chunk, più eventi in un chunk, JSON
 * rotto) senza un server.
 */

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

/** Response 200 il cui body emette i chunk dati, in ordine, poi chiude. */
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeHandlers(): BacklogChatHandlers & {
  deltas: string[];
  done: { citations?: unknown }[];
  errors: number;
} {
  const collected = {
    deltas: [] as string[],
    done: [] as { citations?: unknown }[],
    errors: 0,
    onDelta(text: string) {
      collected.deltas.push(text);
    },
    onDone(payload: { citations?: unknown }) {
      collected.done.push(payload);
    },
    onError() {
      collected.errors += 1;
    },
  };
  return collected;
}

describe("postBacklogChatStream", () => {
  it("un evento spezzato su due chunk viene ricomposto", async () => {
    fetchMock.mockResolvedValue(
      streamResponse(['data: {"type":"delta","te', 'xt":"ciao"}\n\n', 'data: {"type":"done"}\n\n']),
    );
    const handlers = makeHandlers();

    await postBacklogChatStream("id1", "domanda", handlers);

    expect(handlers.deltas).toEqual(["ciao"]);
    expect(handlers.done).toHaveLength(1);
    expect(handlers.errors).toBe(0);
  });

  it("due eventi nello stesso chunk vengono processati entrambi", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        'data: {"type":"delta","text":"a"}\n\ndata: {"type":"delta","text":"b"}\n\n',
        'data: {"type":"done","citations":[{"slug":"s"}]}\n\n',
      ]),
    );
    const handlers = makeHandlers();

    await postBacklogChatStream("id1", "domanda", handlers);

    expect(handlers.deltas).toEqual(["a", "b"]);
    expect(handlers.done).toEqual([{ citations: [{ slug: "s" }] }]);
  });

  it("un frammento JSON rotto viene ignorato senza rompere lo stream", async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        "data: {non-json}\n\n",
        'data: {"type":"delta","text":"ok"}\n\n',
        'data: {"type":"done"}\n\n',
      ]),
    );
    const handlers = makeHandlers();

    await postBacklogChatStream("id1", "domanda", handlers);

    expect(handlers.deltas).toEqual(["ok"]);
    expect(handlers.done).toHaveLength(1);
    expect(handlers.errors).toBe(0);
  });

  it("l'evento error invoca onError e lo stream prosegue fino alla chiusura", async () => {
    fetchMock.mockResolvedValue(
      streamResponse(['data: {"type":"delta","text":"parziale"}\n\n', 'data: {"type":"error"}\n\n']),
    );
    const handlers = makeHandlers();

    await postBacklogChatStream("id1", "domanda", handlers);

    expect(handlers.deltas).toEqual(["parziale"]);
    expect(handlers.errors).toBe(1);
    expect(handlers.done).toHaveLength(0);
  });

  it("503 chat_unavailable: ApiError con code, PRIMA di aprire lo stream", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ code: "chat_unavailable", message: "Backlog chat requires an API-key AI provider" }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    );
    const handlers = makeHandlers();

    const error = await postBacklogChatStream("id1", "domanda", handlers).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).code).toBe("chat_unavailable");
    expect(handlers.deltas).toHaveLength(0);
    expect(handlers.errors).toBe(0);
  });

  it("errore di rete (TypeError): ApiError status 0 con code network_error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const error = await postBacklogChatStream("id1", "domanda", makeHandlers()).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).code).toBe("network_error");
  });

  it("stream chiuso senza done: la promise risolve senza onDone né onError (buffer residuo scartato)", async () => {
    fetchMock.mockResolvedValue(
      // L'ultimo frammento non è terminato da `\n\n`: buffer residuo scartato.
      streamResponse(['data: {"type":"delta","text":"troncato"}\n\n', 'data: {"type":"del']),
    );
    const handlers = makeHandlers();

    await expect(postBacklogChatStream("id1", "domanda", handlers)).resolves.toBeUndefined();

    expect(handlers.deltas).toEqual(["troncato"]);
    expect(handlers.done).toHaveLength(0);
    expect(handlers.errors).toBe(0);
  });
});
