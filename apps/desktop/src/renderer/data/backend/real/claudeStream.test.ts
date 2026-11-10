import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../../types";
import { setAppClientForTests } from "./client";
import { IDLE_SESSIONS_MAX, MAX_STREAMS, reconnectDelay, rememberedSessions, resetStreamsForTests, subscribe } from "./claudeStream";
import { PROJECT_ID, serverProject, TICKET_ID } from "./fakeServer";

// Lo stream dal vivo di una sessione nella build app web (fetta 3a): `fetch`
// streaming col cookie, frame SSE letti col modulo condiviso, ripresa dal
// cursore `?after=` senza eventi doppi né persi.

const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
const JOB = "bbbbbbbb-0000-4000-8000-000000000001";
const detail = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  kind: "ai_job",
  title: "Fix the CSV export",
  projectId: PROJECT_ID,
  projectName: "Audin AI",
  ticketId: TICKET_ID,
  ticketNumber: 12,
  aiJobId: JOB,
  startedAt: "2026-11-10T09:00:00.000Z",
  lastEventAt: null,
  state: "working",
  questions: [],
  inputs: [],
  ...over,
});
const ev = (id: string, type: string, data: Record<string, unknown>) => ({
  id,
  type,
  segmentId: "s1",
  at: `2026-11-10T09:00:0${id}.000Z`,
  data,
});
const frame = (message: unknown) => `data: ${JSON.stringify(message)}\n\n`;

/** Uno stream controllabile: `push` manda testo, `end` lo chiude, `fail` lo fa cadere. */
interface FakeStream {
  path: string;
  signal: AbortSignal | undefined;
  push(text: string): void;
  end(): void;
  fail(): void;
}

let streams: FakeStream[] = [];
let streamStatus = 200;
let workPlanStatus: string | null = null;
let workReads = 0;

beforeEach(() => {
  streams = [];
  streamStatus = 200;
  workPlanStatus = null;
  workReads = 0;
  setAppClientForTests(null);
  resetStreamsForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path.includes("/stream")) {
        if (streamStatus !== 200) {
          return new Response(JSON.stringify({ code: "not_found", message: "x" }), { status: streamStatus });
        }
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
        const enc = new TextEncoder();
        streams.push({
          path,
          signal: init.signal ?? undefined,
          push: (text) => controller.enqueue(enc.encode(text)),
          end: () => controller.close(),
          fail: () => controller.error(new TypeError("network")),
        });
        init.signal?.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            /* già chiuso */
          }
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (path.startsWith("/api/projects")) return Response.json([serverProject()]);
      if (path.startsWith(`/api/tasks/${TICKET_ID}/work`)) {
        workReads += 1;
        return Response.json({
          claude: "working",
          webHref: "/x",
          runs: [
            {
              id: JOB,
              sessionId: SESSION,
              createdAt: "2026-11-10T09:00:00.000Z",
              state: "awaiting_approval",
              plan: workPlanStatus
                ? { text: "1. Do it", summary: "Do it", status: workPlanStatus, at: "2026-11-10T09:00:05.000Z" }
                : null,
            },
          ],
        });
      }
      return new Response(JSON.stringify({ code: "not_found", message: path }), { status: 404 });
    }),
  );
});

