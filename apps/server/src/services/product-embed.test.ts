import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { productPageChunks, productPages } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { createFakeEmbeddingClient, type EmbeddingClient } from "@stubwise/embeddings";
import { backfillAllProductSearchText, embedStaleProductPages, productChunkCount, startProductEmbedPoller } from "./product-embed.js";

// Area 11, F3, Task 1: gli embedding delle pagine di prodotto. Il poller rifà
// solo le pagine FERME da 30 s; i chunk di prima si rifanno; un embedder giù
// lascia la pagina senza chunk e lo dice il log; l'eliminazione li toglie.

let t: TestDb;
let projectId: string;
const embedder = createFakeEmbeddingClient();
const log = { warn: vi.fn() };

beforeAll(async () => {
  t = await startTestDb();
  ({ projectId } = await seedRepository(t.db));
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const para = (id: string, text: string) => ({ id, type: "paragraph", content: { text, marks: [] } });
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

async function page(title: string, texts: string[], updatedAt: Date) {
  const [row] = await t.db
    .insert(productPages)
    .values({ projectId, title, blocks: texts.map((x, i) => para(`blk-${i}`, x)), updatedAt })
    .returning();
  return row!;
}

describe("embedStaleProductPages", () => {
  it("una pagina ferma da 30 s riceve i chunk (col titolo nel testo); una in scrittura no", async () => {
    const still = await page("Ferma", ["Il testo della pagina ferma"], ago(60));
    const fresh = await page("Fresca", ["Qualcuno sta scrivendo"], ago(5));
    await embedStaleProductPages(t.db, embedder, log);
    expect(await productChunkCount(t.db, still.id)).toBeGreaterThan(0);
    expect(await productChunkCount(t.db, fresh.id)).toBe(0);
    const [chunk] = await t.db.select().from(productPageChunks).where(eq(productPageChunks.pageId, still.id));
    expect(chunk!.content).toContain("Il testo della pagina ferma");
    expect(chunk!.projectId).toBe(projectId);
    const [after] = await t.db.select({ embeddedAt: productPages.embeddedAt }).from(productPages).where(eq(productPages.id, still.id));
    expect(after!.embeddedAt!.getTime()).toBe(still.updatedAt.getTime());
    const [freshAfter] = await t.db.select({ embeddedAt: productPages.embeddedAt }).from(productPages).where(eq(productPages.id, fresh.id));
    expect(freshAfter!.embeddedAt).toBeNull();
  });

  it("una pagina cambiata si rifà: i chunk di prima vanno via; una già fatta non si rifà", async () => {
    const p = await page("Cambia", ["Testo vecchio"], ago(120));
    await embedStaleProductPages(t.db, embedder, log);
    await t.db.update(productPages).set({ blocks: [para("blk-0", "Testo nuovo")], updatedAt: ago(40) }).where(eq(productPages.id, p.id));
    const spy = vi.spyOn(embedder, "embed");
    await embedStaleProductPages(t.db, embedder, log);
    const contents = (await t.db.select({ c: productPageChunks.content }).from(productPageChunks).where(eq(productPageChunks.pageId, p.id))).map((r) => r.c).join(" ");
    expect(contents).toContain("Testo nuovo");
    expect(contents).not.toContain("Testo vecchio");
    spy.mockClear();
    await embedStaleProductPages(t.db, embedder, log);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("un embedder giù: la pagina resta senza chunk (anche quelli di prima), lo dice il log, e si riprova al giro dopo", async () => {
    const p = await page("Giù", ["Prima"], ago(200));
    await embedStaleProductPages(t.db, embedder, log);
    expect(await productChunkCount(t.db, p.id)).toBeGreaterThan(0);
    await t.db.update(productPages).set({ blocks: [para("blk-0", "Dopo")], updatedAt: ago(100) }).where(eq(productPages.id, p.id));
    const down: EmbeddingClient = { ...embedder, embed: async () => Promise.reject(new Error("ollama giù")) };
    log.warn.mockClear();
    await embedStaleProductPages(t.db, down, log);
    expect(await productChunkCount(t.db, p.id)).toBe(0);
    expect(log.warn).toHaveBeenCalled();
    const [row] = await t.db.select({ embeddedAt: productPages.embeddedAt, updatedAt: productPages.updatedAt }).from(productPages).where(eq(productPages.id, p.id));
    expect(row!.embeddedAt!.getTime()).toBeLessThan(row!.updatedAt.getTime());
    await embedStaleProductPages(t.db, embedder, log);
    expect(await productChunkCount(t.db, p.id)).toBeGreaterThan(0);
  });

  it("una pagina cambiata MENTRE si fanno i suoi embedding non riceve i chunk del testo vecchio", async () => {
    const p = await page("Durante", ["Versione uno"], ago(300));
    const racing: EmbeddingClient = {
      ...embedder,
      embed: async (texts: string[]) => {
        await t.db.update(productPages).set({ blocks: [para("blk-0", "Versione due")], updatedAt: new Date() }).where(eq(productPages.id, p.id));
        return embedder.embed(texts);
      },
    };
    await embedStaleProductPages(t.db, racing, log);
    expect(await productChunkCount(t.db, p.id)).toBe(0);
    const [row] = await t.db.select({ embeddedAt: productPages.embeddedAt }).from(productPages).where(eq(productPages.id, p.id));
    expect(row!.embeddedAt).toBeNull();
  });

  it("una pagina di prima della 0207 (testo cercabile vuoto) lo riceve dal poller, piegato", async () => {
    const p = await page("Vecchia Pagina", ["Il Caffè"], ago(500));
    expect(p.searchText).toBe("");
    await embedStaleProductPages(t.db, embedder, log);
    const [row] = await t.db.select({ searchText: productPages.searchText }).from(productPages).where(eq(productPages.id, p.id));
    expect(row!.searchText).toBe("vecchia pagina\nil caffe");
  });

  it("46: con l'embedder giù il testo cercabile delle pagine di prima arriva lo stesso (non dipende dagli embedding)", async () => {
    const a = await page("Prima A", ["Caffè"], ago(600));
    const b = await page("Prima B", ["Tè"], ago(600));
    const down: EmbeddingClient = { ...embedder, embed: async () => Promise.reject(new Error("ollama giù")) };
    await embedStaleProductPages(t.db, down, log);
    const rows = await t.db.select({ id: productPages.id, searchText: productPages.searchText }).from(productPages).where(inArray(productPages.id, [a.id, b.id]));
    expect(new Map(rows.map((r) => [r.id, r.searchText]))).toEqual(new Map([[a.id, "prima a\ncaffe"], [b.id, "prima b\nte"]]));
  });

  it("eliminare la pagina toglie i suoi chunk", async () => {
    const p = await page("Via", ["Da eliminare"], ago(400));
    await embedStaleProductPages(t.db, embedder, log);
    expect(await productChunkCount(t.db, p.id)).toBeGreaterThan(0);
    await t.db.delete(productPages).where(eq(productPages.id, p.id));
    expect(await productChunkCount(t.db, p.id)).toBe(0);
  });

  it("review di F3 (I1): una pagina col `updated_at` del database (microsecondi) si fa UNA volta, non a ogni giro", async () => {
    // Senza `updatedAt` dal JS: lo scrive `defaultNow()` di Postgres, coi microsecondi.
    const [row] = await t.db.insert(productPages).values({ projectId, title: "Dal database", blocks: [para("blk-0", "Testo")] }).returning();
    await t.db.update(productPages).set({ updatedAt: sql`now() - interval '1 minute' + interval '123 microseconds'` }).where(eq(productPages.id, row!.id));
    await embedStaleProductPages(t.db, embedder, log);
    expect(await productChunkCount(t.db, row!.id)).toBeGreaterThan(0);
    const spy = vi.spyOn(embedder, "embed");
    await embedStaleProductPages(t.db, embedder, log);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const [after] = await t.db.select({ same: sql<boolean>`${productPages.embeddedAt} = ${productPages.updatedAt}` }).from(productPages).where(eq(productPages.id, row!.id));
    expect(after!.same).toBe(true);
  });

  it("review di F3 (I6): una pagina che sbaglia per conto suo si rimanda e il giro va avanti", async () => {
    const bad = await page("Rotta", ["CONTENUTO CHE ROMPE"], ago(700));
    const good = await page("Buona", ["Contenuto normale"], ago(690));
    const picky: EmbeddingClient = {
      ...embedder,
      embed: async (texts: string[]) => (texts.some((x) => x.includes("ROMPE")) ? texts.map(() => [1, 2, 3]) : embedder.embed(texts)),
    };
    log.warn.mockClear();
    await embedStaleProductPages(t.db, picky, log);
    expect(await productChunkCount(t.db, good.id)).toBeGreaterThan(0);
    expect(await productChunkCount(t.db, bad.id)).toBe(0);
    expect(log.warn).toHaveBeenCalled();
    // Rimandata: al giro dopo non si riprova (fino alla sua prossima modifica).
    const spy = vi.spyOn(picky, "embed");
    await embedStaleProductPages(t.db, picky, log);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("review di F3 (C1): il poller si avvia prima di `listen`", () => {
  it("registrato prima che il server parta, l'app si avvia e si chiude; dopo, Fastify lo rifiuta", async () => {
    const { buildApp } = await import("../app.js");
    const app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), embeddingClient: embedder });
    startProductEmbedPoller(app, 30);
    await app.ready();
    expect(() => startProductEmbedPoller(app, 30)).toThrow(/already listening|Cannot call "addHook"/i);
    await app.close();
  });

  it("review di F3 (I5): il testo cercabile di TUTTE le pagine di prima, a lotti, senza l'embedder; e index.ts lo fa qualunque sia l'env", async () => {
    await t.db.insert(productPages).values(Array.from({ length: 7 }, (_, i) => ({ projectId, title: `Lotto ${i}`, blocks: [para("blk-0", "Caffè")] })));
    const n = await backfillAllProductSearchText(t.db, 3);
    expect(n).toBeGreaterThanOrEqual(7);
    expect((await t.db.select({ id: productPages.id }).from(productPages).where(eq(productPages.searchText, "")))).toEqual([]);
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const call = src.indexOf("void backfillAllProductSearchText(app.db)");
    expect(call).toBeGreaterThan(0);
    // Non dentro l'`if` del poller: quell'`if` è una riga sola, che non lo contiene.
    const pollerLine = src.split("\n").find((l) => l.includes("config.productEmbedPollSeconds !== undefined"))!;
    expect(pollerLine).not.toContain("backfillAllProductSearchText");
  });

  it("index.ts lo avvia PRIMA di `app.listen`", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(src.indexOf("startProductEmbedPoller(app")).toBeGreaterThan(0);
    expect(src.indexOf("startProductEmbedPoller(app")).toBeLessThan(src.indexOf("await app.listen("));
  });
});
