import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveSectionHolds, releaseSections, takeSection } from "./product-holds.js";
import { productPages, users } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/** Area 11, F4, Task 1 (migrazione 0209): le sezioni prese di una pagina di prodotto. */
let t: TestDb;
let pageId: string;
let ada: string;
let bea: string;
beforeAll(async () => {
  t = await startTestDb();
  const { projectId } = await seedRepository(t.db);
  [{ id: pageId }] = (await t.db.insert(productPages).values({ projectId, title: "P" }).returning({ id: productPages.id })) as [{ id: string }];
  const person = async () => (await t.db.insert(users).values({ email: `u-${randomUUID().slice(0, 6)}@x.test`, passwordHash: "x", role: "member" }).returning({ id: users.id }))[0]!.id;
  ada = await person();
  bea = await person();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const T0 = new Date("2026-11-20T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("takeSection", () => {
  it("due persone sulla stessa sezione: la prima la prende, la seconda sa chi la tiene; sezioni diverse sì", async () => {
    expect(await takeSection(t.db, { pageId, sectionId: "blk-a", userId: ada, ttlMs: 15_000, now: T0 })).toEqual({ taken: true, expiresAt: at(15_000) });
    expect(await takeSection(t.db, { pageId, sectionId: "blk-a", userId: bea, ttlMs: 15_000, now: at(1000) })).toEqual({ taken: false, by: ada, expiresAt: at(15_000) });
    expect((await takeSection(t.db, { pageId, sectionId: "blk-b", userId: bea, ttlMs: 15_000, now: at(1000) })).taken).toBe(true);
  });

  it("la presa si rinnova per chi la tiene, e scade da sola: dopo, la prende un altro", async () => {
    expect(await takeSection(t.db, { pageId, sectionId: "blk-a", userId: ada, ttlMs: 15_000, now: at(10_000) })).toEqual({ taken: true, expiresAt: at(25_000) });
    expect((await takeSection(t.db, { pageId, sectionId: "blk-a", userId: bea, ttlMs: 15_000, now: at(20_000) })).taken).toBe(false);
    expect(await takeSection(t.db, { pageId, sectionId: "blk-a", userId: bea, ttlMs: 15_000, now: at(25_000) })).toEqual({ taken: true, expiresAt: at(40_000) });
  });

  it("due prese CONCORRENTI della stessa sezione libera: una sola passa", async () => {
    const results = await Promise.all([ada, bea].map((userId) => takeSection(t.db, { pageId, sectionId: "blk-c", userId, ttlMs: 15_000, now: T0 })));
    expect(results.filter((r) => r.taken)).toHaveLength(1);
  });

  it("le prese vive non contano le scadute; lasciarle toglie solo quelle di chi le lascia", async () => {
    expect((await liveSectionHolds(t.db, pageId, at(30_000))).map((h) => h.sectionId).sort()).toEqual(["blk-a"]);
    expect((await releaseSections(t.db, pageId, bea)).sort()).toEqual(["blk-a", "blk-b"]);
    expect(await liveSectionHolds(t.db, pageId, at(30_000))).toEqual([]);
  });

  it("il journal: 0208 e 0209 in fila, `when` crescente", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0208_doc_chat_product_sources");
    expect(tags.slice(i, i + 2)).toEqual(["0208_doc_chat_product_sources", "0209_product_section_holds"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
  });
});
