import { describe, expect, it } from "vitest";
import { readerSchema } from "./reader.js";
import { inboxGoogleSchema } from "./schemas/notification.js";

/**
 * «Una proposta decisa mostra la decisione» (27 set 2026, design §3):
 * `decision` è derivato a lettura dal server e l'app lo legge. Nasce
 * `.nullable().default(null)` come ogni campo nuovo che l'app legge.
 */
describe("InboxGoogle.decision", () => {
  const google = {
    source: "email",
    from: "cliente@example.com",
    subject: "Tre cose",
    signal: "request",
    actions: [{ type: "create_backlog_item" }, { type: "ignore" }],
  };

  it("una risposta SENZA il campo (server più vecchio) parsa, e vale null", () => {
    expect(readerSchema(inboxGoogleSchema).parse(google).decision).toBeNull();
  });

  it("col campo, lo porta com'è", () => {
    const decision = { status: "actioned", chosen: ["Voce: export"], error: null };
    expect(inboxGoogleSchema.parse({ ...google, decision }).decision).toEqual(decision);
  });

  it("uno stato che l'app non conosce non fa fallire il parse del lettore", () => {
    const parsed = readerSchema(inboxGoogleSchema).parse({
      ...google,
      decision: { status: "someday", chosen: [], error: null },
    });
    expect(parsed.decision?.status).toBe("__unknown__");
  });
});
