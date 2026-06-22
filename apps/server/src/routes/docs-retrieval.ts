/**
 * Retrieval ibrido (semantico + full-text) sui Docs di un progetto.
 *
 * Usato dalla ricerca (M6.4) e dalla chat RAG (M6.5): per questo la logica vive
 * qui, fuori dalle route, così entrambe la importano senza duplicarla.
 *
 * Scope: SEMPRE limitato al progetto e alla sua generazione corrente
 * (`projects.currentDocGenerationId`) PIÙ i chunk/pagine manuali
 * (`generationId IS NULL`). I chunk/pagine di generazioni stale NON sono mai
 * restituiti — stesso invariante dell'albero e della pagina singola.
 */

import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { docChunks, docPages, projects } from "@stubwise/db";
import type { Db } from "@stubwise/db";

/**
 * Risultato del retrieval per una pagina. `snippet` è il contenuto del chunk più
 * rilevante (semantico) o un estratto del corpo (match solo full-text).
 * `score` è in [0, 1]: 1 = match perfetto. Per i match semantici deriva dalla
 * distanza coseno (1 - distanza); per i match solo-full-text usiamo
 * `ts_rank_cd` normalizzato sotto la soglia semantica, così i match semantici
 * restano sempre prima.
 */
export interface RetrievedChunk {
  pageId: string;
  slug: string;
  title: string;
  kind: typeof docPages.$inferSelect.kind;
  /** Estratto rilevante: contenuto del chunk (semantico) o del corpo (full-text). */
  snippet: string;
  /** Punteggio di rilevanza in [0, 1] (più alto = più rilevante). */
  score: number;
  /** Sorgente del match: "semantic" (pgvector), "fulltext" (tsvector) o entrambi. */
  source: "semantic" | "fulltext" | "hybrid";
}

/**
 * Formatta un vettore di embedding come literal pgvector (`[a,b,c]`). Il valore
 * è sempre passato come parametro (mai interpolato nella stringa SQL), quindi è
 * injection-safe: vedi l'uso con `${...}::vector` nelle query sotto.
 */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Predicato di scope condiviso da semantico e full-text: riga del progetto AND
 * (generazione corrente OR manuale/`generationId IS NULL`). Quando il progetto
 * non ha ancora una generazione corrente restano solo le righe manuali.
 */
function scopeFilter(
  table: typeof docChunks | typeof docPages,
  projectId: string,
  currentGenerationId: string | null,
) {
  const genFilter = currentGenerationId
    ? or(eq(table.generationId, currentGenerationId), isNull(table.generationId))
    : isNull(table.generationId);
  return and(eq(table.projectId, projectId), genFilter);
}

export interface RetrieveChunksOptions {
  /** Numero massimo di pagine restituite (default 10). */
  k?: number;
}

/**
 * Retrieval ibrido per `query` nel progetto `projectId`.
 *
 * 1. **Semantico**: embed della query (via `embeddingClient`) → i top-K chunk
 *    per distanza coseno ascendente (`embedding <=> $queryVec`), scopati a
 *    progetto + generazione corrente/manuali. Lo score = `1 - distanza`.
 * 2. **Full-text**: `websearch_to_tsquery` su `doc_pages.search_tsv`, stesso
 *    scope, per catturare termini/nomi esatti che l'embedding può mancare.
 *
 * **Merge/rank**: dedup per pagina (una pagina può matchare entrambi). Una
 * pagina trovata da entrambe le sorgenti diventa `hybrid` e tiene lo score
 * semantico (sempre il più informativo). I match solo-full-text vengono dopo
 * tutti i semantici: il loro score è mappato nella fascia bassa [0, 0.5) così
 * un match esatto-ma-non-semantico non scavalca mai un buon match semantico.
 * Ordinamento finale: score discendente. Tronca a `k` pagine.
 *
 * Riusabile dalla chat RAG (M6.5): stesso scope, stesso ranking.
 */
