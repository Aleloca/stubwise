import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { ticketEvents, users } from "./schema.js";
import { recordTicketStatusChange } from "./ticket-events.js";
import { seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Helper condiviso dell'AUDIT delle transizioni di stato di un ticket. Esiste
 * perché fino alla fase 5 solo `PATCH /api/tickets/:id` lasciava una traccia:
 * le transizioni fatte dal webhook git e dal worker cambiavano `tickets.status`
 * in silenzio, e la timeline di progetto non aveva un evento su cui appoggiarsi.
 */
describe("recordTicketStatusChange", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function eventsOf(ticketId: string) {
    return db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId));
  }

  it("registra la transizione con from/to e actor null (sistema)", async () => {
    const { ticketId } = await seedTicket(db);

    await recordTicketStatusChange(db, {
      ticketId,
      from: "in_review",
      to: "done",
      actorId: null,
    });

    const rows = await eventsOf(ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("status_changed");
    expect(rows[0]?.payload).toEqual({ from: "in_review", to: "done" });
    // actor_id NULL = il sistema (webhook o worker), non una persona.
    expect(rows[0]?.actorId).toBeNull();
  });

  it("registra l'attore quando la transizione è di una persona", async () => {
    const { ticketId } = await seedTicket(db);
    const [user] = await db
      .insert(users)
      .values({ email: `u-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
      .returning();

    await recordTicketStatusChange(db, {
      ticketId,
      from: "open",
      to: "triaged",
      actorId: user!.id,
    });

    const rows = await eventsOf(ticketId);
    expect(rows[0]?.actorId).toBe(user!.id);
  });

  it("from === to → no-op: nessun evento (non è una transizione)", async () => {
    const { ticketId } = await seedTicket(db);

    await recordTicketStatusChange(db, {
      ticketId,
      from: "done",
      to: "done",
      actorId: null,
    });

    expect(await eventsOf(ticketId)).toHaveLength(0);
  });

  it("funziona dentro una transazione, insieme all'UPDATE che descrive", async () => {
    const { ticketId } = await seedTicket(db);

    await db.transaction(async (tx) => {
      await recordTicketStatusChange(tx, {
        ticketId,
        from: "triaged",
        to: "in_progress",
        actorId: null,
      });
    });

    expect(await eventsOf(ticketId)).toHaveLength(1);
  });

  it("una transazione annullata non lascia l'evento (l'audit segue l'UPDATE)", async () => {
    const { ticketId } = await seedTicket(db);

    await expect(
      db.transaction(async (tx) => {
        await recordTicketStatusChange(tx, {
          ticketId,
          from: "triaged",
          to: "in_progress",
          actorId: null,
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow(/rollback/);

    expect(await eventsOf(ticketId)).toHaveLength(0);
  });
});
