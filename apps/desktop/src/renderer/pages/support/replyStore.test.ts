import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import {
  REPLY_UNDO_MS,
  clearReplyStore,
  readDraft,
  scheduleReply,
  takeBackReply,
} from "./replyStore";

// La casella di Support fuori dalla UI: l'invio in attesa e il suo «Annulla».

beforeEach(() => {
  resetApi();
  setLatency(200);
  clearReplyStore();
  setSessionPersonId("p-matteo");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  clearReplyStore();
  resetApi();
});

const conv = () => state.supportConversations.find((c) => c.code === "ACQ-S2")!;

describe("replyStore", () => {
  it("n2: «Annulla» quando l'invio è già partito non rimette il testo nella casella", async () => {
    expect(scheduleReply("ACQ-S2", "On its way.", () => undefined)).toBe(true);
    await vi.advanceTimersByTimeAsync(REPLY_UNDO_MS + 10); // partito, la risposta è in volo
    expect(takeBackReply("p-matteo", "ACQ-S2")).toBe(false);
    expect(readDraft("p-matteo", "ACQ-S2")).toBe("");
    await vi.advanceTimersByTimeAsync(500);
    expect(conv().messages.at(-1)!.body).toBe("On its way.");
  });
});
