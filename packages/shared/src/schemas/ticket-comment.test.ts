import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { commentReplyToSchema, ticketCommentSchema } from "./ticket.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AT = "2026-10-05T09:06:00.000Z";

/**
 * Modificare e cancellare i commenti (piano 2026-10-05, A2): i campi nuovi
 * sono ADDITIVI. Un commento della forma 0083 — server più vecchio, rollback,
 * istanza self-hosted non aggiornata — deve parsarsi coi default: nessun
 * permesso, mai eliminato né modificato, nessun legame col registro.
 */
describe("ticketCommentSchema: modifica e cancellazione", () => {
  it("un commento della forma 0083 (senza i campi nuovi) si parsa coi default", () => {
    // `safeParse`: senza un default il difetto è un parse che FALLISCE, e deve
    // leggersi come un'asserzione rossa, non un'eccezione.
    const result = readerSchema(ticketCommentSchema).safeParse({
      id: ID,
      ticketId: OTHER,
      authorType: "user",
      authorId: OTHER,
      body: "ciao",
      createdAt: AT,
      replyTo: { id: OTHER, authorType: "user", authorName: "a@b.c", excerpt: "prima" },
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      editedAt: null,
      deletedAt: null,
      deletedBy: null,
      canEdit: false,
      canDelete: false,
      inDecisionLog: false,
    });
    expect(result.data?.replyTo?.deleted).toBe(false);
  });

  it("un replyTo della forma 0083 si parsa con deleted: false", () => {
    const result = readerSchema(commentReplyToSchema).safeParse({
      id: OTHER,
      authorType: "ai",
      authorName: null,
      excerpt: "Fix pronto",
    });
    expect(result.success).toBe(true);
    expect(result.data?.deleted).toBe(false);
  });

  it("i campi valorizzati passano così come sono", () => {
    const parsed = readerSchema(ticketCommentSchema).parse({
      id: ID,
      ticketId: OTHER,
      authorType: "user",
      authorId: OTHER,
      body: "",
      createdAt: AT,
      editedAt: AT,
      deletedAt: AT,
      deletedBy: { name: null },
      canEdit: false,
      canDelete: false,
      inDecisionLog: true,
      replyTo: null,
    });
    expect(parsed).toMatchObject({
      editedAt: AT,
      deletedAt: AT,
      deletedBy: { name: null },
      inDecisionLog: true,
    });
  });
});
