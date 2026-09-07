import { describe, expect, it } from "vitest";
import { ticketActivityEntrySchema } from "./ticket.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("ticketActivityEntrySchema", () => {
  it("legge un evento di cambio stato con `from`/`to`, ignorando il resto della riga", () => {
    const parsed = ticketActivityEntrySchema.parse({
      kind: "event",
      id: ID,
      eventKind: "status_changed",
      actorId: null,
      payload: { from: "triaged", to: "in_progress", extra: "ignorato" },
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    expect(parsed.kind).toBe("event");
    expect(parsed.eventKind).toBe("status_changed");
    expect(parsed.payload?.to).toBe("in_progress");
    expect(parsed.createdAt).toBe("2026-09-01T10:00:00.000Z");
  });

  it("legge una voce di job (prUrl, finishedAt) e una di commento, senza i campi dell'altra", () => {
    const job = ticketActivityEntrySchema.parse({
      kind: "ai_job",
      id: ID,
      status: "pr_merged",
      prUrl: "https://example.com/pr/1",
      createdAt: "2026-09-01T10:00:00.000Z",
      finishedAt: "2026-09-01T12:00:00.000Z",
    });
    expect(job.prUrl).toBe("https://example.com/pr/1");
    expect(job.finishedAt).toBe("2026-09-01T12:00:00.000Z");

    const comment = ticketActivityEntrySchema.parse({
      kind: "comment",
      id: ID,
      authorType: "system",
      authorId: null,
      body: "Piano approvato.",
      createdAt: "2026-09-01T09:00:00.000Z",
    });
    expect(comment.kind).toBe("comment");
    expect(comment.eventKind).toBeUndefined();
    expect(comment.payload).toBeUndefined();
  });

  /**
   * Il motivo per cui `kind` è una `z.string()` e non un enum: la rotta è una
   * `discriminatedUnion` lato server, e un quarto tipo di voce aggiunto domani
   * NON deve far fallire il parse dell'intero feed su un'app già installata.
   */
  it("una voce di un tipo che questa build non conosce non fa fallire il parse", () => {
    const parsed = ticketActivityEntrySchema.parse({
      kind: "deploy",
      id: ID,
      createdAt: "2026-09-01T10:00:00.000Z",
      environment: "prod",
    });
    expect(parsed.kind).toBe("deploy");
  });

  it("un payload nullo resta nullo (eventi senza payload)", () => {
    const parsed = ticketActivityEntrySchema.parse({
      kind: "event",
      id: ID,
      eventKind: "body_changed",
      actorId: null,
      payload: null,
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    expect(parsed.payload).toBeNull();
  });
});
