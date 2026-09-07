import { aiJobs, ticketEvents, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedTicket, startTestDb } from "@stubwise/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillTicketDoneEvents } from "./backfill-ticket-done-events.js";

/**
 * Backfill una tantum degli eventi di chiusura mancanti. Prima della fase 5 le
 * transizioni a `done` fatte dal webhook non lasciavano traccia: senza questo
 * backfill la timeline di progetto mostrerebbe come "chiusi" solo i ticket
 * chiusi a mano dalla web app, e la storia passata resterebbe vuota.
 */
let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

/** Ticket in stato `done`, con `updated_at` forzato alla data data. */
async function seedDoneTicket(opts: { updatedAt: Date; number?: number }): Promise<string> {
  const { ticketId } = await seedTicket(testDb.db, { number: opts.number ?? 1 });
  await testDb.db
    .update(tickets)
    .set({ status: "done", updatedAt: opts.updatedAt })
    .where(eq(tickets.id, ticketId));
  return ticketId;
}

async function doneEvents(ticketId: string) {
  return testDb.db
    .select()
    .from(ticketEvents)
    .where(and(eq(ticketEvents.ticketId, ticketId), eq(ticketEvents.kind, "status_changed")));
}

describe("backfillTicketDoneEvents", () => {
  it("ticket done senza evento → un evento datato dal job pr_merged", async () => {
    const mergedAt = new Date("2026-07-01T10:00:00.000Z");
    const ticketId = await seedDoneTicket({ updatedAt: new Date("2026-08-01T00:00:00.000Z") });
    await testDb.db
      .insert(aiJobs)
      .values({ ticketId, status: "pr_merged", finishedAt: mergedAt });

    const result = await backfillTicketDoneEvents(testDb.db, { dryRun: false });

    expect(result.inserted).toBe(1);
    const events = await doneEvents(ticketId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ from: "in_review", to: "done" });
    // Actor null: la chiusura la fece il merge, non una persona.
    expect(events[0]?.actorId).toBeNull();
    // La data è quella del MERGE, non quella dell'esecuzione del backfill:
    // un evento datato oggi metterebbe tutti i ticket storici nella stessa
    // settimana della timeline.
    expect(events[0]?.createdAt.toISOString()).toBe(mergedAt.toISOString());
  });

  it("senza job pr_merged ricade su tickets.updated_at", async () => {
    const updatedAt = new Date("2026-06-15T08:30:00.000Z");
    const ticketId = await seedDoneTicket({ updatedAt });

    await backfillTicketDoneEvents(testDb.db, { dryRun: false });

    const events = await doneEvents(ticketId);
    expect(events).toHaveLength(1);
    expect(events[0]?.createdAt.toISOString()).toBe(updatedAt.toISOString());
  });

  it("idempotente: un secondo giro non inserisce nulla", async () => {
    const ticketId = await seedDoneTicket({ updatedAt: new Date("2026-05-01T00:00:00.000Z") });
    await backfillTicketDoneEvents(testDb.db, { dryRun: false });

    const second = await backfillTicketDoneEvents(testDb.db, { dryRun: false });

    expect(second.inserted).toBe(0);
    expect(await doneEvents(ticketId)).toHaveLength(1);
  });

  it("ticket done che ha GIÀ un evento a done → saltato", async () => {
    const ticketId = await seedDoneTicket({ updatedAt: new Date("2026-04-01T00:00:00.000Z") });
    await testDb.db.insert(ticketEvents).values({
      ticketId,
      kind: "status_changed",
      payload: { from: "in_progress", to: "done" },
      actorId: null,
    });

    const result = await backfillTicketDoneEvents(testDb.db, { dryRun: false });

    expect(result.inserted).toBe(0);
    expect(await doneEvents(ticketId)).toHaveLength(1);
  });

  it("un evento status_changed verso un ALTRO stato non conta come già fatto", async () => {
    const ticketId = await seedDoneTicket({ updatedAt: new Date("2026-03-01T00:00:00.000Z") });
    // La transizione a `triaged` c'è (fatta a mano dalla web app), quella a
    // `done` no: il backfill deve comunque scrivere quella mancante.
    await testDb.db.insert(ticketEvents).values({
      ticketId,
      kind: "status_changed",
      payload: { from: "open", to: "triaged" },
      actorId: null,
    });

    const result = await backfillTicketDoneEvents(testDb.db, { dryRun: false });

    expect(result.inserted).toBe(1);
    expect(await doneEvents(ticketId)).toHaveLength(2);
  });

  it("i ticket non done non sono toccati", async () => {
    const { ticketId } = await seedTicket(testDb.db);

    await backfillTicketDoneEvents(testDb.db, { dryRun: false });

    expect(await doneEvents(ticketId)).toHaveLength(0);
  });

  it("--dry-run conta i candidati senza scrivere", async () => {
    const ticketId = await seedDoneTicket({ updatedAt: new Date("2026-02-01T00:00:00.000Z") });

    const dry = await backfillTicketDoneEvents(testDb.db, { dryRun: true });

    expect(dry.candidates).toBeGreaterThanOrEqual(1);
    expect(dry.inserted).toBe(0);
    expect(await doneEvents(ticketId)).toHaveLength(0);
  });
});
