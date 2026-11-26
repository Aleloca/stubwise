import { workerHeartbeats, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { beat, WORKER_HEARTBEAT_RETENTION_MS } from "./heartbeat.js";

/** Area 9, F4, Task 3: l'heartbeat del worker. */
let t: TestDb;
let db: Db;
beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
}, 120_000);
afterAll(async () => {
  await t.stop();
});

describe("l'heartbeat del worker", () => {
  it("scrive la riga del processo coi lavori in mano; il battito dopo aggiorna seen_at e lascia started_at", async () => {
    const t0 = new Date("2026-11-18T10:00:00.000Z");
    const t1 = new Date("2026-11-18T10:00:15.000Z");
    await beat({ db, workerId: "w-a", concurrency: 5, running: () => [{ kind: "ai_job", id: "j1" }], now: () => t0 });
    await beat({ db, workerId: "w-a", concurrency: 5, running: () => [], now: () => t1 });
    const [row] = await db.select().from(workerHeartbeats).where(eq(workerHeartbeats.workerId, "w-a"));
    expect(row).toMatchObject({ concurrency: 5, running: [] });
    expect(row!.startedAt.toISOString()).toBe(t0.toISOString());
    expect(row!.seenAt.toISOString()).toBe(t1.toISOString());
  });

  it("pota le righe più vecchie di un giorno, non le altre", async () => {
    const now = new Date("2026-11-20T10:00:00.000Z");
    await beat({ db, workerId: "w-old", concurrency: 1, running: () => [], now: () => new Date(now.getTime() - WORKER_HEARTBEAT_RETENTION_MS - 1000) });
    await beat({ db, workerId: "w-recent", concurrency: 1, running: () => [], now: () => new Date(now.getTime() - 60_000) });
    await beat({ db, workerId: "w-new", concurrency: 2, running: () => [], now: () => now });
    const ids = (await db.select({ id: workerHeartbeats.workerId }).from(workerHeartbeats)).map((r) => r.id);
    expect(ids).not.toContain("w-old");
    expect(ids).toEqual(expect.arrayContaining(["w-recent", "w-new"]));
  });

  it("un errore non lancia: lo logga", async () => {
    const warn = vi.fn();
    await expect(beat({ db, workerId: "w-x", concurrency: 1, running: () => { throw new Error("boom"); }, logger: { warn } })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
