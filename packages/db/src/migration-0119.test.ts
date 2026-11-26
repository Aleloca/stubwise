import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taskDayArrangements, tickets, users } from "./schema.js";
import { seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0119 (fix della review della fetta 2): il trigger
 * `tickets_reset_day_arrangements` confronta la settimana EFFETTIVA (con lo
 * slittamento) di prima e di dopo, più l'assegnatario — non `planned_week`
 * grezza. Riscrivere la settimana corrente di una slittata non sposta la
 * task, e non deve cancellare il giorno in cui l'assegnatario se l'è messa.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const TODAY = "2026-11-11"; // settimana corrente: lunedì 9 novembre

async function user(): Promise<string> {
  const [u] = await t.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, passwordHash: "h", role: "member" })
    .returning({ id: users.id });
  return u!.id;
}

/** Un UPDATE con «oggi» fissato. */
const updateAt = (query: ReturnType<typeof sql>) =>
  t.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('stubwise.today', ${TODAY}, true)`);
    await tx.execute(query);
  });

describe("0119 sistemazioni per giorno e settimana effettiva", () => {
  it("riscrivere la settimana corrente di una slittata non cancella il giorno; spostarla davvero sì", async () => {
    const { ticketId } = await seedTicket(t.db);
    const a = await user();
    // Pianificata tre settimane fa e ancora aperta: oggi si legge nella corrente.
    await t.db.update(tickets).set({ plannedWeek: "2026-10-19", assigneeId: a }).where(eq(tickets.id, ticketId));
    await t.db.insert(taskDayArrangements).values({ ticketId, userId: a, week: "2026-11-09", day: 3 });
    const count = async () =>
      (await t.db.select().from(taskDayArrangements).where(eq(taskDayArrangements.ticketId, ticketId))).length;
    await updateAt(sql`update tickets set planned_week = '2026-11-09' where id = ${ticketId}`);
    expect(await count()).toBe(1);
    await updateAt(sql`update tickets set planned_week = '2026-11-16' where id = ${ticketId}`);
    expect(await count()).toBe(0);
  });

  it("l'assegnatario che cambia cancella sempre, anche a settimana effettiva uguale", async () => {
    const { ticketId } = await seedTicket(t.db);
    const a = await user();
    const b = await user();
    await t.db.update(tickets).set({ plannedWeek: "2026-11-16", assigneeId: a }).where(eq(tickets.id, ticketId));
    await t.db.insert(taskDayArrangements).values({ ticketId, userId: a, week: "2026-11-16", day: 1 });
    await updateAt(sql`update tickets set assignee_id = ${b} where id = ${ticketId}`);
    expect(await t.db.select().from(taskDayArrangements).where(eq(taskDayArrangements.ticketId, ticketId))).toHaveLength(0);
  });
});
