import { describe, expect, it } from "vitest";
import { buildChatPrimingPrompt, CHAT_UNDO_LABEL } from "./prompts.js";

const prompt = (language: "en" | "it") =>
  buildChatPrimingPrompt({ language, authorName: "Ada", context: null, toolsAvailable: true, recentTranscript: [] }, "ciao");

describe("il contratto della chat", () => {
  it("chiama il bottone «Annulla» col nome della lingua di chi scrive", () => {
    expect(prompt("it")).toContain("«Annulla l'azione» button");
    expect(prompt("it")).not.toContain("«Undo»");
    expect(prompt("en")).toContain("«Undo» button");
    expect(CHAT_UNDO_LABEL).toEqual({ en: "Undo", it: "Annulla l'azione" });
  });
});
