import { ApiError, isAgentSessionsUnavailable } from "@stubwise/api-client";
import { FakeXhr, sseFrame } from "../test-utils/fake-xhr";
import { handleUnauthorized } from "./client";
import {
  openAgentSessionStream,
  type AgentSessionStreamOptions,
  type StreamMessage,
  type StreamStatus,
} from "./agent-session-stream";

/**
 * Lo stream dal vivo di una sessione su XMLHttpRequest (piano C, Task 4).
 * Gemello di `apps/web/src/lib/agent-session-stream.test.ts`: stesse regole
 * (frame validati, cursore, backoff, errori del consumatore, fatali), più
 * quelle che vengono dall'XHR di React Native — `responseText` che cresce e
 * va letto dall'ultimo indice, il corpo degli errori che passa anch'esso da
 * `progress`, la rotazione oltre una soglia. L'XHR è finto (`FakeXhr`) e i
 * timer sono finti: niente rete, niente attese fisse.
 */

jest.mock("./client", () => ({
  ...jest.requireActual("./client"),
  handleUnauthorized: jest.fn(() => Promise.resolve()),
}));

const mockHandleUnauthorized = handleUnauthorized as jest.Mock;

const SESSION_ID = "7f1c2a1e-0000-4000-8000-000000000001";
const BASE_URL = "https://stubwise.example";
const TOKEN = "stw_pat_abc123";

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

function eventIds(messages: StreamMessage[]): string[] {
  return messages.flatMap((m) => (m.type === "events" ? m.events.map((e) => e.id) : []));
}

/** Lascia girare le promise in sospeso (la lettura della sessione) senza far scattare timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

let handle: { close(): void } | null = null;
let messages: StreamMessage[];
let statuses: StreamStatus[];

function open(overrides: Partial<AgentSessionStreamOptions> = {}): { close(): void } {
  handle = openAgentSessionStream({
    sessionId: SESSION_ID,
    after: "0",
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    loadSession: () => Promise.resolve({ baseUrl: BASE_URL, token: TOKEN }),
    createXhr: FakeXhr.create,
    backoffMs: () => 1_000,
    ...overrides,
  });
  return handle;
}

/** L'ultima connessione aperta. */
function current(): FakeXhr {
  const xhr = FakeXhr.instances.at(-1);
  if (!xhr) throw new Error("nessuna connessione aperta");
  return xhr;
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeXhr.reset();
  mockHandleUnauthorized.mockClear();
  messages = [];
  statuses = [];
});

afterEach(() => {
  handle?.close();
  handle = null;
  jest.useRealTimers();
});

