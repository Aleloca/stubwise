import { docChunks, type Db } from "@stubwise/db";
import { chunkMarkdown, estimateTokens } from "@stubwise/docs-engine";
import type { EmbeddingClient } from "@stubwise/embeddings";

/**
 * Embedding markdown-aware delle pagine di documentazione, ESTRATTO dalla pipeline
 * map-reduce (pipeline.ts) per il riuso del nuovo motore a DAG (recursive/finalize.ts).
 *
 * Una pagina viene spezzata in chunk con `chunkMarkdown` (split per heading, target
 * in token, overlap), TUTTI i chunk di TUTTE le pagine sono raccolti in un'unica lista
 * e mandati a `embed()` in BATCH di al più `batchSize` input — indipendentemente dai
 * confini di pagina, così nessuna chiamata supera il limite del provider anche se una
 * pagina genera molti chunk. I risultati sono concatenati in ordine e riallineati 1:1
 * ai chunk; l'insert dei `doc_chunks` (embedding 1024-dim + metadata) avviene nello
 * stesso `db`/`tx` passato dal chiamante (atomicità delegata al chiamante).
 */

/** Drizzle DB o una sua transazione (stessa interfaccia di query). */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Target/overlap del chunking markdown per l'embedding (token stimati). */
export const CHUNK_TARGET_TOKENS = 400;
export const CHUNK_OVERLAP_WORDS = 40;

/**
 * Tetto al numero di input per singola chiamata `embed()`: una pagina grande può
 * produrre più chunk di quanti il provider accetti in un solo batch.
 */
export const EMBED_BATCH_SIZE = 64;

/** La forma minima di una pagina persistita necessaria all'embedding. */
export interface EmbeddablePage {
  id: string;
  body: string;
  kind: string;
  sourcePath: string | null;
}

export interface EmbedAndStoreInput<P extends EmbeddablePage> {
  projectId: string;
  generationId: string;
  pages: P[];
  /** Tetto di input per chiamata `embed()` (vedi `EMBED_BATCH_SIZE`). */
  batchSize: number;
}

/** Chunk con il riferimento alla pagina di provenienza (per l'insert). */
interface PageChunk<P extends EmbeddablePage> {
  page: P;
  content: string;
  heading: string | null;
  embedding: number[];
}

/**
 * Esito dell'embedding: il numero totale di chunk inseriti + il vettore aggregato
 * PER PAGINA (media dei vettori dei suoi chunk), utile a calcolare i link `related`
 * a livello di pagina senza ri-leggere i chunk dal DB. Una pagina senza chunk (corpo
 * vuoto) NON compare in `pageVectors`.
 */
export interface EmbedAndStoreResult {
  chunkCount: number;
  /** pageId → vettore di pagina (media dei chunk). Solo pagine con almeno un chunk. */
  pageVectors: Map<string, number[]>;
}

/** Spezza un array in sotto-array di al più `size` elementi. */
function batched<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/** Media componente per componente dei vettori (tutti della stessa dimensione). */
function meanVector(vectors: number[][]): number[] {
  const first = vectors[0];
  if (!first) return [];
  const dim = first.length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i += 1) sum[i] = (sum[i] as number) + (v[i] ?? 0);
  }
  return sum.map((s) => s / vectors.length);
}

/**
 * Chunk markdown-aware di ogni pagina → embedding (batch) → insert dei `doc_chunks`.
 * Ritorna il conteggio dei chunk e il vettore aggregato per pagina (per i related-link).
 */
export async function embedAndStoreChunks<P extends EmbeddablePage>(
  db: DbOrTx,
  embeddingClient: EmbeddingClient,
  input: EmbedAndStoreInput<P>,
): Promise<EmbedAndStoreResult> {
  // 1) Chunk di tutte le pagine, in ordine stabile (pagine → chunk della pagina).
  const all: PageChunk<P>[] = [];
  for (const page of input.pages) {
    const chunks = chunkMarkdown(page.body, {
      targetTokens: CHUNK_TARGET_TOKENS,
      overlap: CHUNK_OVERLAP_WORDS,
    });
    for (const chunk of chunks) {
      all.push({ page, content: chunk.content, heading: chunk.heading, embedding: [] });
    }
  }
  if (all.length === 0) return { chunkCount: 0, pageVectors: new Map() };

  // 2) Embedding in batch di al più `batchSize` input, risultati concatenati in ordine.
  const embeddings: number[][] = [];
  for (const batch of batched(all, Math.max(1, input.batchSize))) {
    const vectors = await embeddingClient.embed(batch.map((c) => c.content));
    embeddings.push(...vectors);
  }
  for (let i = 0; i < all.length; i += 1) {
    (all[i] as PageChunk<P>).embedding = embeddings[i] ?? [];
  }

  // 3) Insert dei chunk allineati 1:1 agli embedding (stesso ordine).
  await db.insert(docChunks).values(
    all.map((c) => ({
      pageId: c.page.id,
      projectId: input.projectId,
      generationId: input.generationId,
      content: c.content,
      embedding: c.embedding,
      metadata: {
        heading: c.heading,
        sourcePath: c.page.sourcePath,
        layer: c.page.kind,
      },
      tokenCount: estimateTokens(c.content),
    })),
  );

  // 4) Vettore aggregato per pagina (media dei chunk): base per i link `related`.
  const byPage = new Map<string, number[][]>();
  for (const c of all) {
    let arr = byPage.get(c.page.id);
    if (!arr) {
      arr = [];
      byPage.set(c.page.id, arr);
    }
    arr.push(c.embedding);
  }
  const pageVectors = new Map<string, number[]>();
  for (const [pageId, vectors] of byPage) pageVectors.set(pageId, meanVector(vectors));

  return { chunkCount: all.length, pageVectors };
}
