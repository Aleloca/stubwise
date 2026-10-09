import { afterEach, describe, expect, it, vi } from "vitest";
import { sse, sseResponse } from "../test/sse";
import { ApiError } from "./api";
import {
  openAgentSessionStream,
  type StreamMessage,
  type StreamStatus,
} from "./agent-session-stream";

/**
 * Lo stream dal vivo di una sessione (piano B, Task 3). Il `fetchImpl` finto
 * restituisce `Response` costruite da un `ReadableStream`: niente rete, niente
 * attese fisse — le asserzioni aspettano una CONDIZIONE (`vi.waitFor`) o
 * avanzano timer finti.
 */

const SESSION_ID = "7f1c2a1e-0000-4000-8000-000000000001";

function event(id: string, text = `testo ${id}`) {
  return {
    id,
    type: "assistant_text",
    segmentId: "seg-1",
    at: "2026-10-09T10:00:00.000Z",
    data: { text },
  };
}

const detail = {
  id: SESSION_ID,
  kind: "ai_job",
  title: "#42 Fix del login",
  projectId: null,
  projectName: null,
  ticketId: null,
  ticketNumber: null,
  startedAt: "2026-10-09T10:00:00.000Z",
  lastEventAt: null,
  state: "working",
  canWrite: true,
};

