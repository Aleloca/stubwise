import { randomBytes } from "node:crypto";
import { taskDayArrangements, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { dayArrangementSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession } from "../test/fixtures.js";

/**
 * Le sistemazioni per giorno della settimana (integrazione area 2, fetta 2):
 * personali, dell'assegnatario, e valgono solo finché la task resta sua e
 * in quella settimana (la settimana EFFETTIVA: una slittata non è più lì).
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;
let dev: { id: string; headers: { cookie: string } };
let other: { id: string; headers: { cookie: string } };
let outsider: { id: string; headers: { cookie: string } };
let n = 0;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  ({ projectId } = await seedRepository(testDb.db));
  dev = await createUserWithSession(app, "dev@example.com");
  other = await createUserWithSession(app, "altro@example.com");
  outsider = await createUserWithSession(app, "fuori@example.com");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, other.id, "developer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function task(assigneeId: string | null, plannedWeek: string | null): Promise<string> {
  n += 1;
  const [row] = await testDb.db
    .insert(tickets)
    .values({
      projectId,
      number: n,
      title: `T${n}`,
      type: "bug",
      priority: "medium",
      source: "manual",
      assigneeId,
      plannedWeek,
    })
    .returning({ id: tickets.id });
  return row!.id;
}

const setDay = (ticketId: string, body: unknown, cookie: string) =>
  app.inject({ method: "PUT", url: `/api/tasks/${ticketId}/day`, headers: { cookie }, payload: body as object });

const listOf = async (week: string, cookie: string) => {
  const res = await app.inject({ method: "GET", url: `/api/me/day-arrangements?week=${week}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return z.array(dayArrangementSchema).parse(res.json());
};

describe("PUT /api/tasks/:ticketId/day e GET /api/me/day-arrangements", () => {
  it("l'assegnatario si mette la task in un giorno, poi senza giorno, e la rilegge", async () => {
    const id = await task(dev.id, "2030-01-07");
    const res = await setDay(id, { week: "2030-W02", day: 3 }, dev.headers.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(dayArrangementSchema.parse(res.json())).toEqual({ taskId: id, week: "2030-W02", day: 3 });
    expect(await listOf("2030-W02", dev.headers.cookie)).toContainEqual({ taskId: id, week: "2030-W02", day: 3 });
    expect((await setDay(id, { week: "2030-W02", day: null }, dev.headers.cookie)).statusCode).toBe(200);
    expect((await listOf("2030-W02", dev.headers.cookie)).filter((a) => a.taskId === id)).toEqual([
      { taskId: id, week: "2030-W02", day: null },
    ]);
  });

  it("la sistemazione di un altro non si legge né si scrive", async () => {
    const id = await task(dev.id, "2030-01-14");
    expect((await setDay(id, { week: "2030-W03", day: 1 }, dev.headers.cookie)).statusCode).toBe(200);
    // Un altro membro non la scrive (non è sua)…
    expect((await setDay(id, { week: "2030-W03", day: 2 }, other.headers.cookie)).statusCode).toBe(403);
    // …né la legge: l'elenco è solo di chi guarda.
    expect((await listOf("2030-W03", other.headers.cookie)).some((a) => a.taskId === id)).toBe(false);
    // Una riga rimasta a nome suo su una task che non è sua non compare.
    await testDb.db.insert(taskDayArrangements).values({ ticketId: id, userId: other.id, week: "2030-01-14", day: 4 });
    expect((await listOf("2030-W03", other.headers.cookie)).some((a) => a.taskId === id)).toBe(false);
    expect((await listOf("2030-W03", dev.headers.cookie)).filter((a) => a.taskId === id)).toEqual([
      { taskId: id, week: "2030-W03", day: 1 },
    ]);
  });

  it("una sistemazione di una settimana diversa da quella della task non compare", async () => {
    const id = await task(dev.id, "2030-01-21");
    await testDb.db.insert(taskDayArrangements).values({ ticketId: id, userId: dev.id, week: "2030-01-14", day: 2 });
    expect((await listOf("2030-W03", dev.headers.cookie)).some((a) => a.taskId === id)).toBe(false);
    // Anche una slittata: pianificata in una settimana passata, oggi è nella corrente.
    const slipped = await task(dev.id, "2026-01-05");
    await testDb.db
      .insert(taskDayArrangements)
      .values({ ticketId: slipped, userId: dev.id, week: "2026-01-05", day: 1 });
    expect((await listOf("2026-W02", dev.headers.cookie)).some((a) => a.taskId === slipped)).toBe(false);
  });

  it("una settimana che non è quella della task → 409, e niente scritto", async () => {
    const id = await task(dev.id, "2030-01-28");
    expect((await setDay(id, { week: "2030-W06", day: 1 }, dev.headers.cookie)).statusCode).toBe(409);
    expect((await listOf("2030-W06", dev.headers.cookie)).some((a) => a.taskId === id)).toBe(false);
    // Senza settimana pianificata non c'è giorno da scegliere.
    const unplanned = await task(dev.id, null);
    expect((await setDay(unplanned, { week: "2030-W06", day: 1 }, dev.headers.cookie)).statusCode).toBe(409);
  });

  it("atomico: riassegnata da un'altra transazione mentre la sistemo → 403 e nessuna riga (fix fetta 2)", async () => {
    const id = await task(dev.id, "2030-02-11");
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const holder = testDb.db.transaction(async (tx) => {
      await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, id)).for("update");
      await tx.update(tickets).set({ assigneeId: other.id }).where(eq(tickets.id, id));
      locked();
      await released;
    });
    await isLocked;
    const putting = setDay(id, { week: "2030-W07", day: 2 }, dev.headers.cookie);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    const res = await putting;
    expect(res.statusCode, res.body).toBe(403);
    expect(await testDb.db.select().from(taskDayArrangements).where(eq(taskDayArrangements.ticketId, id))).toHaveLength(0);
  });

  it("validazione e visibilità: giorno fuori lunedì–venerdì, settimana inesistente, task invisibile", async () => {
    const id = await task(dev.id, "2030-02-04");
    expect((await setDay(id, { week: "2030-W06", day: 6 }, dev.headers.cookie)).statusCode).toBe(400);
    expect((await setDay(id, { week: "2027-W53", day: 1 }, dev.headers.cookie)).statusCode).toBe(400);
    expect((await setDay(id, { week: "2030-W06", day: 1 }, outsider.headers.cookie)).statusCode).toBe(404);
    const bad = await app.inject({
      method: "GET",
      url: "/api/me/day-arrangements?week=2030-06",
      headers: { cookie: dev.headers.cookie },
    });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/me/day-arrangements?week=2030-W06" })).statusCode).toBe(401);
  });
});
