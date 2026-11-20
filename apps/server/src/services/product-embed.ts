import { productPageChunks, productPages, type Db } from "@stubwise/db";
import { chunkMarkdown, DOC_CHUNK_OVERLAP_WORDS, DOC_CHUNK_TARGET_TOKENS, estimateTokens } from "@stubwise/docs-engine";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { productBlockSchema, productBlocksToText, productSearchText, type ProductBlock } from "@stubwise/shared";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";

/**
 * Area 11, F3 — gli embedding delle pagine di prodotto. Li fa il SERVER, come
 * quelli delle pagine manuali dei Docs (`doc-embed.ts`), con lo stesso
 * chunking e lo stesso embedder, ma NON a ogni salvataggio: l'editor salva ogni
 * 800 ms. Un poller (`index.ts`, `PRODUCT_EMBED_POLL_SECONDS`) rifà le pagine
 * con `embedded_at` più vecchio di `updated_at` e FERME da almeno 30 s, al più
 * 20 per giro.
 *
 * - `embedded_at` è l'`updated_at` della versione che ha i chunk, mai `now()`:
 *   una scrittura arrivata durante l'embedding la rende di nuovo da rifare;
 * - i chunk si scrivono solo se la pagina è ancora quella letta (stesso
 *   `updated_at`, sotto il lock della riga): una pagina cambiata nel frattempo
 *   si rifà al giro dopo, mai con i chunk del testo vecchio;
 * - fail-open: un embedder giù lascia la pagina trovabile per testo e lo dice
 *   il log; i chunk del testo di prima si tolgono (direbbero ciò che la pagina
 *   non dice più), e il giro si ferma al primo errore.
 */

export const PRODUCT_EMBED_QUIET_SECONDS = 30;
export const PRODUCT_EMBED_BATCH = 20;

type Log = { warn: (obj: unknown, msg?: string) => void };

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

/**
 * Le pagine da rifare: mai fatte o cambiate dopo, e ferme da `quietSeconds`.
 * `version` è `updated_at` come TESTO del database (review di F3, I1): un `Date`
 * di JavaScript perde i microsecondi che `defaultNow()` scrive, e un confronto
 * o una scrittura col valore troncato lascerebbe `embedded_at < updated_at` per
 * sempre (la pagina rifatta a ogni giro, e le nuove mai). Confronti e scritture
 * di questa versione stanno in SQL.
 */
export async function staleProductPages(db: Db, opts: { now?: Date; quietSeconds?: number; limit?: number } = {}) {
  const quietBefore = new Date((opts.now ?? new Date()).getTime() - (opts.quietSeconds ?? PRODUCT_EMBED_QUIET_SECONDS) * 1000);
  return db
    .select({ id: productPages.id, projectId: productPages.projectId, title: productPages.title, blocks: productPages.blocks, version: sql<string>`${productPages.updatedAt}::text` })
    .from(productPages)
    .where(and(or(isNull(productPages.embeddedAt), lt(productPages.embeddedAt, productPages.updatedAt)), lt(productPages.updatedAt, quietBefore)))
    .orderBy(asc(productPages.updatedAt))
    .limit(opts.limit ?? PRODUCT_EMBED_BATCH);
}

type StalePage = Awaited<ReturnType<typeof staleProductPages>>[number];

/** L'esito di una pagina: fatta, embedder giù (il giro si ferma), o pagina rimandata (il giro va avanti). */
export type EmbedOutcome = "done" | "embedder_down" | "deferred";

const EMBEDDING_DIMENSIONS = 1024;

