import { describe, expect, it } from "vitest";
import {
  claudeConversationListQuerySchema,
  claudeConversationSchema,
  claudeVisibilityConfirmationSchema,
  setClaudeConversationVisibilitySchema,
} from "./claude-conversation.js";

// Fetta 5: i campi nuovi nascono con default (un server più vecchio non li manda).
const OLD = {
  id: "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01",
  title: "Export CSV",
  archived: false,
  context: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:00:00.000Z",
  state: "idle",
  lastEventAt: null,
};

describe("conversazioni pubbliche (fetta 5): schemi additivi", () => {
  it("una risposta di un server di prima si legge, privata e dell'autore", () => {
    const c = claudeConversationSchema.parse(OLD);
    expect(c).toMatchObject({
      visibility: "private",
      author: null,
      isOwner: true,
      publishedAt: null,
      publishedProjects: [],
      privateTail: false,
      heldProjects: [],
      continuesFrom: null,
      canPublish: false,
      canContinue: false,
    });
  });

  it("la lista accetta scope=public; la visibilità e la conferma hanno la loro forma", () => {
    expect(claudeConversationListQuerySchema.parse({ scope: "public" }).scope).toBe("public");
    expect(claudeConversationListQuerySchema.parse({}).scope).toBe("mine");
    expect(() => claudeConversationListQuerySchema.parse({ scope: "all" })).toThrow();
    expect(setClaudeConversationVisibilitySchema.parse({ visibility: "public" })).toEqual({ visibility: "public" });
    expect(
      claudeVisibilityConfirmationSchema.parse({ code: "needs_confirmation", projects: [] }),
    ).toEqual({ code: "needs_confirmation", message: "", projects: [], includesToolReads: false, reconfirm: false });
  });
});
