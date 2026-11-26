import { describe, expect, it } from "vitest";
import { mailClaudeDraftEventSchema, mailClaudeDraftRequestSchema } from "./mail-compose.js";

describe("la bozza di Claude (area 6, F3): corpo della richiesta ed eventi dello stream", () => {
  it("la richiesta: hint e projectId hanno i default; un'email nuova ha threadId null", () => {
    expect(mailClaudeDraftRequestSchema.parse({ accountId: "11111111-1111-4111-8111-111111111111", threadId: null, mode: "new" })).toEqual({
      accountId: "11111111-1111-4111-8111-111111111111",
      threadId: null,
      mode: "new",
      hint: "",
      projectId: null,
    });
  });

  it("gli eventi: delta, done (con used), error; un tipo sconosciuto non passa", () => {
    expect(mailClaudeDraftEventSchema.parse({ type: "delta", text: "Ciao" })).toEqual({ type: "delta", text: "Ciao" });
    expect(mailClaudeDraftEventSchema.parse({ type: "done", text: "Ciao", projectId: null })).toEqual({ type: "done", text: "Ciao", projectId: null, used: [] });
    expect(mailClaudeDraftEventSchema.parse({ type: "error", code: "claude_unavailable" })).toMatchObject({ type: "error" });
    expect(mailClaudeDraftEventSchema.safeParse({ type: "boh" }).success).toBe(false);
  });
});
