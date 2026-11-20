import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { productPageChunks, productPages } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { createFakeEmbeddingClient, type EmbeddingClient } from "@stubwise/embeddings";
import { embedStaleProductPages, productChunkCount } from "./product-embed.js";

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

  it("eliminare la pagina toglie i suoi chunk", async () => {
    const p = await page("Via", ["Da eliminare"], ago(400));
    await embedStaleProductPages(t.db, embedder, log);
    expect(await productChunkCount(t.db, p.id)).toBeGreaterThan(0);
    await t.db.delete(productPages).where(eq(productPages.id, p.id));
    expect(await productChunkCount(t.db, p.id)).toBe(0);
  });
});
