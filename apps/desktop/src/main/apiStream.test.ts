// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/nonexistent" }, safeStorage: {}, MessageChannelMain: class {} }));

const { createStreamRegistry, MAX_STREAMS_PER_WINDOW, PING_TIMEOUT_MS } = await import("./apiStream");
type Msg = { type: string; [k: string]: unknown };

const S = "00000000-0000-4000-8000-0000000000a1";
const PATH = `/api/agent-sessions/${S}/stream?after=4`;

/** Una porta finta: registra ciò che il main manda, e può essere chiusa dal renderer. */
function fakePort() {
  const sent: Msg[] = [];
  const closeHandlers: (() => void)[] = [];
  let closed = false;
  return {
    sent,
    get closed() {
      return closed;
    },
    postMessage: (m: unknown) => sent.push(m as Msg),
    on: (event: "close", fn: () => void) => {
      if (event === "close") closeHandlers.push(fn);
    },
    start: () => {},
    close: () => {
      closed = true;
    },
    /** Il renderer chiude la sua estremità. */
    closeFromRenderer: () => closeHandlers.forEach((fn) => fn()),
  };
}

/** Un corpo SSE che si scrive a pezzi dal test. */
function sseBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  const enc = new TextEncoder();
  return {
    stream,
    push: (text: string) => controller.enqueue(enc.encode(text)),
    end: () => controller.close(),
  };
}

const event = (id: string) => ({ id, type: "assistant_text", segmentId: "s1", at: "2026-11-10T10:00:00.000Z", data: { text: id } });
const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const flush = () => new Promise((r) => setTimeout(r, 0));

function deps(over: Record<string, unknown> = {}) {
  return {
    instanceUrl: () => "https://example.com",
    token: () => "stw_pat_x",
    onUnauthorized: vi.fn(),
    fetch: vi.fn(),
    ...over,
  };
}

