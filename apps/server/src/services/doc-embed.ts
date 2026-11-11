import { docChunks, docPages, type Db } from "@stubwise/db";
import { chunkMarkdown, DOC_CHUNK_OVERLAP_WORDS, DOC_CHUNK_TARGET_TOKENS, estimateTokens } from "@stubwise/docs-engine";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { and, asc, eq, gt, sql } from "drizzle-orm";

/**
 * Gli embedding di una pagina MANUALE (area 5, fetta 1): le pagine generate li
 * ricevono dal worker, quelle scritte a mano da qui, al salvataggio, con lo
 * stesso chunking (`DOC_CHUNK_*` di `@stubwise/docs-engine`). I chunk di prima
 * si rifanno; all'eliminazione vanno via in cascata con la pagina.
 *
 * Fail-open: un embedder giù lascia la pagina salvata e trovabile per testo
 * (la ricerca è ibrida), e lo dice il log; i chunk del testo di prima si
 * tolgono comunque. Senza chunk validi niente si scrive.
 */
export async function embedManualPage(
  db: Db,
  embeddingClient: EmbeddingClient,
  page: { id: string; repositoryId: string; kind: string; body: string; sourcePath: string | null },
  log: { warn: (obj: unknown, msg?: string) => void },
): Promise<boolean> {
  try {
    const chunks = chunkMarkdown(page.body, { targetTokens: DOC_CHUNK_TARGET_TOKENS, overlap: DOC_CHUNK_OVERLAP_WORDS });
    const vectors = chunks.length > 0 ? await embeddingClient.embed(chunks.map((c) => c.content)) : [];
    await db.transaction(async (tx) => {
      await tx.delete(docChunks).where(eq(docChunks.pageId, page.id));
      if (chunks.length === 0) return;
      await tx.insert(docChunks).values(
        chunks.map((c, i) => ({
          pageId: page.id,
          repositoryId: page.repositoryId,
          generationId: null,
          content: c.content,
          embedding: vectors[i] ?? [],
          metadata: { heading: c.heading, sourcePath: page.sourcePath, layer: page.kind },
          tokenCount: estimateTokens(c.content),
        })),
      );
    });
    return true;
  } catch (error) {
    log.warn({ err: error, pageId: page.id }, "embedding della pagina manuale non riuscito: si trova per testo");
    // I chunk di prima dicono il testo VECCHIO: lasciati lì, la ricerca per
    // significato e la chat RAG troverebbero ciò che la pagina non dice più.
    await db
      .delete(docChunks)
      .where(eq(docChunks.pageId, page.id))
      .catch((err: unknown) => log.warn({ err, pageId: page.id }, "chunk vecchi della pagina manuale non tolti"));
    return false;
  }
}

/**
 * Il backfill degli embedding delle pagine manuali scritte PRIMA della 0142
 * (review della fetta 1): le manuali con un corpo e senza chunk, a lotti in
 * ordine di id. Idempotente (una pagina coi chunk non si rifà), fail-open: al
 * primo errore dell'embedder il giro si ferma, e il successivo (all'avvio del
 * server e poi una volta l'ora) riprende da quelle che mancano. Restituisce
 * quante pagine ha fatto.
 */
export async function backfillManualPageEmbeddings(
  db: Db,
  embeddingClient: EmbeddingClient,
  log: { warn: (obj: unknown, msg?: string) => void },
  opts: { batchSize?: number } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 20;
  let after: string | null = null;
  let done = 0;
  for (;;) {
    const pages: { id: string; repositoryId: string; kind: string; body: string; sourcePath: string | null }[] = await db
      .select({ id: docPages.id, repositoryId: docPages.repositoryId, kind: docPages.kind, body: docPages.body, sourcePath: docPages.sourcePath })
      .from(docPages)
      .where(
        and(
          eq(docPages.isManual, true),
          sql`length(btrim(${docPages.body})) > 0`,
          sql`not exists (select 1 from ${docChunks} c where c.page_id = ${docPages.id})`,
          after ? gt(docPages.id, after) : undefined,
        ),
      )
      .orderBy(asc(docPages.id))
      .limit(batchSize);
    if (pages.length === 0) return done;
    for (const page of pages) {
      if (!(await embedManualPage(db, embeddingClient, page, log))) return done;
      done += 1;
      after = page.id;
    }
  }
}
