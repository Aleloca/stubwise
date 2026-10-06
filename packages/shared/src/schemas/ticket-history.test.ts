import { describe, expect, it } from "vitest";
import { readerSchema, UNKNOWN } from "../reader.js";
import { ticketCommentSchema, ticketHistoryEventSchema, ticketHistorySchema } from "./ticket.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AT = "2026-10-02T09:06:00.000Z";

describe("ticketCommentSchema.replyTo", () => {
  it("un commento SENZA replyTo (server vecchio) si parsa, con replyTo null", () => {
    // `safeParse` e non `parse`: senza il default il difetto è un parse che
    // FALLISCE, e deve leggersi come un'asserzione rossa, non un'eccezione.
    const result = readerSchema(ticketCommentSchema).safeParse({
      id: ID,
      ticketId: OTHER,
      authorType: "user",
      authorId: null,
      body: "ciao",
      createdAt: AT,
    });
    expect(result.success).toBe(true);
    expect(result.data?.replyTo).toBeNull();
  });

  it("un replyTo con authorType ignoto diventa UNKNOWN, non un errore", () => {
    const parsed = readerSchema(ticketCommentSchema).parse({
      id: ID,
      ticketId: OTHER,
      authorType: "user",
      authorId: null,
      body: "ciao",
      createdAt: AT,
      replyTo: { id: OTHER, authorType: "bot", authorName: null, excerpt: "Fix pronto" },
    });
    expect(parsed.replyTo).toEqual({
      id: OTHER,
      authorType: UNKNOWN,
      authorName: null,
      excerpt: "Fix pronto",
      // 0084: il default di un replyTo che non lo dice.
      deleted: false,
    });
  });
});

describe("ticketHistoryEventSchema", () => {
  it("un evento con SOLO id/kind/at si parsa con tutti i default", () => {
    const parsed = readerSchema(ticketHistoryEventSchema).parse({
      id: "run_started:x",
      kind: "run_started",
      at: AT,
    });
    expect(parsed).toEqual({
      id: "run_started:x",
      kind: "run_started",
      at: AT,
      actor: null,
      prNumber: null,
      prUrl: null,
      round: null,
      detail: null,
      fromStatus: null,
    });
  });

  it("un kind ignoto passa così com'è (stringa aperta)", () => {
    const parsed = readerSchema(ticketHistoryEventSchema).parse({
      id: "x:1",
      kind: "something_new",
      at: AT,
    });
    expect(parsed.kind).toBe("something_new");
  });

  it("un actor.type sconosciuto diventa UNKNOWN, il nome resta", () => {
    const parsed = readerSchema(ticketHistoryEventSchema).parse({
      id: "x:1",
      kind: "changes_requested",
      at: AT,
      actor: { type: "robot", name: "r2d2" },
    });
    expect(parsed.actor).toEqual({ type: UNKNOWN, name: "r2d2" });
  });
});

describe("ticketHistorySchema", () => {
  it("una risposta senza total (server più vecchio della D4) dà total 0", () => {
    const result = readerSchema(ticketHistorySchema).safeParse({ events: [] });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ events: [], total: 0 });
  });
});