describe("stream delle sessioni via IPC (main)", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("apre col Bearer sul percorso dell'allowlist e inoltra i frame veri, nella forma del parse di shared", async () => {
    const body = sseBody();
    const d = deps({ fetch: vi.fn(async () => new Response(body.stream, { status: 200, headers: { "content-type": "text/event-stream" } })) });
    const registry = createStreamRegistry(d);
    const port = fakePort();
    registry.open(1, PATH, port);
    await flush();
    const [url, init] = d.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://example.com${PATH}`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer stw_pat_x");
    expect((init.headers as Record<string, string>).accept).toBe("text/event-stream");
    body.push(": ping\n\n");
    body.push(frame({ type: "events", events: [event("5")] }).slice(0, 20));
    await flush();
    body.push(frame({ type: "events", events: [event("5")] }).slice(20));
    await flush();
    expect(port.sent.map((m) => m.type)).toEqual(["open", "frame"]);
    expect(port.sent[1]).toMatchObject({ type: "frame", lastId: "5", messages: [{ type: "events", events: [{ id: "5" }] }] });
    // Fine del corpo: il main NON riconnette, lo dice al renderer (che riparte da ?after=).
    body.end();
    await flush();
    expect(port.sent.at(-1)).toMatchObject({ type: "end", reason: "network", fatal: false });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(registry.count(1)).toBe(0);
  });

  it("un percorso fuori allowlist non apre nessuna connessione", async () => {
    const d = deps();
    const registry = createStreamRegistry(d);
    for (const bad of ["/api/tickets", `/api/agent-sessions/${S}/events`, `/api/agent-sessions/${S}/stream?after=1&x=2`, 42]) {
      const port = fakePort();
      registry.open(1, bad, port);
      expect(port.sent).toEqual([{ type: "end", reason: "rejected", fatal: true }]);
      expect(port.closed).toBe(true);
    }
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("401 di sessione: fine fatale e il token si cancella (endsSession); 404 fatale senza toccare il token; 5xx non fatale", async () => {
    const respond = (status: number, code: string) => async () =>
      new Response(JSON.stringify({ code }), { status, headers: { "content-type": "application/json" } });
    for (const [status, code, fatal, clears] of [
      [401, "unauthorized", true, true],
      [404, "not_found", true, false],
      [502, "bad_gateway", false, false],
    ] as const) {
      const d = deps({ fetch: vi.fn(respond(status, code)) });
      const port = fakePort();
      createStreamRegistry(d).open(1, PATH, port);
      await flush();
      await flush();
      expect(port.sent.at(-1)).toMatchObject({ type: "end", status, fatal, ...(fatal ? { code } : {}) });
      expect(d.onUnauthorized).toHaveBeenCalledTimes(clears ? 1 : 0);
    }
  });

  it("un 3xx è fatale («redirect»): il main non segue né riprova un reindirizzamento", async () => {
    const d = deps({ fetch: vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })) });
    const port = fakePort();
    createStreamRegistry(d).open(1, PATH, port);
    await flush();
    await flush();
    expect(port.sent.at(-1)).toMatchObject({ type: "end", reason: "redirect", fatal: true, status: 302 });
  });

  it("il frame porta `real` del parse: un frame con solo un session illeggibile arriva, segnalato", async () => {
    const body = sseBody();
    const d = deps({ fetch: vi.fn(async () => new Response(body.stream, { status: 200 })) });
    const port = fakePort();
    createStreamRegistry(d).open(1, PATH, port);
    await flush();
    body.push(frame({ type: "session", detail: { id: "x" } }));
    await flush();
    await flush();
    expect(port.sent.find((m) => m.type === "frame")).toMatchObject({ real: true, invalidSession: true, messages: [] });
  });

  it("al più MAX_STREAMS_PER_WINDOW per finestra; chiudere la porta libera il posto e annulla il fetch", async () => {
    const signals: AbortSignal[] = [];
    const d = deps({
      fetch: vi.fn(async (_url: string, init: RequestInit) => {
        signals.push(init.signal!);
        return new Response(sseBody().stream, { status: 200 });
      }),
    });
    const registry = createStreamRegistry(d);
    const ports = Array.from({ length: MAX_STREAMS_PER_WINDOW }, () => fakePort());
    ports.forEach((p) => registry.open(7, PATH, p));
    await flush();
    expect(registry.count(7)).toBe(MAX_STREAMS_PER_WINDOW);
    const extra = fakePort();
    registry.open(7, PATH, extra);
    expect(extra.sent).toEqual([{ type: "end", reason: "limit", fatal: true }]);
    // Un'altra finestra ha il suo tetto.
    const other = fakePort();
    registry.open(8, PATH, other);
    expect(other.sent).not.toContainEqual(expect.objectContaining({ reason: "limit" }));
    ports[0]!.closeFromRenderer();
    expect(signals[0]!.aborted).toBe(true);
    expect(registry.count(7)).toBe(MAX_STREAMS_PER_WINDOW - 1);
    // Chiudere la finestra chiude tutto.
    registry.closeWindow(7);
    expect(registry.count(7)).toBe(0);
    expect(signals.slice(1, MAX_STREAMS_PER_WINDOW).every((s) => s.aborted)).toBe(true);
  });

  it("nessun byte per PING_TIMEOUT_MS (neanche un ping): si chiude, fine non fatale «timeout»", async () => {
    vi.useFakeTimers();
    const body = sseBody();
    let signal: AbortSignal | undefined;
    const d = deps({
      fetch: vi.fn(async (_u: string, init: RequestInit) => {
        signal = init.signal!;
        return new Response(body.stream, { status: 200 });
      }),
    });
    const port = fakePort();
    createStreamRegistry(d).open(1, PATH, port);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS - 1000);
    body.push(": ping\n\n");
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS - 1000);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(signal!.aborted).toBe(true);
    expect(port.sent.at(-1)).toMatchObject({ type: "end", reason: "timeout", fatal: false });
  });

  it("oltre 1 MB ricevuto la connessione ruota: fine non fatale «rotate», il renderer riparte dal cursore", async () => {
    const body = sseBody();
    const d = deps({ fetch: vi.fn(async () => new Response(body.stream, { status: 200 })) });
    const port = fakePort();
    createStreamRegistry(d).open(1, PATH, port);
    await flush();
    body.push(frame({ type: "events", events: [{ ...event("9"), data: { text: "x".repeat(1024 * 1024) } }] }));
    await flush();
    await flush();
    expect(port.sent.find((m) => m.type === "frame")).toMatchObject({ lastId: "9" });
    expect(port.sent.at(-1)).toMatchObject({ type: "end", reason: "rotate", fatal: false });
  });
});

describe("stream della Chat via IPC (main, area 4 fetta 1)", () => {
  const CH = "00000000-0000-4000-8000-0000000000c1";
  const CHAT_PATH = `/api/chat/channels/${CH}/stream?after=1731230400000000`;
  const message = { id: "00000000-0000-4000-8000-0000000000d1", channelId: CH, authorId: null, text: "Ciao", createdAt: "2026-11-10T10:00:00.000Z" };

  it("apre /api/chat/…/stream col Bearer e inoltra i frame della Chat (messaggi col cursore)", async () => {
    const body = sseBody();
    const d = deps({ fetch: vi.fn(async () => new Response(body.stream, { status: 200, headers: { "content-type": "text/event-stream" } })) });
    const registry = createStreamRegistry(d);
    const port = fakePort();
    registry.open(1, CHAT_PATH, port);
    await flush();
    const [url, init] = d.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://example.com${CHAT_PATH}`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer stw_pat_x");
    body.push(": ping\n\n");
    body.push(frame({ type: "messages", messages: [message], cursor: "1731230400000001" }));
    await flush();
    expect(port.sent.map((m) => m.type)).toEqual(["open", "chatFrame"]);
    expect(port.sent[1]).toMatchObject({
      type: "chatFrame",
      cursor: "1731230400000001",
      messages: [{ type: "messages", messages: [{ id: message.id }] }],
    });
    body.end();
    await flush();
    expect(port.sent.at(-1)).toMatchObject({ type: "end", fatal: false });
  });

  it("un percorso della Chat fuori elenco non apre nessuna connessione", async () => {
    const d = deps();
    const registry = createStreamRegistry(d);
    for (const bad of [
      `/api/chat/channels/${CH}/messages`,
      `/api/chat/channels/${CH}/stream?after=abc`,
      `/api/chat/channels/not-a-uuid/stream`,
      `/api/chat/channels/${CH}/stream?after=1&x=2`,
    ]) {
      const port = fakePort();
      registry.open(1, bad, port);
      expect(port.sent).toEqual([{ type: "end", reason: "rejected", fatal: true }]);
    }
    expect(d.fetch).not.toHaveBeenCalled();
  });
});

