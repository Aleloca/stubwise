import { docChunks, type Db } from "@stubwise/db";
import { chunkMarkdown, DOC_CHUNK_OVERLAP_WORDS, DOC_CHUNK_TARGET_TOKENS, estimateTokens } from "@stubwise/docs-engine";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { eq } from "drizzle-orm";

/**
 * Gli embedding di una pagina MANUALE (area 5, fetta 1): le pagine generate li
 * ricevono dal worker, quelle scritte a mano da qui, al salvataggio, con lo
 * stesso chunking (`DOC_CHUNK_*` di `@stubwise/docs-engine`). I chunk di prima
 * si rifanno; all'eliminazione vanno via in cascata con la pagina.
 *
 * Fail-open: un embedder giù lascia la pagina salvata e trovabile per testo
 * (la ricerca è ibrida), e lo dice il log. Senza chunk validi niente si scrive.
 */
export async function embedManualPage(
  db: Db,
  embeddingClient: EmbeddingClient,
  page: { id: string; repositoryId: string; kind: string; body: string; sourcePath: string | null },
  log: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
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
  } catch (error) {
    log.warn({ err: error, pageId: page.id }, "embedding della pagina manuale non riuscito: si trova per testo");
  }
}
