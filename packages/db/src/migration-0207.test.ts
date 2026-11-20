import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productPages } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0207 (20 nov 2026, area 11, F3): il testo cercabile delle pagine di prodotto. */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0207", () => {
  it("una pagina nasce con il testo cercabile vuoto (lo scrivono le rotte, o il poller per quelle di prima)", async () => {
    const { projectId } = await seedRepository(t.db);
    const [page] = await t.db.insert(productPages).values({ projectId, title: "P" }).returning();
    expect(page!.searchText).toBe("");
  });

  it("il journal: 0206 e 0207 in fila, `when` crescente; la 0207 è la sola colonna", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0206_product_page_chunks");
    expect(tags.slice(i, i + 2)).toEqual(["0206_product_page_chunks", "0207_product_pages_search_text"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
    const sql = readFileSync(new URL("../drizzle/0207_product_pages_search_text.sql", import.meta.url), "utf8").replace(/--.*$/gm, "").trim();
    expect(sql).toBe(`ALTER TABLE "product_pages" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;`);
  });
});