describe("la bozza di Claude per la Posta via IPC (main, area 6 F3)", () => {
  const MAIL = "/api/me/mail/drafts/claude";
  const ACC = "aaaaaaaa-1111-4111-8111-111111111111";
  const PRJ = "22222222-2222-4222-8222-222222222222";
  const body = { accountId: ACC, threadId: "t-1", mode: "reply", hint: "digli che slitta", projectId: null };

  it("è un POST col Bearer e il corpo JSON validato nel main; i pezzi arrivano come mailDraft", async () => {
    const sse = sseBody();
    const d = deps({ fetch: vi.fn(async () => new Response(sse.stream, { status: 200, headers: { "content-type": "text/event-stream" } })) });
    const registry = createStreamRegistry(d);
    const port = fakePort();
    registry.open(1, MAIL, port, { body: { ...body, extra: "via" } });
    await flush();
    const [url, init] = d.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://example.com${MAIL}`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer stw_pat_x");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(body);
    sse.push(frame({ type: "delta", text: "Ciao" }));
    sse.push(frame({ type: "done", text: "Ciao Bob", projectId: PRJ, used: [] }));
    sse.push("data: non json\n\n");
    sse.end();
    await flush();
    await flush();
    expect(port.sent.filter((m) => m.type === "mailDraft")).toEqual([
      { type: "mailDraft", event: { type: "delta", text: "Ciao" } },
      { type: "mailDraft", event: { type: "done", text: "Ciao Bob", projectId: PRJ, used: [] } },
    ]);
  });

  it("un errore a metà arriva come mailDraft", async () => {
    const sse = sseBody();
    const d = deps({ fetch: vi.fn(async () => new Response(sse.stream, { status: 200 })) });
    const port = fakePort();
    createStreamRegistry(d).open(1, MAIL, port, { body });
    await flush();
    sse.push(frame({ type: "error", code: "claude_unavailable" }));
    sse.end();
    await flush();
    await flush();
    expect(port.sent).toContainEqual({ type: "mailDraft", event: { type: "error", code: "claude_unavailable" } });
  });

  it("un rifiuto prima dello stream (409 budget_exhausted): end col codice", async () => {
    const d = deps({ fetch: vi.fn(async () => new Response(JSON.stringify({ code: "budget_exhausted", message: "x" }), { status: 409 })) });
    const port = fakePort();
    createStreamRegistry(d).open(1, MAIL, port, { body });
    await flush();
    await flush();
    expect(port.sent.at(-1)).toMatchObject({ type: "end", reason: "http", status: 409, code: "budget_exhausted" });
  });

  it("solo il percorso esatto, solo con un corpo valido: il resto è rifiutato senza chiamare", async () => {
    const d = deps();
    const registry = createStreamRegistry(d);
    const cases: [string, unknown][] = [
      [MAIL, undefined],
      [MAIL, "testo"],
      [MAIL, { ...body, accountId: "non-uuid" }],
      [MAIL, { ...body, mode: "sendNow" }],
      // Il tetto del server (2000), non uno più largo.
      [MAIL, { ...body, hint: "x".repeat(2001) }],
      [MAIL, { ...body, threadId: 42 }],
      [`${MAIL}?x=1`, body],
      [`${MAIL}/x`, body],
      ["/api/me/mail/drafts", body],
    ];
    for (const [path, b] of cases) {
      const port = fakePort();
      registry.open(1, path, port, { body: b });
      expect(port.sent.at(-1), `${path} ${JSON.stringify(b)}`).toMatchObject({ type: "end", reason: "rejected", fatal: true });
    }
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("uno stream di una sessione con un corpo resta un GET (il corpo non passa)", async () => {
    const d = deps({ fetch: vi.fn(async () => new Response(sseBody().stream, { status: 200 })) });
    createStreamRegistry(d).open(1, PATH, fakePort(), { body });
    await flush();
    const [, init] = d.fetch.mock.calls[0]! as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});
