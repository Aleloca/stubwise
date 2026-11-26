import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productDocJobs, productPageUpdates, productPages } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0217 (21 nov 2026, area 11, F6, Task 4): l'aggiornamento di una pagina da una fonte, chiesto a mano. */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0217: l'aggiornamento chiesto a mano", () => {
  it("una richiesta viva per pagina e fonte; finita, se ne chiede un'altra; se ne va con la pagina", async () => {
    const { projectId } = await seedRepository(t.db);
    const [page] = await t.db.insert(productPages).values({ projectId, title: "Phases", blocks: [] }).returning();
    const sourceId = "1c9e4f70-5555-4666-8777-888899990041";
    const [u1] = await t.db.insert(productPageUpdates).values({ projectId, pageId: page!.id, sourceKind: "email", sourceId }).returning();
    await expect(t.db.insert(productPageUpdates).values({ projectId, pageId: page!.id, sourceKind: "email", sourceId })).rejects.toThrow();
    // Solo un'email o una riunione.
    await expect(t.db.insert(productPageUpdates).values({ projectId, pageId: page!.id, sourceKind: "task" as never, sourceId })).rejects.toThrow();
    await t.db.update(productPageUpdates).set({ finishedAt: new Date() }).where(sql`id = ${u1!.id}`);
    await t.db.insert(productPageUpdates).values({ projectId, pageId: page!.id, sourceKind: "email", sourceId });
    // Il lavoro della coda: `page_update`, con la fonte = la richiesta.
    await t.db.insert(productDocJobs).values({ projectId, sourceKind: "page_update", sourceId: u1!.id });
    await t.db.delete(productPages).where(sql`id = ${page!.id}`);
    expect(await t.db.select().from(productPageUpdates).where(sql`page_id = ${page!.id}`)).toEqual([]);
  });
});
