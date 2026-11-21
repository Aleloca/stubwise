import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backlogJobs, productPages, productRequestOrigins } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0216 (21 nov 2026, area 11, F6): la pagina da cui nasce una richiesta. */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0216: l'origine di una richiesta dalla doc", () => {
  it("un'origine per lavoro d'intake, l'ancora facoltativa; se ne va con la pagina e col lavoro", async () => {
    const { projectId } = await seedRepository(t.db);
    const [page] = await t.db.insert(productPages).values({ projectId, title: "Phases", blocks: [] }).returning();
    const job = async () => (await t.db.insert(backlogJobs).values({ projectId, kind: "intake", payload: { title: "T", body: "" } }).returning())[0]!;
    const j1 = await job();
    const [o] = await t.db.insert(productRequestOrigins).values({ projectId, pageId: page!.id, anchorId: "blk-1", intakeJobId: j1.id }).returning();
    expect(o).toMatchObject({ anchorId: "blk-1", questionId: null, createdBy: null });
    // Un lavoro, un'origine.
    await expect(t.db.insert(productRequestOrigins).values({ projectId, pageId: page!.id, anchorId: "blk-2", intakeJobId: j1.id })).rejects.toThrow();
    const j2 = await job();
    await t.db.insert(productRequestOrigins).values({ projectId, pageId: page!.id, anchorId: null, intakeJobId: j2.id });
    await t.db.delete(backlogJobs).where(sql`id = ${j1.id}`);
    expect(await t.db.select().from(productRequestOrigins).where(sql`intake_job_id = ${j1.id}`)).toEqual([]);
    await t.db.delete(productPages).where(sql`id = ${page!.id}`);
    expect(await t.db.select().from(productRequestOrigins).where(sql`page_id = ${page!.id}`)).toEqual([]);
  });
});
