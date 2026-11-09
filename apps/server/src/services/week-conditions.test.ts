import { randomUUID } from "node:crypto";
import { tickets, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectiveWeekIs, effectiveWeekOverlaps } from "./task-view.js";

/**
 * Fix della review della fetta 2: i filtri sulla settimana EFFETTIVA in forma
 * SARGABLE, così l'indice `tickets_assignee_planned_week_idx`
 * (`assignee_id, planned_week` sulle aperte) serve davvero: per le aperte la
 * condizione sta su `planned_week` nuda (e `closed_at IS NULL`), solo le
 * chiuse passano dalla funzione. Il risultato è quello della funzione: lo
 * controlla il confronto su una griglia di casi.
 */

let testDb: TestDb;
let projectId: string;
let assignee: string;
const TODAY = "2026-11-11"; // settimana corrente: lunedì 9 novembre

beforeAll(async () => {
  testDb = await startTestDb();
  ({ projectId } = await seedRepository(testDb.db));
  const [u] = await testDb.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, passwordHash: "h", role: "member" })
    .returning({ id: users.id });
  assignee = u!.id;
  const weeks = ["2026-10-19", "2026-11-02", "2026-11-09", "2026-11-16", "2026-11-30", null];
  const closings = [null, "2026-10-28T10:00:00Z", "2026-11-10T10:00:00Z"];
  let n = 0;
  for (const week of weeks) {
    for (const closedAt of closings) {
      n += 1;
      const [row] = await testDb.db
        .insert(tickets)
        .values({
          projectId,
          number: n,
          title: `W${n}`,
          type: "bug",
          priority: "medium",
          source: "manual",
          assigneeId: assignee,
          plannedWeek: week,
        })
        .returning({ id: tickets.id });
      if (closedAt) await testDb.db.update(tickets).set({ closedAt: new Date(closedAt) }).where(eq(tickets.id, row!.id));
    }
  }
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

async function idsAt(condition: SQL): Promise<string[]> {
  return testDb.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('stubwise.today', ${TODAY}, true)`);
    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), condition));
    return rows.map((r) => r.id).sort();
  });
}

const fn = sql`stubwise_effective_week(${tickets.plannedWeek}, ${tickets.closedAt})`;

describe("settimana effettiva in forma sargable", () => {
  it("dà le stesse task della funzione, per uguaglianza e per sovrapposizione", async () => {
    for (const monday of ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16", "2026-11-30"]) {
      expect(await idsAt(effectiveWeekIs(monday)), monday).toEqual(await idsAt(sql`${fn} = ${monday}::date`));
    }
    for (const [from, to] of [
      ["2026-11-01", "2026-11-30"],
      ["2026-10-01", "2026-10-31"],
      ["2026-11-10", "2026-11-12"],
      ["2026-11-17", "2026-11-29"],
    ] as const) {
      expect(await idsAt(effectiveWeekOverlaps(from, to)), `${from}…${to}`).toEqual(
        await idsAt(sql`${fn} <= ${to}::date and ${fn} + 6 >= ${from}::date`),
      );
    }
  });

  it("con l'assegnatario, l'indice delle aperte usa planned_week nella condizione dell'indice", async () => {
    const plan = await testDb.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const rows = (await tx.execute(
        sql`explain select id from ${tickets} where ${and(eq(tickets.assigneeId, assignee), effectiveWeekIs("2026-11-16"))}`,
      )) as unknown as { "QUERY PLAN": string }[];
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("tickets_assignee_planned_week_idx");
    expect(plan).toMatch(/Index Cond: .*planned_week/);
  });
});
