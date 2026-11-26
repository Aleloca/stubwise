import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productPageChunks, productPages } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0206 (20 nov 2026, area 11, F3): i chunk delle pagine di prodotto. */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0206", () => {
  it("una pagina nasce senza `embedded_at`; i suoi chunk vanno via con lei", async () => {
    const { projectId } = await seedRepository(t.db);
    const [page] = await t.db.insert(productPages).values({ projectId, title: "Visione" }).returning();
    expect(page!.embeddedAt).toBeNull();
    await t.db.insert(productPageChunks).values({ pageId: page!.id, projectId, position: 0, content: "x", embedding: Array.from({ length: 1024 }, () => 0.1) });
    await t.db.delete(productPages).where(eq(productPages.id, page!.id));
    expect(await t.db.select().from(productPageChunks).where(eq(productPageChunks.pageId, page!.id))).toHaveLength(0);
  });

  it("il journal: 0205 e 0206 in fila, `when` crescente; l'indice HNSW c'è", async () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0205_product_comments_original_anchor");
    expect(tags.slice(i, i + 2)).toEqual(["0205_product_comments_original_anchor", "0206_product_page_chunks"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
    const rows = (await t.db.execute(`select indexdef from pg_indexes where indexname = 'product_page_chunks_embedding_idx'`)) as unknown as { indexdef: string }[];
    expect(rows[0]?.indexdef).toContain("hnsw");
  });
});
