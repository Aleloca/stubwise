import { parseChatStreamFrame } from "@stubwise/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageView } from "../../types";
import { setAppClientForTests } from "./client";
import { forgetPeopleChatCaches } from "./chat";
import {
  CHAT_PING_TIMEOUT_MS,
  channelStream,
  onChatChange,
  openChatConnections,
  resetChatStreams,
  setChatStreamTransport,
  subscribeChat,
  threadStream,
  type ChatStreamHandlers,
} from "./chatStream";
import { installFakeServer } from "./fakeServer";

// Lo stream dal vivo di un canale della Chat nella build app (area 4, fetta 1):
// un SSE per canale; il thread ascolta lo stesso canale e tiene la radice e le
// sue risposte. Si riprende dal cursore del server, e un 404 chiude.

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const ROOT = "7f1c2a1e-0000-4000-8000-0000000000d1";
const REPLY = "7f1c2a1e-0000-4000-8000-0000000000d2";
const OTHER = "7f1c2a1e-0000-4000-8000-0000000000d3";
const msg = (over: Record<string, unknown> = {}) => ({
  id: ROOT,
  channelId: CH,
  threadRootId: null,
  authorId: null,
  kind: "person",
  text: "Ciao",
  createdAt: "2026-11-10T10:00:00.000Z",
  ...over,
});

/** Un trasporto finto: tiene i percorsi aperti e lascia mandare frame e fine. */
let opened: { path: string; handlers: ChatStreamHandlers; closed: boolean }[] = [];
beforeEach(() => {
  opened = [];
  setAppClientForTests(null);
  resetChatStreams();
  forgetPeopleChatCaches();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setChatStreamTransport((path, handlers) => {
    const entry = { path, handlers, closed: false };
    opened.push(entry);
    return () => {
      entry.closed = true;
    };
  });
});
afterEach(() => {
  setChatStreamTransport(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Un frame come lo consegna il trasporto: già letto da `parseChatStreamFrame` (coi default). */
const messages = (list: unknown[], cursor: string | null = null) =>
  parseChatStreamFrame(`data: ${JSON.stringify({ type: "messages", messages: list, cursor })}`);

describe("lo stream di un canale", () => {
  it("le radici arrivano (nuove e cambiate), le risposte dei thread no; un cambio avvisa le letture", async () => {
    const got: [string, string][] = [];
    const changes: string[] = [];
    const offChange = onChatChange((id) => changes.push(id));
    const stop = subscribeChat(channelStream(CH), (m: ChatMessageView, mode) => got.push([m.id, mode]));
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]!.path).toBe(`/api/chat/channels/${CH}/stream`);
    opened[0]!.handlers.onFrame(messages([msg(), msg({ id: REPLY, threadRootId: ROOT })], "100"));
    opened[0]!.handlers.onFrame(messages([msg({ text: "Ciao!" })], "101"));
    expect(got).toEqual([
      [ROOT, "append"],
      [ROOT, "update"],
    ]);
    expect(changes).toContain(CH);
    stop();
    offChange();
    expect(opened[0]!.closed).toBe(true);
  });

  it("una caduta riprende dal cursore dell'ultimo frame; un 404 chiude e lo dice", async () => {
    const connection = vi.fn();
    subscribeChat(channelStream(CH), () => undefined, { onConnection: connection });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    opened[0]!.handlers.onFrame(messages([msg()], "200"));
    opened[0]!.handlers.onClose({});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opened).toHaveLength(2);
    expect(opened[1]!.path).toBe(`/api/chat/channels/${CH}/stream?after=200`);
    opened[1]!.handlers.onClose({ fatal: true, status: 404 });
    expect(connection).toHaveBeenCalledWith("closed");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(opened).toHaveLength(2);
  });
});

describe("lo stream di un thread", () => {
  it("ascolta il canale della radice e tiene solo la radice e le sue risposte", async () => {
    installFakeServer({ [`GET /api/chat/messages/${ROOT}`]: { body: msg({ replyCount: 1 }) } });
    const got: string[] = [];
    subscribeChat(threadStream(ROOT), (m) => got.push(`${m.id}:${m.threadOf ?? "root"}`));
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]!.path).toBe(`/api/chat/channels/${CH}/stream`);
    opened[0]!.handlers.onFrame(
      messages([msg({ replyCount: 2 }), msg({ id: REPLY, threadRootId: ROOT }), msg({ id: OTHER }), msg({ id: "x", threadRootId: OTHER })]),
    );
    expect(got).toEqual([`${ROOT}:root`, `${REPLY}:${ROOT}`]);
  });
});

