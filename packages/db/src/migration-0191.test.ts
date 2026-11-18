import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projects, users, workerHeartbeats } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0191 (18 nov 2026, area 9, F4): la pausa della coda di un
 * progetto e l'heartbeat dei worker. Solo la coda di Stubwise: niente che
 * tocchi un server.
 */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0191", () => {
  it("la pausa nasce nulla; chi l'ha messa va a null se la persona si elimina", async () => {
    const { projectId } = await seedRepository(t.db);
    const [p] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(p).toMatchObject({ queuePausedAt: null, queuePausedByUserId: null });
    const [u] = await t.db.insert(users).values({ email: `${randomUUID()}@acme.com`, passwordHash: "h", role: "member" }).returning({ id: users.id });
    await t.db.update(projects).set({ queuePausedAt: new Date(), queuePausedByUserId: u!.id }).where(eq(projects.id, projectId));
    await t.db.delete(users).where(eq(users.id, u!.id));
    const [after] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(after!.queuePausedAt).not.toBeNull();
    expect(after!.queuePausedByUserId).toBeNull();
  });

  it("l'heartbeat: un worker per riga, coi lavori in mano", async () => {
    await t.db.insert(workerHeartbeats).values({ workerId: "w-1", concurrency: 5, running: [{ kind: "ai_job", id: randomUUID() }] });
    const [row] = await t.db.select().from(workerHeartbeats).where(eq(workerHeartbeats.workerId, "w-1"));
    expect(row).toMatchObject({ concurrency: 5 });
    expect(row!.seenAt).toBeInstanceOf(Date);
    expect(row!.startedAt).toBeInstanceOf(Date);
    await expect(t.db.insert(workerHeartbeats).values({ workerId: "w-1", concurrency: 1 })).rejects.toThrow();
  });
});