/** Una risposta SSE che resta aperta (come lo stream vero): non chiude mai il body. */
function openResponse(frames: string[], signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      signal?.addEventListener("abort", () => {
        controller.error(new DOMException("aborted", "AbortError"));
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Una risposta che consegna dei frame e poi CADE (proxy che chiude la connessione). */
function droppingResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        return;
      }
      controller.error(new TypeError("network error"));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlOf(call: unknown[]): string {
  return String(call[0]);
}

function eventIds(messages: StreamMessage[]): string[] {
  return messages.flatMap((m) => (m.type === "events" ? m.events.map((e) => e.id) : []));
}

let handle: { close(): void } | null = null;

afterEach(() => {
  handle?.close();
  handle = null;
  vi.useRealTimers();
});

describe("openAgentSessionStream", () => {
  it("events, partial e session arrivano in ordine, parsati", async () => {
    const messages: StreamMessage[] = [];
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        openResponse(
          [
            sse({ type: "events", events: [event("1")] }),
            ": ping\n\n",
            sse({ type: "partial", segmentId: "seg-1", text: "sto pen" }),
            sse({ type: "session", detail }),
          ],
          init?.signal,
        ),
      ),
    );
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "0",
      onMessage: (m) => messages.push(m),
      fetchImpl,
    });

    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages.map((m) => m.type)).toEqual(["events", "partial", "session"]);
    expect(eventIds(messages)).toEqual(["1"]);
    expect(messages[1]).toEqual({ type: "partial", segmentId: "seg-1", text: "sto pen" });
    const session = messages[2];
    if (session?.type !== "session") throw new Error("atteso session");
    // Parsato col readerSchema: i default del dettaglio ci sono.
    expect(session.detail.canWrite).toBe(true);
    expect(session.detail.questions).toEqual([]);
    expect(session.detail.inputs).toEqual([]);

    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.method ?? "GET").toBe("GET");
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("accept")).toBe("text/event-stream");
  });

  it("un frame con JSON rotto è ignorato e il successivo arriva", async () => {
    const messages: StreamMessage[] = [];
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        openResponse(
          ["data: {non json\n\n", sse({ type: "events", events: [event("2")] })],
          init?.signal,
        ),
      ),
    );
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "1",
      onMessage: (m) => messages.push(m),
      fetchImpl,
    });
    await vi.waitFor(() => expect(eventIds(messages)).toEqual(["2"]));
    expect(messages).toHaveLength(1);
  });

  it("un evento di forma non valida è scartato, gli altri del frame arrivano", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const messages: StreamMessage[] = [];
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        openResponse(
          [
            sse({ type: "events", events: [{ id: "3" }, event("4")] }),
            sse({ type: "partial", segmentId: 7, text: "x" }),
            sse({ type: "session", detail: { id: "nope" } }),
            sse({ type: "events", events: [event("5")] }),
          ],
          init?.signal,
        ),
      ),
    );
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "2",
      onMessage: (m) => messages.push(m),
      fetchImpl,
    });
    await vi.waitFor(() => expect(eventIds(messages)).toEqual(["4", "5"]));
    expect(messages.map((m) => m.type)).toEqual(["events", "events"]);
    consoleWarn.mockRestore();
  });

  it("il cursore iniziale: `after` nella prima URL, assente con null", async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(openResponse([], init?.signal)),
    );
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "42",
      onMessage: () => undefined,
      fetchImpl,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(urlOf(fetchImpl.mock.calls[0]!)).toBe(
      `/api/agent-sessions/${SESSION_ID}/stream?after=42`,
    );
    handle.close();

    const fetchNull = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(openResponse([], init?.signal)),
    );
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: null,
      onMessage: () => undefined,
      fetchImpl: fetchNull,
    });
    await vi.waitFor(() => expect(fetchNull).toHaveBeenCalledTimes(1));
    expect(urlOf(fetchNull.mock.calls[0]!)).toBe(`/api/agent-sessions/${SESSION_ID}/stream`);
    expect(urlOf(fetchNull.mock.calls[0]!)).not.toContain("after");
  });

  it("lo stream chiuso dal server si riconnette dall'ultimo id, senza doppioni", async () => {
    const messages: StreamMessage[] = [];
    const statuses: StreamStatus[] = [];
    const fetchImpl = vi
      .fn((_url: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(openResponse([sse({ type: "events", events: [event("7")] })], init?.signal)),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(sseResponse([sse({ type: "events", events: [event("5"), event("6")] })])),
      );
    const backoffMs = vi.fn(() => 0);
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "4",
      onMessage: (m) => messages.push(m),
      onStatus: (s) => statuses.push(s),
      fetchImpl,
      backoffMs,
    });

    await vi.waitFor(() => expect(eventIds(messages)).toEqual(["5", "6", "7"]));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchImpl.mock.calls[1]!)).toBe(
      `/api/agent-sessions/${SESSION_ID}/stream?after=6`,
    );
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);
    expect(backoffMs).toHaveBeenCalledWith(0);
  });

  it("una connessione che CADE a metà (errore di rete) riparte dall'ultimo evento consegnato", async () => {
    const messages: StreamMessage[] = [];
    const fetchImpl = vi
      .fn((_url: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(openResponse([sse({ type: "events", events: [event("9")] })], init?.signal)),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(droppingResponse([sse({ type: "events", events: [event("8")] })])),
      );
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "7",
      onMessage: (m) => messages.push(m),
      fetchImpl,
      backoffMs: () => 0,
    });
    await vi.waitFor(() => expect(eventIds(messages)).toEqual(["8", "9"]));
    expect(urlOf(fetchImpl.mock.calls[1]!)).toContain("after=8");
  });

  it("un fetch che fallisce (laptop sospeso) riprova col cursore e col backoff crescente", async () => {
    const messages: StreamMessage[] = [];
    const fetchImpl = vi
      .fn((_url: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(openResponse([sse({ type: "events", events: [event("11")] })], init?.signal)),
      )
      .mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse(502, { message: "bad gateway" })));
    const backoffMs = vi.fn(() => 0);
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "10",
      onMessage: (m) => messages.push(m),
      fetchImpl,
      backoffMs,
    });
    await vi.waitFor(() => expect(eventIds(messages)).toEqual(["11"]));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const call of fetchImpl.mock.calls) expect(urlOf(call)).toContain("after=10");
    expect(backoffMs.mock.calls.map((c: unknown[]) => c[0])).toEqual([0, 1]);
  });

  it("404 della sessione → onFatal una volta, nessuna riconnessione", async () => {
    vi.useFakeTimers();
    const onFatal = vi.fn();
    const statuses: StreamStatus[] = [];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(404, { code: "not_found", message: "Session not found" })),
    );
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: null,
      onMessage: () => undefined,
      onStatus: (s) => statuses.push(s),
      onFatal,
      fetchImpl,
    });
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    const error = onFatal.mock.calls[0]![0] as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe("not_found");
    expect(statuses.at(-1)).toBe("closed");
  });

  it("404 SENZA code (server senza le rotte) → onFatal, nessun loop", async () => {
    vi.useFakeTimers();
    const onFatal = vi.fn();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(404, { message: "Route GET:/x not found" })),
    );
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: null,
      onMessage: () => undefined,
      onFatal,
      fetchImpl,
    });
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((onFatal.mock.calls[0]![0] as ApiError).code).toBeUndefined();
  });

  it("401 → onFatal, nessuna riconnessione", async () => {
    vi.useFakeTimers();
    const onFatal = vi.fn();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(401, { code: "unauthorized", message: "no" })),
    );
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: null,
      onMessage: () => undefined,
      onFatal,
      fetchImpl,
    });
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("close() durante l'attesa del backoff → nessuna nuova chiamata", async () => {
    vi.useFakeTimers();
    const statuses: StreamStatus[] = [];
    const fetchImpl = vi.fn(() => Promise.resolve(sseResponse([])));
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "1",
      onMessage: () => undefined,
      onStatus: (s) => statuses.push(s),
      fetchImpl,
      backoffMs: () => 5_000,
    });
    await vi.waitFor(() => expect(statuses).toContain("reconnecting"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    handle.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe("closed");
  });

  it("close() con lo stream aperto annulla il fetch e non riconnette", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return Promise.resolve(openResponse([], init?.signal));
    });
    const statuses: StreamStatus[] = [];
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "1",
      onMessage: () => undefined,
      onStatus: (s) => statuses.push(s),
      fetchImpl,
    });
    await vi.waitFor(() => expect(statuses).toContain("open"));
    handle.close();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe("closed");
  });
  it("un consumatore che lancia: l'errore emerge e NON è una caduta di rete (nessuna riconnessione)", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = new Error("consumatore rotto");
    const received: StreamMessage[] = [];
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        openResponse(
          [
            sse({ type: "events", events: [event("1")] }),
            sse({ type: "events", events: [event("2")] }),
          ],
          init?.signal,
        ),
      ),
    );
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "0",
      onMessage: (m) => {
        received.push(m);
        if (received.length === 1) throw boom;
      },
      fetchImpl,
      backoffMs: () => 0,
    });
    await vi.waitFor(() => expect(eventIds(received)).toEqual(["1", "2"]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), boom);
    consoleError.mockRestore();
  });

  it("un 200 che chiude subito senza frame: il backoff cresce (non si azzera sugli header)", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => Promise.resolve(sseResponse([])));
    const backoffMs = vi.fn(() => 1_000);
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "1",
      onMessage: () => undefined,
      fetchImpl,
      backoffMs,
    });
    await vi.waitFor(() => expect(backoffMs).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(backoffMs).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(backoffMs).toHaveBeenCalledTimes(3));
    expect(backoffMs.mock.calls.map((c: unknown[]) => c[0])).toEqual([0, 1, 2]);
  });

  it("dopo un frame ricevuto il backoff riparte da 0", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(sseResponse([sse({ type: "partial", segmentId: "s", text: "x" })])),
    );
    const backoffMs = vi.fn(() => 1_000);
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "1",
      onMessage: () => undefined,
      fetchImpl,
      backoffMs,
    });
    await vi.waitFor(() => expect(backoffMs).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(backoffMs).toHaveBeenCalledTimes(2));
    expect(backoffMs.mock.calls.map((c: unknown[]) => c[0])).toEqual([0, 0]);
  });

  it("un frame e un carattere multibyte spezzati fra chunk danno UN partial intero", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"partial","segmentId":"s","text":"è"}\n\n',
    );
    const e = bytes.indexOf(0xc3); // primo byte di «è»
    const chunks = [bytes.slice(0, e + 1), bytes.slice(e + 1, e + 3), bytes.slice(e + 3)];
    const messages: StreamMessage[] = [];
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      if (fetchImpl.mock.calls.length > 1) return Promise.resolve(openResponse([], init?.signal));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "1",
      onMessage: (m) => messages.push(m),
      fetchImpl,
      backoffMs: () => 0,
    });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toEqual({ type: "partial", segmentId: "s", text: "è" });
  });

  it("un dettaglio `session` che non si parsa: un solo console.warn per stream", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const messages: StreamMessage[] = [];
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        openResponse(
          [
            sse({ type: "session", detail: { id: "nope" } }),
            sse({ type: "session", detail: { id: "ancora" } }),
            sse({ type: "events", events: [event("3")] }),
          ],
          init?.signal,
        ),
      ),
    );
    handle = openAgentSessionStream({
      sessionId: SESSION_ID,
      after: "2",
      onMessage: (m) => messages.push(m),
      fetchImpl,
    });
    await vi.waitFor(() => expect(eventIds(messages)).toEqual(["3"]));
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });
});
