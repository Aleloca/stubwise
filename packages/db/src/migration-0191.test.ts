import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
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

  it("il migratore ha applicato 0188, 0189, 0190 e 0191 in fila, e TUTTO il journal nel suo ordine (vale anche con le migrazioni dopo)", async () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0188_outgoing_webhooks");
    expect(tags.slice(i, i + 4)).toEqual(["0188_outgoing_webhooks", "0189_worker_model_env", "0190_ai_provider_secret_last4", "0191_instance_status"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
    const applied = (await t.db.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at`)) as unknown as { rows?: { created_at: string }[] } & { created_at: string }[];
    const rows = (applied.rows ?? applied) as { created_at: string }[];
    expect(rows.map((r) => Number(r.created_at))).toEqual(whens);
    const res = (await t.db.execute(sql`select
      exists(select 1 from information_schema.tables where table_name = 'outgoing_webhooks') as w,
      exists(select 1 from information_schema.columns where table_name = 'instance_settings' and column_name = 'worker_model_env_operations') as m,
      exists(select 1 from information_schema.columns where table_name = 'ai_providers' and column_name = 'secret_last4') as l,
      exists(select 1 from information_schema.tables where table_name = 'worker_heartbeats') as h,
      exists(select 1 from information_schema.columns where table_name = 'projects' and column_name = 'ingestion_key_created_by_user_id') as k`)) as unknown as { rows?: unknown[] } & unknown[];
    expect((res.rows ?? res)[0]).toEqual({ w: true, m: true, l: true, h: true, k: true });
  });
});
