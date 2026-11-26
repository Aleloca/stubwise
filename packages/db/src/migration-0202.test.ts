import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docPageCodes, docPages, productPageRevisions, productPages, projects } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0202 (20 nov 2026, area 11, F1): lo spazio Product e la serie `-D` condivisa. */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const numberOf = async (pageId: string) =>
  (await t.db.select({ n: docPageCodes.number }).from(docPageCodes).where(eq(docPageCodes.productPageId, pageId)))[0]?.n;

describe("migrazione 0202", () => {
  it("una pagina di prodotto prende il numero DOPO le pagine dei Docs dello stesso progetto, e un numero non si riusa", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    await t.db.insert(docPages).values({ repositoryId, kind: "manual", slug: "runbook", title: "Runbook", body: "x", isManual: true });
    const [a] = await t.db.insert(productPages).values({ projectId, title: "Visione" }).returning();
    expect(await numberOf(a!.id)).toBe(2);
    const [b] = await t.db.insert(productPages).values({ projectId, title: "Utenti" }).returning();
    expect(await numberOf(b!.id)).toBe(3);
    await t.db.delete(productPages).where(eq(productPages.id, b!.id));
    // La riga del codice resta, senza pagina: il numero è preso.
    const orphan = await t.db.select().from(docPageCodes).where(sql`project_id = ${projectId} and number = 3`);
    expect(orphan).toHaveLength(1);
    expect(orphan[0]!.productPageId).toBeNull();
    const [c] = await t.db.insert(productPages).values({ projectId, title: "Prezzi" }).returning();
    expect(await numberOf(c!.id)).toBe(4);
    // Una pagina dei Docs dopo continua la stessa serie.
    await t.db.insert(docPages).values({ repositoryId, kind: "manual", slug: "dopo", title: "Dopo", body: "x", isManual: true });
    const [docs] = await t.db.select({ n: docPageCodes.number }).from(docPageCodes).where(sql`repository_id = ${repositoryId} and slug = 'dopo'`);
    expect(docs!.n).toBe(5);
  });

  it("due pagine create insieme non prendono lo stesso numero (il lock per progetto)", async () => {
    const { projectId } = await seedRepository(t.db);
    const pages = await Promise.all(Array.from({ length: 8 }, (_, i) => t.db.insert(productPages).values({ projectId, title: `P${i}` }).returning()));
    const numbers = await Promise.all(pages.map(([p]) => numberOf(p!.id)));
    expect(new Set(numbers).size).toBe(8);
  });

  it("una riga del codice è di un repository o di una pagina, mai di entrambi; una pagina non è padre di sé", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const [p] = await t.db.insert(productPages).values({ projectId, title: "X" }).returning();
    await expect(t.db.insert(docPageCodes).values({ projectId, number: 900, repositoryId, slug: "s", productPageId: p!.id })).rejects.toThrow();
    await expect(t.db.insert(docPageCodes).values({ projectId, number: 901, repositoryId })).rejects.toThrow();
    await expect(t.db.update(productPages).set({ parentId: p!.id }).where(eq(productPages.id, p!.id))).rejects.toThrow();
  });

  it("una pagina con figlie non si elimina; un progetto che se ne va porta via anche le pagine annidate", async () => {
    const { projectId } = await seedRepository(t.db);
    const [parent] = await t.db.insert(productPages).values({ projectId, title: "Padre" }).returning();
    const [child] = await t.db.insert(productPages).values({ projectId, title: "Figlia", parentId: parent!.id }).returning();
    await t.db.insert(productPages).values({ projectId, title: "Nipote", parentId: child!.id });
    await expect(t.db.delete(productPages).where(eq(productPages.id, parent!.id))).rejects.toThrow();
    await t.db.delete(projects).where(eq(projects.id, projectId));
    expect(await t.db.select().from(productPages).where(eq(productPages.projectId, projectId))).toEqual([]);
  });

  it("le revisioni: create, edit, rename e move; più d'una per la stessa sessione; un tipo inventato no", async () => {
    const { projectId } = await seedRepository(t.db);
    const [p] = await t.db.insert(productPages).values({ projectId, title: "R" }).returning();
    await t.db.insert(productPageRevisions).values([
      { pageId: p!.id, seq: 1, lastSeq: 1, kind: "create" },
      { pageId: p!.id, sessionId: "s1", seq: 2, lastSeq: 2, kind: "edit" },
      { pageId: p!.id, seq: 3, lastSeq: 3, kind: "rename", title: { before: "R", after: "Requisiti" } },
      { pageId: p!.id, sessionId: "s1", seq: 4, lastSeq: 4, kind: "edit" },
      { pageId: p!.id, seq: 5, lastSeq: 5, kind: "move", parent: { beforeId: null, afterId: null } },
    ]);
    await expect(t.db.insert(productPageRevisions).values({ pageId: p!.id, seq: 6, lastSeq: 6, kind: "inventato" as never })).rejects.toThrow();
  });

  it("il journal: 0201 e 0202 in fila, `when` crescente", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0201_claude_capabilities_suggestions");
    expect(tags.slice(i, i + 2)).toEqual(["0201_claude_capabilities_suggestions", "0202_product_docs"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
  });
});
