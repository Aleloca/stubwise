import { describe, expect, it } from "vitest";
import { conversationTitleFrom } from "./claude-conversation.js";

describe("conversationTitleFrom", () => {
  it("la prima riga non vuota, senza spazi in eccesso", () => {
    expect(conversationTitleFrom("\n  Come va   AUD?  \nE il resto")).toBe("Come va AUD?");
  });
  it("troncata con l'ellissi", () => {
    expect(conversationTitleFrom("a".repeat(100), 10)).toBe(`${"a".repeat(9)}…`);
  });
});
