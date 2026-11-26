import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productDocJobs, productFirstVersions, productPageRevisions, productPages } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0214 (21 nov 2026, area 11, F6): la prima versione di Claude. */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0214: la prima versione", () => {
  it("una per progetto viva alla volta (`writing`); uno stato ignoto no", async () => {
    const { projectId } = await seedRepository(t.db);
    const [fv] = await t.db.insert(productFirstVersions).values({ projectId, sources: [] }).returning();
    expect(fv).toMatchObject({ status: "writing", interrupted: false, stopRequested: false, plan: [], written: [], acceptedPageIds: [], pastedText: null });
    await expect(t.db.insert(productFirstVersions).values({ projectId, sources: [] })).rejects.toThrow();
    await t.db.execute(sql`update product_first_versions set status = 'done' where id = ${fv!.id}`);
    await t.db.insert(productFirstVersions).values({ projectId, sources: [] });
    await expect(t.db.execute(sql`update product_first_versions set status = 'stanco' where id = ${fv!.id}`)).rejects.toThrow();
  });

  it("il lavoro `first_version` nella coda della doc, e la revisione `first_version` di una pagina", async () => {
    const { projectId } = await seedRepository(t.db);
    await t.db.insert(productDocJobs).values({ projectId, sourceKind: "first_version", sourceId: crypto.randomUUID() });
    const [page] = await t.db.insert(productPages).values({ projectId, title: "Overview", blocks: [] }).returning();
    await t.db.insert(productPageRevisions).values({ pageId: page!.id, seq: 1, lastSeq: 1, kind: "first_version", via: "claude", changes: [] });
  });
});