describe("review della fetta 1", () => {
  const later = (id: string, at: string, over: Record<string, unknown> = {}) => msg({ id, createdAt: at, ...over });

  it("il thread non apre un secondo SSE: riusa la connessione del suo canale", async () => {
    installFakeServer({ [`GET /api/chat/messages/${ROOT}`]: { body: msg({ replyCount: 1 }) } });
    const stopChannel = subscribeChat(channelStream(CH), () => undefined);
    const stopThread = subscribeChat(threadStream(ROOT), () => undefined);
    await vi.waitFor(() => expect(openChatConnections()).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toHaveLength(1);
    stopThread();
    expect(opened[0]!.closed).toBe(false);
    stopChannel();
    expect(opened[0]!.closed).toBe(true);
  });

  it("un messaggio già visto o più vecchio dell'ultimo è «cambiato», non «arrivato»", async () => {
    const got: [string, string][] = [];
    subscribeChat(channelStream(CH), (m, mode) => got.push([m.id, mode]));
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    opened[0]!.handlers.onFrame(messages([later(ROOT, "2026-11-10T10:05:00.000Z")], "1"));
    // La finestra di sovrapposizione: un messaggio più vecchio, mai visto da qui, e uno ripetuto.
    opened[0]!.handlers.onFrame(messages([later(OTHER, "2026-11-10T10:01:00.000Z"), later(ROOT, "2026-11-10T10:05:00.000Z")], "2"));
    opened[0]!.handlers.onFrame(messages([later(REPLY, "2026-11-10T10:06:00.000Z")], "3"));
    expect(got).toEqual([
      [ROOT, "append"],
      [OTHER, "update"],
      [ROOT, "update"],
      [REPLY, "append"],
    ]);
  });

  it("la vista del canale avvisa le letture solo se cambia davvero (non a ogni frame)", async () => {
    const changes: string[] = [];
    onChatChange((id) => changes.push(id));
    subscribeChat(channelStream(CH), () => undefined);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const channel = (unread: number) =>
      parseChatStreamFrame(`data: ${JSON.stringify({ type: "channel", channel: { id: CH, kind: "project", projectId: null, name: "design", createdAt: "2026-11-10T09:00:00.000Z", unread } })}`);
    opened[0]!.handlers.onFrame(channel(0));
    opened[0]!.handlers.onFrame(channel(0));
    expect(changes).toEqual([]);
    opened[0]!.handlers.onFrame(channel(1));
    expect(changes).toEqual([CH]);
  });

  it("alla ripresa dopo una caduta si rilegge la pagina: un messaggio arrivato nel buco non si perde", async () => {
    const { seen } = installFakeServer({
      [`GET /api/chat/channels/${CH}/messages`]: { body: { items: [later(OTHER, "2026-11-10T10:03:00.000Z")], before: null } },
    });
    const got: string[] = [];
    subscribeChat(channelStream(CH), (m) => got.push(m.id));
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    opened[0]!.handlers.onFrame(messages([later(ROOT, "2026-11-10T10:00:00.000Z")], "1"));
    opened[0]!.handlers.onClose({});
    await vi.advanceTimersByTimeAsync(2_000);
    opened[1]!.handlers.onFrame(messages([], "2"));
    await vi.waitFor(() => expect(got).toContain(OTHER));
    expect(seen.some((r) => r.path.startsWith(`/api/chat/channels/${CH}/messages`))).toBe(true);
  });

  it("i cambi di persona chiudono le iscrizioni, non chi rinfresca le letture", async () => {
    const changes: string[] = [];
    onChatChange((id) => changes.push(id));
    resetChatStreams();
    subscribeChat(channelStream(CH), () => undefined);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    opened[0]!.handlers.onFrame(messages([msg()], "1"));
    expect(changes).toEqual([CH]);
  });

  it("la radice di un thread: su un errore di rete si riprova; su un 404 si chiude", async () => {
    let calls = 0;
    installFakeServer({
      [`GET /api/chat/messages/${ROOT}`]: () => (++calls === 1 ? { status: 503, body: { code: "x", message: "x" } } : { body: msg() }),
    });
    subscribeChat(threadStream(ROOT), () => undefined);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(calls).toBe(2);
  });

  it("troppi stream per la finestra (il main): un messaggio suo, non «closed»", async () => {
    const connection = vi.fn();
    subscribeChat(channelStream(CH), () => undefined, { onConnection: connection });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    opened[0]!.handlers.onClose({ fatal: true, limit: true });
    expect(connection).toHaveBeenCalledWith("limit");
  });
});

describe("il trasporto web", () => {
  it("senza un byte per 60 s (neanche un ping) si chiude e si riparte", async () => {
    setChatStreamTransport(null);
    const fetches = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { status: 200 }));
    vi.stubGlobal("fetch", fetches);
    subscribeChat(channelStream(CH), () => undefined);
    await vi.waitFor(() => expect(fetches).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(CHAT_PING_TIMEOUT_MS + 2_000);
    await vi.waitFor(() => expect(fetches).toHaveBeenCalledTimes(2));
  });
});