describe("openAgentSessionStream (XHR)", () => {
  test("URL dal client tipato, Bearer della sessione, Accept SSE e handler assegnati PRIMA di send()", async () => {
    open({ after: "41" });
    await flush();

    const xhr = current();
    expect(xhr.method).toBe("GET");
    expect(xhr.url).toBe(`${BASE_URL}/api/agent-sessions/${SESSION_ID}/stream?after=41`);
    expect(xhr.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: "text/event-stream",
    });
    expect(xhr.sent).toBe(true);
    // RN decide in send() se mandare dati incrementali: onprogress dopo sarebbe tardi.
    expect(xhr.handlersAtSend).toEqual(
      expect.arrayContaining(["onprogress", "onload", "onerror", "ontimeout"]),
    );
  });

  test("senza cursore la prima URL non ha `after`", async () => {
    open({ after: null });
    await flush();
    expect(current().url).toBe(`${BASE_URL}/api/agent-sessions/${SESSION_ID}/stream`);
  });

  test("due frame in UN progress e un frame spezzato fra due progress: tre messaggi in ordine, parsati", async () => {
    open();
    await flush();
    const xhr = current();
    xhr.respond(200);
    expect(statuses).toEqual(["connecting", "open"]);

    const third = sseFrame({ type: "session", detail });
    xhr.emit(
      sseFrame({ type: "events", events: [event("1")] }) +
        ": ping\n\n" +
        sseFrame({ type: "partial", segmentId: "seg-1", text: "sto pen" }) +
        third.slice(0, 25),
    );
    expect(messages.map((m) => m.type)).toEqual(["events", "partial"]);
    xhr.emit(third.slice(25));

    expect(messages.map((m) => m.type)).toEqual(["events", "partial", "session"]);
    expect(eventIds(messages)).toEqual(["1"]);
    expect(messages[1]).toEqual({ type: "partial", segmentId: "seg-1", text: "sto pen" });
    const session = messages[2];
    if (session?.type !== "session") throw new Error("atteso session");
    // Parsato col readerSchema: i default del dettaglio ci sono.
    expect(session.detail.canWrite).toBe(true);
    expect(session.detail.questions).toEqual([]);
    expect(session.detail.inputs).toEqual([]);
  });

  test("un carattere multibyte arriva intero nel testo già decodificato", async () => {
    open();
    await flush();
    const frame = sseFrame({ type: "partial", segmentId: "s", text: "perché è così" });
    const cut = frame.indexOf("è");
    current().emit(frame.slice(0, cut));
    current().emit(frame.slice(cut));
    expect(messages).toEqual([{ type: "partial", segmentId: "s", text: "perché è così" }]);
  });

  test("JSON rotto ed eventi malformati si scartano; il cursore avanza comunque all'ultimo id", async () => {
    open();
    await flush();
    current().emit(
      "data: {non è json}\n\n" +
        sseFrame({ type: "events", events: [event("1"), { id: "2", type: "boh" }] }) +
        sseFrame({ type: "partial", segmentId: 3, text: "x" }),
    );
    expect(eventIds(messages)).toEqual(["1"]);
    expect(messages).toHaveLength(1);

    current().finish();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(current().after).toBe("2");
  });

  test("lo stream chiuso dal server (load 200) si riconnette col backoff dall'ultimo id, senza doppioni", async () => {
    open({ after: "0" });
    await flush();
    current().emit(sseFrame({ type: "events", events: [event("1"), event("2")] }));
    current().finish(200);
    expect(statuses.at(-1)).toBe("reconnecting");

    await jest.advanceTimersByTimeAsync(999);
    expect(FakeXhr.instances).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(current().after).toBe("2");

    current().emit(sseFrame({ type: "events", events: [event("3")] }));
    expect(eventIds(messages)).toEqual(["1", "2", "3"]);
  });

  test("una connessione che cade (error) o scade (timeout) riparte dall'ultimo evento", async () => {
    open({ after: "0" });
    await flush();
    current().emit(sseFrame({ type: "events", events: [event("5")] }));
    current().fail();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(current().after).toBe("5");

    current().emit(sseFrame({ type: "events", events: [event("6")] }));
    current().expire();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(FakeXhr.instances).toHaveLength(3);
    expect(current().after).toBe("6");
  });

  test("il corpo di una risposta non-200 NON si parsa come frame; un 5xx riconnette", async () => {
    open();
    await flush();
    const xhr = current();
    xhr.respond(502);
    xhr.emit(sseFrame({ type: "events", events: [event("99")] }));
    xhr.finish();
    expect(messages).toEqual([]);
    expect(statuses).not.toContain("open");

    await jest.advanceTimersByTimeAsync(1_000);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(current().after).toBe("0");
  });

  test("401 → handleUnauthorized una volta, onFatal(ApiError 401), stato closed, nessuna riconnessione", async () => {
    const onFatal = jest.fn();
    open({ onFatal });
    await flush();
    const xhr = current();
    xhr.respond(401);
    xhr.emit(JSON.stringify({ code: "unauthorized", message: "Unauthorized" }));
    xhr.finish();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockHandleUnauthorized).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    const error = onFatal.mock.calls[0]![0] as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(messages).toEqual([]);
    expect(statuses.at(-1)).toBe("closed");

    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeXhr.instances).toHaveLength(1);
  });

  test("403 → onFatal col code, nessuna riconnessione, handleUnauthorized NON chiamata", async () => {
    const onFatal = jest.fn();
    open({ onFatal });
    await flush();
    current().respond(403);
    current().emit(JSON.stringify({ code: "forbidden", message: "Forbidden" }));
    current().finish();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect((onFatal.mock.calls[0]![0] as ApiError).code).toBe("forbidden");
    expect(mockHandleUnauthorized).not.toHaveBeenCalled();
    expect(FakeXhr.instances).toHaveLength(1);
  });

  test("404 della sessione (`not_found`) e 404 SENZA code (server senza le rotte) si distinguono", async () => {
    const onFatal = jest.fn();
    open({ onFatal });
    await flush();
    current().respond(404);
    current().emit(JSON.stringify({ code: "not_found", message: "Not found" }));
    current().finish();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeXhr.instances).toHaveLength(1);
    const sessionMissing = onFatal.mock.calls[0]![0] as ApiError;
    expect(sessionMissing.code).toBe("not_found");
    expect(isAgentSessionsUnavailable(sessionMissing)).toBe(false);

    handle?.close();
    FakeXhr.reset();
    onFatal.mockClear();
    open({ onFatal });
    await flush();
    current().respond(404);
    // Fastify, rotta non registrata: niente `code`.
    current().emit(
      JSON.stringify({
        message: "Route GET:/api/agent-sessions/x/stream not found",
        error: "Not Found",
        statusCode: 404,
      }),
    );
    current().finish();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(isAgentSessionsUnavailable(onFatal.mock.calls[0]![0])).toBe(true);
  });

  test("rotazione oltre la soglia: abort, riapertura IMMEDIATA dal cursore, niente eventi doppi", async () => {
    open({ after: "0", rotateAfterBytes: 50 });
    await flush();
    const first = current();
    first.emit(sseFrame({ type: "events", events: [event("1"), event("2")] }));

    expect(first.aborted).toBe(true);
    // Senza backoff: nessun timer da far scattare.
    await flush();
    expect(FakeXhr.instances).toHaveLength(2);
    expect(current().after).toBe("2");

    // Un progress tardivo della connessione abortita non consegna niente.
    first.onprogress?.();
    first.onload?.();
    current().emit(sseFrame({ type: "events", events: [event("3")] }));
    expect(eventIds(messages)).toEqual(["1", "2", "3"]);
    // `onload` della vecchia connessione non ha programmato riconnessioni.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeXhr.instances.filter((x) => !x.aborted).length).toBe(1);
  });

  test("la rotazione aspetta la fine del frame in corso (mai a metà frame)", async () => {
    open({ after: "0", rotateAfterBytes: 50 });
    await flush();
    const first = current();
    const second = sseFrame({ type: "events", events: [event("2")] });
    first.emit(sseFrame({ type: "events", events: [event("1")] }) + second.slice(0, 10));
    expect(first.aborted).toBe(false);

    first.emit(second.slice(10));
    expect(first.aborted).toBe(true);
    await flush();
    expect(current().after).toBe("2");
    expect(eventIds(messages)).toEqual(["1", "2"]);
  });

  test("ogni connessione nuova passa da `reconnecting` a `open` (chi mostra i parziali li azzera lì)", async () => {
    open({ after: "0", rotateAfterBytes: 50 });
    await flush();
    current().respond(200);
    current().emit(sseFrame({ type: "events", events: [event("1"), event("2")] }));
    await flush();
    current().respond(200);
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  test("un consumatore che lancia: l'errore va in console.error e NON è una caduta di rete", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = new Error("consumatore rotto");
    open({
      onMessage: (m) => {
        messages.push(m);
        if (messages.length === 1) throw boom;
      },
    });
    await flush();
    current().emit(
      sseFrame({ type: "events", events: [event("1")] }) +
        sseFrame({ type: "events", events: [event("2")] }),
    );
    expect(eventIds(messages)).toEqual(["1", "2"]);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(current().aborted).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), boom);
    consoleError.mockRestore();
  });

  test("un 200 che chiude subito senza frame: il backoff cresce; dopo un frame vero riparte da 0", async () => {
    const backoffMs = jest.fn<number, [number]>(() => 1_000);
    open({ backoffMs });
    await flush();
    current().finish(200);
    await jest.advanceTimersByTimeAsync(1_000);
    current().finish(200);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(backoffMs.mock.calls.map((c) => c[0])).toEqual([0, 1]);

    current().emit(sseFrame({ type: "partial", segmentId: "s", text: "x" }));
    current().finish(200);
    expect(backoffMs.mock.calls.map((c) => c[0])).toEqual([0, 1, 0]);
  });

  test("backoff di default: min(1000·2^n, 15000)", async () => {
    open({ backoffMs: undefined });
    await flush();
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const before = FakeXhr.instances.length;
      current().fail();
      let waited = 0;
      while (FakeXhr.instances.length === before) {
        await jest.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
  });

  test("close() durante l'attesa del backoff → nessuna nuova connessione", async () => {
    open();
    await flush();
    current().fail();
    expect(statuses.at(-1)).toBe("reconnecting");
    handle?.close();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe("closed");
  });

  test("close() con lo stream aperto abortisce e non riconnette", async () => {
    open();
    await flush();
    current().respond(200);
    handle?.close();
    expect(current().aborted).toBe(true);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe("closed");
  });

  test("close() chiamato da onMessage ferma la consegna dei frame successivi", async () => {
    open({
      onMessage: (m) => {
        messages.push(m);
        handle?.close();
      },
    });
    await flush();
    current().emit(
      sseFrame({ type: "events", events: [event("1")] }) +
        sseFrame({ type: "events", events: [event("2")] }),
    );
    expect(eventIds(messages)).toEqual(["1"]);
    expect(current().aborted).toBe(true);
  });

  test("close() prima che la sessione sia letta: nessuna connessione parte", async () => {
    open();
    handle?.close();
    await flush();
    expect(FakeXhr.instances).toHaveLength(0);
  });

  test("senza sessione salvata (logout) lo stream si chiude senza aprire connessioni", async () => {
    open({ loadSession: () => Promise.resolve(null) });
    await flush();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(statuses.at(-1)).toBe("closed");
  });

  test("un dettaglio `session` che non si parsa: un solo console.warn per stream", async () => {
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    open({ after: "2" });
    await flush();
    current().emit(
      sseFrame({ type: "session", detail: { id: "nope" } }) +
        sseFrame({ type: "session", detail: { id: "ancora" } }) +
        sseFrame({ type: "events", events: [event("3")] }),
    );
    expect(eventIds(messages)).toEqual(["3"]);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });
});
