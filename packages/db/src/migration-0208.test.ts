import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Migrazione 0208 (20 nov 2026, area 11, F3): le fonti di prodotto dei messaggi della chat dei Docs. */
describe("migrazione 0208", () => {
  it("il journal: 0207 e 0208 in fila, `when` crescente; la 0208 è la sola colonna, con default", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0207_product_pages_search_text");
    expect(tags.slice(i, i + 2)).toEqual(["0207_product_pages_search_text", "0208_doc_chat_product_sources"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
    const sql = readFileSync(new URL("../drizzle/0208_doc_chat_product_sources.sql", import.meta.url), "utf8").replace(/--.*$/gm, "").trim();
    expect(sql).toBe(`ALTER TABLE "doc_chat_messages" ADD COLUMN "product_sources" jsonb DEFAULT '[]'::jsonb NOT NULL;`);
  });
});
