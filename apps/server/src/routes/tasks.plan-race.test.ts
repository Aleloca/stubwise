import { randomBytes } from "node:crypto";
import { tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession } from "../test/fixtures.js";

/**
 * Fix della review della fetta 2 (TOCTOU): la decisione di `planTask` usa la
 * riga BLOCCATA (`for update` nella transazione della scrittura), non una
 * letta prima. Qui una corsa vera: un'altra transazione ha la riga bloccata
 * e la dà a un'altra persona mentre l'assegnatario di prima la sposta. Letta
 * fuori dalla transazione, la regola vedrebbe ancora la task come sua e la
 * scrittura (in attesa del lock) la riprenderebbe; letta bloccata, aspetta e
 * vede che non è più sua → 403.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;
let dev: { id: string; headers: { cookie: string } };
let other: { id: string; headers: { cookie: string } };

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  ({ projectId } = await seedRepository(testDb.db));
  dev = await createUserWithSession(app, "dev@example.com");
  other = await createUserWithSession(app, "altro@example.com");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, other.id, "developer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("planTask sulla riga bloccata (fix fetta 2)", () => {
  it("riassegnata da un'altra transazione mentre la sposto: aspetto il lock, vedo che non è più mia → 403, resta all'altra", async () => {
    const [row] = await testDb.db
      .insert(tickets)
      .values({
        projectId,
        number: 1,
        title: "Contesa",
        type: "bug",
        priority: "medium",
        source: "manual",
        assigneeId: dev.id,
        plannedWeek: "2030-01-07",
      })
      .returning({ id: tickets.id });
    const id = row!.id;
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
    const planning = app.inject({
      method: "POST",
      url: `/api/tasks/${id}/plan`,
      headers: { cookie: dev.headers.cookie },
      payload: { assigneeId: dev.id, week: "2030-W03" },
    });
    // La pianificazione è partita ed è in attesa del lock: ora la riassegnazione si conferma.
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    const res = await planning;
    expect(res.statusCode, res.body).toBe(403);
    const [after] = await testDb.db
      .select({ a: tickets.assigneeId, w: tickets.plannedWeek })
      .from(tickets)
      .where(eq(tickets.id, id));
    expect(after).toEqual({ a: other.id, w: "2030-01-07" });
  });
});