export async function retrieveChunks(
  db: Db,
  embeddingClient: EmbeddingClient,
  projectId: string,
  query: string,
  options: RetrieveChunksOptions = {},
): Promise<RetrievedChunk[]> {
  const k = options.k ?? 10;

  // Generazione corrente del progetto: definisce lo scope di entrambe le query.
  const [project] = await db
    .select({ currentDocGenerationId: projects.currentDocGenerationId })
    .from(projects)
    .where(eq(projects.id, projectId));
  const currentGenerationId = project?.currentDocGenerationId ?? null;

  // --- 1) Retrieval semantico ------------------------------------------------
  const [queryVector] = await embeddingClient.embed([query]);
  if (!queryVector) {
    throw new Error("embeddingClient ha restituito 0 vettori per la query");
  }
  const queryLiteral = toVectorLiteral(queryVector);

  // `embedding <=> $vec`: distanza coseno pgvector. Il vettore è parametrizzato
  // (`${queryLiteral}::vector`), mai interpolato: injection-safe. Le righe senza
  // embedding (NULL) sono escluse: <=> su NULL non ordina utilmente.
  const semanticRows = await db
    .select({
      pageId: docPages.id,
      slug: docPages.slug,
      title: docPages.title,
      kind: docPages.kind,
      content: docChunks.content,
      distance: sql<number>`(${docChunks.embedding} <=> ${queryLiteral}::vector)`,
    })
    .from(docChunks)
    .innerJoin(docPages, eq(docChunks.pageId, docPages.id))
    .where(
      and(
        scopeFilter(docChunks, projectId, currentGenerationId),
        sql`${docChunks.embedding} IS NOT NULL`,
      ),
    )
    .orderBy(sql`${docChunks.embedding} <=> ${queryLiteral}::vector`)
    .limit(k);

  // Dedup per pagina tenendo il chunk più vicino (la query è già ordinata per
  // distanza ascendente, quindi il primo che vediamo per pagina è il migliore).
  const byPage = new Map<string, RetrievedChunk>();
  for (const row of semanticRows) {
    if (byPage.has(row.pageId)) continue;
    // Distanza coseno pgvector ∈ [0, 2]; clamp a [0, 1] per uno score leggibile.
    const score = Math.max(0, Math.min(1, 1 - row.distance));
    byPage.set(row.pageId, {
      pageId: row.pageId,
      slug: row.slug,
      title: row.title,
      kind: row.kind,
      snippet: row.content,
      score,
      source: "semantic",
    });
  }

  // --- 2) Retrieval full-text ------------------------------------------------
  // websearch_to_tsquery tollera input utente arbitrario senza errori di
  // sintassi (niente escaping). ts_rank_cd normalizzato (flag 32: rank/(rank+1))
  // ∈ [0, 1); lo comprimiamo nella fascia [0, 0.5) per restare sotto i match
  // semantici. Lo snippet è un estratto del corpo via ts_headline.
  const tsq = sql`websearch_to_tsquery('english', ${query})`;
  const fullTextRows = await db
    .select({
      pageId: docPages.id,
      slug: docPages.slug,
      title: docPages.title,
      kind: docPages.kind,
      rank: sql<number>`ts_rank_cd(${docPages.searchTsv}, ${tsq}, 32)`,
      snippet: sql<string>`ts_headline('english', ${docPages.body}, ${tsq}, 'MaxFragments=1,MaxWords=40,MinWords=15')`,
    })
    .from(docPages)
    .where(and(scopeFilter(docPages, projectId, currentGenerationId), sql`${docPages.searchTsv} @@ ${tsq}`))
    .orderBy(sql`ts_rank_cd(${docPages.searchTsv}, ${tsq}, 32) DESC`)
    .limit(k);

  for (const row of fullTextRows) {
    const existing = byPage.get(row.pageId);
    if (existing) {
      // Già trovata dal semantico: diventa "hybrid", tiene lo score semantico.
      existing.source = "hybrid";
      continue;
    }
    // Match solo-full-text: score nella fascia [0, 0.5), sempre dopo i semantici.
    byPage.set(row.pageId, {
      pageId: row.pageId,
      slug: row.slug,
      title: row.title,
      kind: row.kind,
      snippet: row.snippet,
      score: row.rank * 0.5,
      source: "fulltext",
    });
  }

  // Rank finale: score discendente (semantici e hybrid in cima per costruzione),
  // troncato a k pagine.
  return [...byPage.values()].sort((a, b) => b.score - a.score).slice(0, k);
}