afterEach(() => {
  resetStreamsForTests();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

function collect() {
  const events: ConversationEvent[] = [];
  const connections: string[] = [];
  const onEvent = (e: ConversationEvent) => {
    const i = events.findIndex((x) => x.id === e.id);
    if (i === -1) events.push(e);
    else events[i] = e;
  };
  return { events, connections, onEvent, onConnection: (c: string) => connections.push(c) };
}

describe("lo stream di una sessione", () => {
  it("gli eventi arrivano tradotti; un parziale aggiorna il messaggio dal vivo", async () => {
    const c = collect();
    const stop = subscribe(SESSION, c.onEvent, { onConnection: c.onConnection });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(streams[0]!.path).toBe(`/api/agent-sessions/${SESSION}/stream`);
    streams[0]!.push(frame({ type: "session", detail: detail() }));
    streams[0]!.push(frame({ type: "events", events: [ev("1", "segment_start", { label: "execute", interactive: false })] }));
    streams[0]!.push(frame({ type: "partial", segmentId: "s1", text: "Look" }));
    await vi.waitFor(() => expect(c.events.map((e) => e.type)).toEqual(["phase", "assistant"]));
    streams[0]!.push(frame({ type: "partial", segmentId: "s1", text: "ing at it." }));
    await vi.waitFor(() =>
      expect(c.events.find((e) => e.type === "assistant")).toMatchObject({ text: "Looking at it.", done: false }),
    );
    stop();
    expect(streams[0]!.signal?.aborted).toBe(true);
  });

  it("caduto lo stream, la ripresa riparte dal cursore: niente doppi né persi", async () => {
    const c = collect();
    subscribe(SESSION, c.onEvent, { onConnection: c.onConnection });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push(frame({ type: "session", detail: detail() }));
    streams[0]!.push(
      frame({
        type: "events",
        events: [ev("1", "segment_start", { label: "execute", interactive: false }), ev("2", "assistant_text", { text: "One." })],
      }),
    );
    await vi.waitFor(() => expect(c.events).toHaveLength(2));
    streams[0]!.fail();
    await vi.waitFor(() => expect(c.connections).toEqual(["reconnecting"]));
    expect(reconnectDelay()).toBeGreaterThan(0);

    // L'hook si riscrive con l'ultimo evento ricevuto: lo stream riparte da `?after=2`.
    subscribe(SESSION, c.onEvent, { afterEventId: c.events.at(-1)!.id, onConnection: c.onConnection });
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(streams[1]!.path).toBe(`/api/agent-sessions/${SESSION}/stream?after=2`);
    streams[1]!.push(frame({ type: "events", events: [ev("3", "assistant_text", { text: "Two." })] }));
    await vi.waitFor(() => expect(c.events).toHaveLength(3));
    expect(c.events.filter((e) => e.type === "assistant").map((e) => (e as { text: string }).text)).toEqual([
      "One.",
      "Two.",
    ]);
  });

  it("una sessione che non si vede (404): chiuso, nessun evento", async () => {
    streamStatus = 404;
    const c = collect();
    subscribe(SESSION, c.onEvent, { onConnection: c.onConnection });
    await vi.waitFor(() => expect(c.connections).toEqual(["closed"]));
    expect(c.events).toEqual([]);
  });

  it("al più MAX_STREAMS stream aperti; chiudendone uno ne parte un altro", async () => {
    const stops = Array.from({ length: MAX_STREAMS + 1 }, (_, i) =>
      subscribe(`aaaaaaaa-0000-4000-8000-00000000010${i.toString(16)}`, () => undefined),
    );
    await vi.waitFor(() => expect(streams).toHaveLength(MAX_STREAMS));
    await new Promise((r) => setTimeout(r, 20));
    expect(streams).toHaveLength(MAX_STREAMS);
    stops[0]!();
    await vi.waitFor(() => expect(streams).toHaveLength(MAX_STREAMS + 1));
    for (const stop of stops) stop();
  });

  it("sul desktop lo stream lo apre il main: frame già letti, «rotate» riapre dal cursore, una fine fatale chiude", async () => {
    const opened: { path: string; send: (m: StubwiseStreamMessage) => void; closed: boolean }[] = [];
    vi.stubGlobal("stubwise", {
      api: { request: vi.fn() },
      openStream: (path: string, onMessage: (m: StubwiseStreamMessage) => void) => {
        const entry = { path, send: onMessage, closed: false };
        opened.push(entry);
        return () => {
          entry.closed = true;
        };
      },
    });
    const c = collect();
    const stop = subscribe(SESSION, c.onEvent, { onConnection: c.onConnection });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    opened[0]!.send({ type: "open" });
    opened[0]!.send({
      type: "frame",
      messages: [
        { type: "session", detail: detail() as never },
        { type: "events", events: [ev("1", "segment_start", { label: "execute", interactive: false }) as never] },
      ],
      lastId: "1",
      invalidSession: false,
    });
    await vi.waitFor(() => expect(c.events.map((e) => e.type)).toEqual(["phase"]));
    opened[0]!.send({ type: "end", reason: "rotate", fatal: false });
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[1]!.path).toBe(`/api/agent-sessions/${SESSION}/stream?after=1`);
    expect(c.connections).toEqual([]);
    opened[1]!.send({ type: "end", reason: "http", fatal: true, status: 404 });
    await vi.waitFor(() => expect(c.connections).toEqual(["closed"]));
    stop();
  });

  it("approvato da un altro: la scheda del piano passa ad approved senza ricaricare, ed è una sola", async () => {
    workPlanStatus = "pending";
    const c = collect();
    subscribe(SESSION, c.onEvent, { onConnection: c.onConnection });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push(frame({ type: "session", detail: detail({ state: "awaiting_approval" }) }));
    await vi.waitFor(() => expect(c.events.find((e) => e.type === "plan")).toMatchObject({ status: "pending" }));
    workPlanStatus = "approved";
    streams[0]!.push(frame({ type: "session", detail: detail({ state: "working" }) }));
    await vi.waitFor(() => expect(c.events.find((e) => e.type === "plan")).toMatchObject({ status: "approved" }));
    expect(c.events.filter((e) => e.type === "plan").map((e) => e.id)).toEqual([`plan:${JOB}`]);
  });

  it("il piano non si rilegge a ogni frame: solo quando cambia il dettaglio", async () => {
    workPlanStatus = "pending";
    const c = collect();
    subscribe(SESSION, c.onEvent);
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.push(frame({ type: "session", detail: detail() }));
    streams[0]!.push(frame({ type: "session", detail: detail() }));
    streams[0]!.push(frame({ type: "session", detail: detail() }));
    await vi.waitFor(() => expect(c.events.some((e) => e.type === "plan")).toBe(true));
    expect(workReads).toBe(1);
  });

  it("il backoff è per sessione, e un frame «session» da solo non lo azzera", async () => {
    const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
    const fail = async (n: number) => {
      subscribe(SESSION, () => undefined, { onConnection: () => undefined });
      await vi.waitFor(() => expect(streams).toHaveLength(n));
      streams[n - 1]!.push(frame({ type: "session", detail: detail() }));
      await new Promise((r) => setTimeout(r, 5));
      streams[n - 1]!.fail();
      await new Promise((r) => setTimeout(r, 5));
    };
    await fail(1);
    await fail(2);
    expect(reconnectDelay(SESSION)).toBe(2000);
    expect(reconnectDelay(OTHER)).toBe(1000);
    // Un evento vero azzera.
    subscribe(SESSION, () => undefined, { onConnection: () => undefined });
    await vi.waitFor(() => expect(streams).toHaveLength(3));
    streams[2]!.push(frame({ type: "events", events: [ev("1", "assistant_text", { text: "Hi" })] }));
    await new Promise((r) => setTimeout(r, 5));
    streams[2]!.fail();
    await new Promise((r) => setTimeout(r, 5));
    expect(reconnectDelay(SESSION)).toBe(1000);
  });

  it("le sessioni non ascoltate si dimenticano oltre le ultime IDLE_SESSIONS_MAX", () => {
    for (let i = 0; i < IDLE_SESSIONS_MAX + 5; i++) {
      const stop = subscribe(`aaaaaaaa-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`, () => undefined);
      stop();
    }
    expect(rememberedSessions()).toBe(IDLE_SESSIONS_MAX);
  });
});
