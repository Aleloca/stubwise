import { describe, expect, it } from "vitest";
import {
  AGENT_STREAM_MAX_BYTES,
  agentStreamPath,
  isAllowedAgentStreamPath,
  parseAgentStreamFrame,
  splitSseFrames,
  streamBackoffMs,
} from "./sse.js";

const S = "00000000-0000-4000-8000-0000000000a1";
const ev = (id: string, type = "assistant_text") => ({ id, type, segmentId: "s1", at: "2026-11-10T10:00:00.000Z", data: { text: id } });

describe("splitSseFrames", () => {
  it("separa i frame su \\n\\n e tiene il resto incompleto per il giro dopo", () => {
    expect(splitSseFrames("data: 1\n\ndata: 2\n\ndata: 3")).toEqual({ frames: ["data: 1", "data: 2"], rest: "data: 3" });
    expect(splitSseFrames("")).toEqual({ frames: [], rest: "" });
  });
  it("accetta anche \\r\\n (un proxy che riscrive le righe)", () => {
    expect(splitSseFrames("data: 1\r\n\r\ndata: 2\r\n\r\n")).toEqual({ frames: ["data: 1", "data: 2"], rest: "" });
  });
});

describe("parseAgentStreamFrame", () => {
  it("events: validati uno per uno, i malformati scartati, ma il cursore avanza all'ultimo id", () => {
    const frame = `data: ${JSON.stringify({ type: "events", events: [ev("5"), { id: "6", type: 42 }] })}`;
    const parsed = parseAgentStreamFrame(frame);
    expect(parsed.real).toBe(true);
    expect(parsed.lastId).toBe("6");
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({ type: "events", events: [{ id: "5" }] });
  });
  it("partial e session; un tipo di evento ignoto arriva aperto (readerSchema), non scartato", () => {
    const partial = parseAgentStreamFrame(`data: ${JSON.stringify({ type: "partial", segmentId: "s1", text: "ciao" })}`);
    expect(partial.messages).toEqual([{ type: "partial", segmentId: "s1", text: "ciao" }]);
    const unknownType = parseAgentStreamFrame(`data: ${JSON.stringify({ type: "events", events: [ev("7", "nuovo_tipo")] })}`);
    expect(unknownType.messages).toHaveLength(1);
  });
  it("ping, blocco vuoto, HTML di un proxy, JSON rotto: niente messaggi e NON è un frame vero (il backoff non si azzera)", () => {
    for (const raw of [": ping", "", "<html>502</html>", "data: {rotto", `data: ${JSON.stringify({ type: "boh" })}`]) {
      const parsed = parseAgentStreamFrame(raw);
      expect(parsed.messages).toEqual([]);
      expect(parsed.real).toBe(false);
      expect(parsed.lastId).toBeNull();
    }
  });
  it("un dettaglio session che non si parsa: segnalato, non consegnato", () => {
    const parsed = parseAgentStreamFrame(`data: ${JSON.stringify({ type: "session", detail: { id: "x" } })}`);
    expect(parsed.messages).toEqual([]);
    expect(parsed.invalidSession).toBe(true);
  });
});

describe("percorso dello stream e allowlist", () => {
  it("il percorso con e senza cursore", () => {
    expect(agentStreamPath(S)).toBe(`/api/agent-sessions/${S}/stream`);
    expect(agentStreamPath(S, "42")).toBe(`/api/agent-sessions/${S}/stream?after=42`);
  });
  it("allowlist stretta: solo lo stream di una sessione, con `after` numerico al più", () => {
    expect(isAllowedAgentStreamPath(agentStreamPath(S))).toBe(true);
    expect(isAllowedAgentStreamPath(agentStreamPath(S, "42"))).toBe(true);
    for (const bad of [
      `/api/agent-sessions/${S}/events`,
      `/api/agent-sessions/${S}/stream?after=1&x=2`,
      `/api/agent-sessions/${S}/stream?after=abc`,
      `/api/agent-sessions/../auth/me/stream`,
      `/api/agent-sessions/${S}/stream/../../tickets`,
      `https://evil.example/api/agent-sessions/${S}/stream`,
      `//evil.example/api/agent-sessions/${S}/stream`,
      `/api/agent-sessions/not-a-uuid/stream`,
    ]) {
      expect(isAllowedAgentStreamPath(bad), bad).toBe(false);
    }
  });
});

describe("streamBackoffMs", () => {
  it("raddoppia da 1 s fino a 15 s", () => {
    expect([0, 1, 2, 3, 4, 10].map(streamBackoffMs)).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000]);
  });
  it("il tetto di rotazione è 1 MB", () => {
    expect(AGENT_STREAM_MAX_BYTES).toBe(1024 * 1024);
  });
});
