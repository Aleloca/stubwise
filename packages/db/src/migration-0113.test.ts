import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taskDayArrangements, tickets, users } from "./schema.js";
import { expectSqlState, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0113 (9 nov 2026, integrazione area 2, fetta 2): la settimana
 * pianificata (il lunedì), lo slittamento DERIVATO a lettura con il
 * consolidamento in scrittura, e le sistemazioni per giorno che si azzerano
 * quando cambiano davvero settimana o assegnatario.
 *
 * «Oggi» si fissa con `set local stubwise.today = …` dentro una transazione:
 * `stubwise_current_monday()` lo legge prima dell'orologio.
 */

let t: TestDb;

beforeAll(async () => {
  t = await startTestDb();
}, 120_000);

afterAll(async () => {
  await t?.stop();
});

/** Una query con «oggi» fissato a `today` (data ISO). */
async function at<T>(today: string, query: ReturnType<typeof sql>): Promise<T[]> {
  return t.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('stubwise.today', ${today}, true)`);
    return (await tx.execute(query)) as unknown as T[];
  });
}

async function user(): Promise<string> {
  const [u] = await t.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, passwordHash: "h", role: "member" })
    .returning({ id: users.id });
  return u!.id;
}

describe("migrazione 0113: settimana pianificata e slittamento", () => {
  it("planned_week è un lunedì", async () => {
    const { ticketId } = await seedTicket(t.db);
    await expectSqlState(
      t.db.update(tickets).set({ plannedWeek: "2026-11-10" }).where(eq(tickets.id, ticketId)),
      "23514",
    );
    await t.db.update(tickets).set({ plannedWeek: "2026-11-09" }).where(eq(tickets.id, ticketId));
  });

  it("la settimana corrente è il lunedì di oggi, e slittamento derivato su una task aperta", async () => {
    const [row] = await at<Record<string, unknown>>(
      "2026-11-12",
      sql`select stubwise_current_monday()::text as m,
        stubwise_effective_week('2026-10-26'::date, null)::text as eff,
        stubwise_slip_weeks('2026-10-26'::date, null) as slip,
        stubwise_effective_week('2026-10-26'::date, '2026-10-28T10:00:00Z'::timestamptz)::text as closed_in_week,
        stubwise_slip_weeks('2026-10-26'::date, '2026-10-28T10:00:00Z'::timestamptz) as closed_in_week_slip,
        stubwise_effective_week('2026-10-26'::date, '2026-11-03T10:00:00Z'::timestamptz)::text as closed_later,
        stubwise_slip_weeks('2026-10-26'::date, '2026-11-03T10:00:00Z'::timestamptz) as closed_later_slip`,
    );
    expect(row).toEqual({
      m: "2026-11-09",
      eff: "2026-11-09",
      slip: 2,
      // Chiusa nella sua settimana: mai slittata.
      closed_in_week: "2026-10-26",
      closed_in_week_slip: 0,
      // Chiusa una settimana dopo: il conteggio si ferma alla chiusura, MAI nella settimana corrente.
      closed_later: "2026-11-02",
      closed_later_slip: 1,
    });
  });

  it("W53 → W01: la W52 del 2026 vista dal 5 gennaio 2027 è slittata di 2", async () => {
    const [row] = await at<{ m: string; slip: number }>(
      "2027-01-05",
      sql`select stubwise_current_monday()::text as m, stubwise_slip_weeks('2026-12-21'::date, null) as slip`,
    );
    expect(row).toEqual({ m: "2027-01-04", slip: 2 });
  });

  it("ripianificare una slittata tiene il conteggio e non lo raddoppia", async () => {
    const { ticketId } = await seedTicket(t.db);
    await t.db.update(tickets).set({ plannedWeek: "2026-10-26" }).where(eq(tickets.id, ticketId));
    // Oggi è la settimana del 9 novembre: due settimane di slittamento, consolidate alla ripianificazione.
    const read = () =>
      sql`select slip_count + stubwise_slip_weeks(planned_week, closed_at) as slips, planned_week::text as week
          from tickets where id = ${ticketId}`;
    expect(await at("2026-11-10", read())).toEqual([{ slips: 2, week: "2026-10-26" }]);
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('stubwise.today', '2026-11-10', true)`);
      await tx.execute(sql`update tickets set planned_week = '2026-11-16' where id = ${ticketId}`);
    });
    expect(await at("2026-11-10", read())).toEqual([{ slips: 2, week: "2026-11-16" }]);
    // Riscrivere la stessa settimana non conta di nuovo.
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('stubwise.today', '2026-11-10', true)`);
      await tx.execute(sql`update tickets set planned_week = '2026-11-16' where id = ${ticketId}`);
    });
    expect(await at("2026-11-10", read())).toEqual([{ slips: 2, week: "2026-11-16" }]);
  });

  it("cambiare settimana o assegnatario cancella le sistemazioni; un altro campo no", async () => {
    const { ticketId } = await seedTicket(t.db);
    const a = await user();
    const b = await user();
    await t.db.update(tickets).set({ plannedWeek: "2026-11-09", assigneeId: a }).where(eq(tickets.id, ticketId));
    const arrange = () =>
      t.db.insert(taskDayArrangements).values({ ticketId, userId: a, week: "2026-11-09", day: 2 }).onConflictDoNothing();
    const count = async () =>
      (await t.db.select().from(taskDayArrangements).where(eq(taskDayArrangements.ticketId, ticketId))).length;
    await arrange();
    await t.db.update(tickets).set({ title: "Altro titolo" }).where(eq(tickets.id, ticketId));
    expect(await count()).toBe(1);
    await t.db.update(tickets).set({ plannedWeek: "2026-11-16" }).where(eq(tickets.id, ticketId));
    expect(await count()).toBe(0);
    await t.db.update(tickets).set({ plannedWeek: "2026-11-09" }).where(eq(tickets.id, ticketId));
    await arrange();
    await t.db.update(tickets).set({ assigneeId: b }).where(eq(tickets.id, ticketId));
    expect(await count()).toBe(0);
  });

  it("un giorno fuori da lunedì–venerdì è rifiutato", async () => {
    const { ticketId } = await seedTicket(t.db);
    const a = await user();
    await expectSqlState(
      t.db.insert(taskDayArrangements).values({ ticketId, userId: a, week: "2026-11-09", day: 6 }),
      "23514",
    );
  });
});
