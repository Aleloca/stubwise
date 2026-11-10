import { parseChatStreamFrame } from "@stubwise/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageView } from "../../types";
import { setAppClientForTests } from "./client";
import { forgetPeopleChatCaches } from "./chat";
import {
  channelStream,
  onChatChange,
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
