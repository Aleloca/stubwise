import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productComments, productPages } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0205 (20 nov 2026, area 11, review di F2 M4): l'ancora di prima di un `merge`. */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0205", () => {
  it("un commento nasce senza ancora di prima (null)", async () => {
    const { projectId } = await seedRepository(t.db);
    const [page] = await t.db.insert(productPages).values({ projectId, title: "P" }).returning();
    const [c] = await t.db.insert(productComments).values({ pageId: page!.id, anchorId: "blk-1", quote: "q", body: "b" }).returning();
    expect(c!.originalAnchorId).toBeNull();
  });

  it("il journal: 0204 e 0205 in fila, `when` crescente; la 0205 è la sola colonna", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0204_product_comments");
    expect(tags.slice(i, i + 2)).toEqual(["0204_product_comments", "0205_product_comments_original_anchor"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
    const sql = readFileSync(new URL("../drizzle/0205_product_comments_original_anchor.sql", import.meta.url), "utf8").replace(/--.*$/gm, "").trim();
    expect(sql).toBe(`ALTER TABLE "product_comments" ADD COLUMN "original_anchor_id" text;`);
  });
});
