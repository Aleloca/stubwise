import { describe, expect, it } from "vitest";
import { chatStreamPath, isAllowedChatStreamPath, parseChatStreamFrame } from "./sse.js";

// Lo stream SSE di un canale della Chat (area 4, fetta 1): la parte pura che
// usano il renderer web e il main di Electron.

const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
const message = { id: "7f1c2a1e-0000-4000-8000-0000000000d1", channelId: CH, authorId: null, text: "Ciao", createdAt: "2026-11-10T10:00:00.000Z" };
const channel = { id: CH, kind: "project", projectId: null, name: "general", createdAt: "2026-11-10T10:00:00.000Z" };
const data = (v: unknown) => `data: ${JSON.stringify(v)}`;

describe("parseChatStreamFrame", () => {
  it("messaggi (col cursore) e canale, parsati con gli schemi del client", () => {
    const m = parseChatStreamFrame(data({ type: "messages", messages: [message], cursor: "1731230400000000" }));
    expect(m).toMatchObject({ real: true, cursor: "1731230400000000" });
    expect(m.messages).toEqual([{ type: "messages", messages: [expect.objectContaining({ id: message.id, deleted: false, reactions: [] })] }]);
    const c = parseChatStreamFrame(data({ type: "channel", channel }));
    expect(c).toMatchObject({ real: true, cursor: null });
    expect(c.messages[0]).toMatchObject({ type: "channel", channel: { id: CH, canWrite: false } });
  });

  it("un ping, un JSON rotto, un tipo ignoto o un messaggio malformato: nessun dato, non vero", () => {
    expect(parseChatStreamFrame(": ping")).toEqual({ messages: [], cursor: null, real: false });
    expect(parseChatStreamFrame("data: {rotto")).toMatchObject({ real: false });
    expect(parseChatStreamFrame(data({ type: "nuovo" }))).toMatchObject({ real: false });
    const bad = parseChatStreamFrame(data({ type: "messages", messages: [{ id: 1 }, message], cursor: "12" }));
    expect(bad.messages).toEqual([{ type: "messages", messages: [expect.objectContaining({ id: message.id })] }]);
    expect(bad.cursor).toBe("12");
  });

  it("un cursore che non è di sole cifre non si tiene", () => {
    expect(parseChatStreamFrame(data({ type: "messages", messages: [], cursor: "../x" })).cursor).toBeNull();
  });
});

describe("percorso e allowlist", () => {
  it("il percorso del canale, col cursore se c'è", () => {
    expect(chatStreamPath(CH)).toBe(`/api/chat/channels/${CH}/stream`);
    expect(chatStreamPath(CH, "1731230400000000")).toBe(`/api/chat/channels/${CH}/stream?after=1731230400000000`);
  });

  it("apre solo lo stream di un canale (uuid) col cursore di cifre; nient'altro", () => {
    expect(isAllowedChatStreamPath(`/api/chat/channels/${CH}/stream`)).toBe(true);
    expect(isAllowedChatStreamPath(`/api/chat/channels/${CH}/stream?after=12345678901234567890`)).toBe(true);
    for (const path of [
      `/api/chat/channels/${CH}/stream?after=123456789012345678901`,
      `/api/chat/channels/${CH}/stream?after=abc`,
      `/api/chat/channels/${CH}/messages`,
      `/api/chat/channels/not-a-uuid/stream`,
      `/api/chat/channels/${CH}/stream/../../tasks`,
      `https://evil.example/api/chat/channels/${CH}/stream`,
      `/api/agent-sessions/${CH}/stream`,
    ]) {
      expect(isAllowedChatStreamPath(path), path).toBe(false);
    }
  });
});