/** I chunk di UNA pagina, per la versione letta. */
export async function embedProductPage(db: Db, embeddingClient: EmbeddingClient, page: StalePage, log: Log): Promise<EmbedOutcome> {
  const text = productBlocksToText(page.title, readBlocks(page.blocks));
  const chunks = text.trim() ? chunkMarkdown(text, { targetTokens: DOC_CHUNK_TARGET_TOKENS, overlap: DOC_CHUNK_OVERLAP_WORDS }) : [];
  let vectors: number[][] = [];
  try {
    vectors = chunks.length > 0 ? await embeddingClient.embed(chunks.map((c) => c.content)) : [];
  } catch (error) {
    // L'embedder giù: per tutte le pagine, quindi il giro si ferma. I chunk di
    // prima dicono il testo VECCHIO: via, la pagina resta trovabile per testo.
    log.warn({ err: error, pageId: page.id }, "embedding della pagina di prodotto non riuscito: si trova per testo");
    await db
      .delete(productPageChunks)
      .where(eq(productPageChunks.pageId, page.id))
      .catch((err: unknown) => log.warn({ err, pageId: page.id }, "chunk vecchi della pagina di prodotto non tolti"));
    return "embedder_down";
  }
  try {
    if (vectors.length !== chunks.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) throw new Error("l'embedder ha risposto vettori di forma sbagliata");
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      // Ancora la versione letta? Se no, la rifà il giro dopo. Il confronto è in SQL (I1).
      const [same] = await tx
        .select({ id: productPages.id })
        .from(productPages)
        .where(and(eq(productPages.id, page.id), sql`${productPages.updatedAt} = ${page.version}::timestamptz`))
        .for("update");
      if (!same) return;
      await tx.delete(productPageChunks).where(eq(productPageChunks.pageId, page.id));
      if (chunks.length > 0) {
        await tx.insert(productPageChunks).values(
          chunks.map((c, i) => ({
            pageId: page.id,
            projectId: page.projectId,
            position: i,
            heading: c.heading ?? null,
            content: c.content,
            embedding: vectors[i]!,
            tokenCount: estimateTokens(c.content),
          })),
        );
      }
      // `embedded_at` = `updated_at` del database (I1); il testo cercabile, per le pagine di prima della 0207.
      await tx.update(productPages).set({ embeddedAt: sql`${productPages.updatedAt}`, searchText: productSearchText(page.title, readBlocks(page.blocks)) }).where(eq(productPages.id, page.id));
    });
    return "done";
  } catch (error) {
    // Review di F3 (I6): un errore di QUESTA pagina (un chunk rifiutato, un vettore
    // di forma sbagliata, un errore SQL) non blocca la coda. La pagina si rimanda
    // fino alla sua prossima modifica (`embedded_at` = la versione letta, senza
    // chunk), resta trovabile per testo, e lo dice il log.
    log.warn({ err: error, pageId: page.id }, "embedding della pagina di prodotto rimandato alla sua prossima modifica");
    await db
      .transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        await tx.delete(productPageChunks).where(eq(productPageChunks.pageId, page.id));
        await tx.update(productPages).set({ embeddedAt: sql`${page.version}::timestamptz` }).where(eq(productPages.id, page.id));
      })
      .catch((err: unknown) => log.warn({ err, pageId: page.id }, "pagina di prodotto non rimandata"));
    return "deferred";
  }
}

/**
 * Il testo cercabile (0207) delle pagine che non l'hanno ancora: quelle di
 * prima della colonna. Il titolo non è mai vuoto, quindi `''` vuol dire «mai
 * calcolato». NON dipende dall'embedder (46): con ollama giù la ricerca per
 * testo deve trovarle lo stesso. Le scritture lo tengono aggiornato da sole.
 */
export async function backfillProductSearchText(db: Db, limit = 100): Promise<number> {
  const rows = await db
    .select({ id: productPages.id, title: productPages.title, blocks: productPages.blocks })
    .from(productPages)
    .where(eq(productPages.searchText, ""))
    .limit(limit);
  for (const r of rows) {
    // Solo se è ancora vuoto: una scrittura arrivata nel frattempo l'ha già messo, di adesso.
    await db
      .update(productPages)
      .set({ searchText: productSearchText(r.title, readBlocks(r.blocks)) })
      .where(and(eq(productPages.id, r.id), eq(productPages.searchText, "")));
  }
  return rows.length;
}

/**
 * Review di F3 (I5): TUTTO il testo cercabile che manca, a lotti, all'avvio del
 * server, che il poller sia acceso o no (`PRODUCT_EMBED_POLL_SECONDS` vuota
 * spegne gli embedding, non la ricerca per testo).
 */
export async function backfillAllProductSearchText(db: Db, batch = 100): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await backfillProductSearchText(db, batch);
    total += n;
    if (n < batch) return total;
  }
}

/**
 * Un giro del poller: prima il testo cercabile che manca (senza l'embedder),
 * poi le pagine ferme da rifare. Si ferma quando l'embedder non risponde; una
 * pagina che sbaglia per conto suo si rimanda e il giro va avanti (I6).
 * Restituisce quante pagine ha fatto con gli embedding.
 */
export async function embedStaleProductPages(db: Db, embeddingClient: EmbeddingClient, log: Log, opts: { now?: Date; quietSeconds?: number; limit?: number } = {}): Promise<number> {
  await backfillProductSearchText(db).catch((error: unknown) => log.warn({ err: error }, "testo cercabile delle pagine di prodotto non ricostruito"));
  let done = 0;
  for (const page of await staleProductPages(db, opts)) {
    const outcome = await embedProductPage(db, embeddingClient, page, log);
    if (outcome === "embedder_down") break;
    if (outcome === "done") done += 1;
  }
  return done;
}

/**
 * Review di F3 (C1): il poller, da avviare PRIMA di `app.listen` (Fastify non
 * accetta un `addHook` dopo: `FST_ERR_INSTANCE_ALREADY_LISTENING`, e il server
 * uscirebbe all'avvio). Un giro alla volta.
 */
export function startProductEmbedPoller(
  app: { db: Db; embeddingClient: EmbeddingClient; log: Log; addHook: (name: "onClose", fn: () => Promise<void>) => unknown },
  seconds: number,
): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void embedStaleProductPages(app.db, app.embeddingClient, app.log)
      .catch((error: unknown) => app.log.warn({ err: error }, "giro degli embedding delle pagine di prodotto non riuscito"))
      .finally(() => {
        running = false;
      });
  }, seconds * 1000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
  return timer;
}

/** Per i test e la diagnostica: quanti chunk ha una pagina. */
export async function productChunkCount(db: Db, pageId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(productPageChunks).where(eq(productPageChunks.pageId, pageId));
  return row?.n ?? 0;
}
