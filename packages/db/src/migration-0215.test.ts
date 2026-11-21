import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productDocJobs, productPages, productWireframes } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0215 (21 nov 2026, area 11, F6): le bozze di schermata. */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0215: le bozze di schermata", () => {
  it("una bozza nasce `drawing` senza varianti; uno stato ignoto no; il lavoro `wireframe` nella coda", async () => {
    const { projectId } = await seedRepository(t.db);
    const [page] = await t.db.insert(productPages).values({ projectId, title: "Checkout", blocks: [] }).returning();
    const [w] = await t.db.insert(productWireframes).values({ pageId: page!.id, projectId, blockId: "blk-1" }).returning();
    expect(w).toMatchObject({ status: "drawing", variants: [], error: null });
    await expect(t.db.execute(sql`update product_wireframes set status = 'stanco' where id = ${w!.id}`)).rejects.toThrow();
    await t.db.insert(productDocJobs).values({ projectId, sourceKind: "wireframe", sourceId: w!.id });
    // La pagina se ne va, la bozza con lei.
    await t.db.delete(productPages).where(sql`id = ${page!.id}`);
    expect(await t.db.select().from(productWireframes).where(sql`id = ${w!.id}`)).toEqual([]);
  });
});
