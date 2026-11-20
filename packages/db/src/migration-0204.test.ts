import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productComments, productPages } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0204 (20 nov 2026, area 11, F2): i commenti delle pagine di prodotto. */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function page() {
  const { projectId } = await seedRepository(t.db);
  const [p] = await t.db.insert(productPages).values({ projectId, title: "Visione" }).returning();
  return p!.id;
}

describe("migrazione 0204", () => {
  it("un commento eliminato non ha più testo (la CHECK), e uno vuoto eliminato si scrive", async () => {
    const pageId = await page();
    const [c] = await t.db.insert(productComments).values({ pageId, anchorId: "blk-1", quote: "Frase", body: "Testo" }).returning();
    await expect(t.db.update(productComments).set({ deletedAt: new Date() }).where(eq(productComments.id, c!.id))).rejects.toThrow();
    await t.db.update(productComments).set({ deletedAt: new Date(), body: "" }).where(eq(productComments.id, c!.id));
    const [after] = await t.db.select().from(productComments).where(eq(productComments.id, c!.id));
    expect(after!.body).toBe("");
  });

  it("eliminare la pagina toglie i suoi fili, risposte comprese; `mentions` parte vuoto", async () => {
    const pageId = await page();
    const [root] = await t.db.insert(productComments).values({ pageId, anchorId: "blk-1", quote: "q", body: "radice" }).returning();
    expect(root!.mentions).toEqual([]);
    await t.db.insert(productComments).values({ pageId, anchorId: "blk-1", quote: "q", body: "risposta", replyToId: root!.id });
    await t.db.delete(productPages).where(eq(productPages.id, pageId));
    expect(await t.db.select().from(productComments).where(eq(productComments.pageId, pageId))).toHaveLength(0);
  });

  it("il journal: 0203 e 0204 in fila, `when` crescente", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0203_product_doc_notifications");
    expect(tags.slice(i, i + 2)).toEqual(["0203_product_doc_notifications", "0204_product_comments"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
  });
});
