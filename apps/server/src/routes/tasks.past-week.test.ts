import { randomBytes } from "node:crypto";
import { projectStatuses, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { addWeeks, currentIsoWeek, isoWeekToMonday } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession } from "../test/fixtures.js";

/**
 * Fix della review della fetta 2: una settimana PASSATA non si scrive (né
 * creando, né con PATCH, bulk o pianificazione) — gonfierebbe `slipCount`,
 * che è un dato mostrato. Eccezione: riscrivere la settimana EFFETTIVA
 * attuale della task (un no-op per chi la guarda), come quella di chiusura
 * di una task chiusa.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;
let lead: { id: string; headers: { cookie: string } };
let n = 0;

const thisWeek = () => currentIsoWeek(new Date());

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  ({ projectId } = await seedRepository(testDb.db));
  lead = await createUserWithSession(app, "lead@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function task(week: string | null, opts: { closedWeeksAgo?: number } = {}): Promise<string> {
  n += 1;
  const [row] = await testDb.db
    .insert(tickets)
    .values({
      projectId,
      number: 1000 + n,
      title: `T${n}`,
      type: "bug",
      priority: "medium",
      source: "manual",
      assigneeId: lead.id,
      plannedWeek: week ? isoWeekToMonday(week) : null,
    })
    .returning({ id: tickets.id });
  if (opts.closedWeeksAgo !== undefined) {
    const [done] = await testDb.db
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Done")));
    await testDb.db.update(tickets).set({ statusId: done!.id }).where(eq(tickets.id, row!.id));
    const closedAt = new Date(`${isoWeekToMonday(addWeeks(thisWeek(), -opts.closedWeeksAgo))}T12:00:00Z`);
    await testDb.db.update(tickets).set({ closedAt }).where(eq(tickets.id, row!.id));
  }
  return row!.id;
}

const inject = (method: "POST" | "PATCH", url: string, payload: object) =>
  app.inject({ method, url, headers: { cookie: lead.headers.cookie }, payload });

const slipOf = async (id: string) =>
  (await testDb.db.select({ slip: tickets.slipCount, week: tickets.plannedWeek }).from(tickets).where(eq(tickets.id, id)))[0]!;

describe("settimane passate (fix fetta 2)", () => {
  it("una task nuova pianificata 5 settimane fa → 400 past_week, e niente creato", async () => {
    const res = await inject("POST", "/api/tasks", {
      projectId,
      title: "Nel passato",
      type: "bug",
      plannedWeek: addWeeks(thisWeek(), -5),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "past_week" });
    const rows = await testDb.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.title, "Nel passato"));
    expect(rows).toHaveLength(0);
    // La settimana corrente e le prossime sì.
    expect((await inject("POST", "/api/tasks", { projectId, title: "Ora", type: "bug", plannedWeek: thisWeek() })).statusCode).toBe(
      201,
    );
  });

  it("ripianificare in una settimana passata → 400 (plan, PATCH, bulk) e slip_count invariato", async () => {
    const id = await task(addWeeks(thisWeek(), -3));
    const before = await slipOf(id);
    const past = addWeeks(thisWeek(), -2);
    const planned = await inject("POST", `/api/tasks/${id}/plan`, { assigneeId: lead.id, week: past });
    expect(planned.statusCode).toBe(400);
    expect(planned.json()).toMatchObject({ code: "past_week" });
    const patched = await inject("PATCH", `/api/tasks/${id}`, { plannedWeek: past });
    expect(patched.statusCode).toBe(400);
    expect(patched.json()).toMatchObject({ code: "past_week" });
    const bulk = await inject("PATCH", "/api/tasks/bulk", { ids: [id], patch: { plannedWeek: past } });
    expect(bulk.statusCode).toBe(400);
    expect(await slipOf(id)).toEqual(before);
  });

  it("riscrivere la settimana EFFETTIVA attuale resta ammesso: la corrente di una slittata, quella di chiusura di una chiusa", async () => {
    const slipped = await task(addWeeks(thisWeek(), -3));
    expect((await inject("PATCH", `/api/tasks/${slipped}`, { plannedWeek: thisWeek() })).statusCode).toBe(200);
    // Chiusa tre settimane fa, pianificata sei settimane fa: la sua settimana effettiva è quella di chiusura.
    const closed = await task(addWeeks(thisWeek(), -6), { closedWeeksAgo: 3 });
    const before = await slipOf(closed);
    expect((await inject("PATCH", `/api/tasks/${closed}`, { plannedWeek: addWeeks(thisWeek(), -3) })).statusCode).toBe(200);
    // Ma non un'altra settimana passata.
    expect((await inject("PATCH", `/api/tasks/${closed}`, { plannedWeek: addWeeks(thisWeek(), -4) })).statusCode).toBe(400);
    expect((await slipOf(closed)).slip).toBeGreaterThanOrEqual(before.slip);
  });
});
