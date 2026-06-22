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
 * `score` è in [0, 1]: 1 = match perfetto. I match semantici sono mappati nella
 * fascia ALTA [0.5, 1] (`0.5 + 0.5 * (1 - distanza)`), i match solo-full-text
 * nella fascia BASSA [0, 0.5): così un match semantico — anche mediocre —
 * supera SEMPRE un match solo-full-text, qualunque sia il suo `ts_rank_cd`.
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

/** Logger minimale (sottoinsieme di pino/`request.log`) per i warning del retrieval. */
export interface RetrievalLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface RetrieveChunksOptions {
  /** Numero massimo di pagine restituite (default 10). */
  k?: number;
  /**
   * Logger per i warning (es. `request.log` di Fastify). Se assente si usa
   * `console.warn`. Serve a tracciare il fallback full-text quando l'embedding
   * non è disponibile (Ollama down/timeout/non-200).
   */
  logger?: RetrievalLogger;
}

/**
 * Fattore di over-fetch dei chunk prima del dedup per pagina. La query semantica
 * tronca a `LIMIT k` CHUNK, ma più chunk possono appartenere alla STESSA pagina:
 * dopo il dedup resterebbero < k pagine distinte, scartando pagine genuinamente
 * rilevanti appena fuori dalla finestra dei chunk. Pescando `k * FACTOR` chunk
 * (con un minimo di `MIN_OVERFETCH`) abbiamo abbastanza chunk per ricavare k
 * pagine distinte anche se una pagina ne monopolizza diversi in cima.
 *
 * Index-friendly: l'indice HNSW di pgvector ha `ef_search` default ~40, quindi
 * un fetch di ~40 righe è gratis (non costringe a scansioni esaustive). Teniamo
 * il floor a 40 proprio per restare nel budget `ef_search` di default.
 */
const CHUNK_OVERFETCH_FACTOR = 5;
const MIN_CHUNK_OVERFETCH = 40;

/**
 * Retrieval ibrido per `query` nel progetto `projectId`.
 *
 * 1. **Semantico**: embed della query (via `embeddingClient`) → over-fetch dei
 *    chunk per distanza coseno ascendente (`embedding <=> $queryVec`), scopati a
 *    progetto + generazione corrente/manuali, poi dedup a `k` PAGINE distinte.
 *    Lo score è `0.5 + 0.5 * (1 - distanza)` ∈ [0.5, 1].
 * 2. **Full-text**: `websearch_to_tsquery` su `doc_pages.search_tsv`, stesso
 *    scope, per catturare termini/nomi esatti che l'embedding può mancare.
 *
 * **Resilienza**: se l'embedding fallisce (Ollama down/timeout/non-200) la gamba
 * semantica è saltata con un warning e si restituiscono i SOLI risultati
 * full-text — la ricerca non va in 500 per i query a token esatto, e la chat RAG
 * (M6.5) resta servibile. Il full-text gira comunque.
 *
 * **Merge/rank**: dedup per pagina (una pagina può matchare entrambi). Una
 * pagina trovata da entrambe le sorgenti diventa `hybrid` e tiene lo score
 * semantico (sempre il più informativo). I match solo-full-text vengono dopo
 * tutti i semantici: il loro score è mappato nella fascia bassa [0, 0.5) così
 * un match esatto-ma-non-semantico non scavalca mai un match semantico.
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
  const logger = options.logger;

  // Generazione corrente del progetto: definisce lo scope di entrambe le query.
  const [project] = await db
    .select({ currentDocGenerationId: projects.currentDocGenerationId })
    .from(projects)
    .where(eq(projects.id, projectId));
  const currentGenerationId = project?.currentDocGenerationId ?? null;

  // --- 1) Retrieval semantico ------------------------------------------------
  // Tutta la gamba semantica (embed + query coseno) è racchiusa in try/catch:
  // se l'embedding non è disponibile (Ollama down/timeout/non-200) NON facciamo
  // fallire la ricerca — logghiamo un warning e proseguiamo con i SOLI risultati
  // full-text. Questo serve la ricerca a token esatto e rende resiliente la chat.
  const byPage = new Map<string, RetrievedChunk>();
  try {
    const [queryVector] = await embeddingClient.embed([query]);
    if (!queryVector) {
      throw new Error("embeddingClient ha restituito 0 vettori per la query");
    }
    const queryLiteral = toVectorLiteral(queryVector);

    // Over-fetch dei chunk: peschiamo k * FACTOR (min 40) chunk per garantire k
    // pagine distinte dopo il dedup, anche quando una pagina possiede più chunk
    // tra i top. Il floor 40 sta nel budget `ef_search` di default di HNSW.
    const chunkLimit = Math.max(k * CHUNK_OVERFETCH_FACTOR, MIN_CHUNK_OVERFETCH);

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
      .limit(chunkLimit);

    // Dedup per pagina tenendo il chunk più vicino (la query è già ordinata per
    // distanza ascendente, quindi il primo che vediamo per pagina è il migliore).
    // Ci fermiamo a k pagine distinte: l'over-fetch garantisce che le pagine a
    // singolo chunk appena fuori finestra non siano scavalcate da una pagina che
    // monopolizza più chunk in cima.
    for (const row of semanticRows) {
      if (byPage.size >= k) break;
      if (byPage.has(row.pageId)) continue;
      // Distanza coseno pgvector ∈ [0, 2]; clamp 1 - distanza a [0, 1], poi
      // mappa nella fascia alta [0.5, 1] così ogni match semantico supera i
      // match solo-full-text (fascia [0, 0.5)). Match perfetto (dist 0) → 1.0.
      const similarity = Math.max(0, Math.min(1, 1 - row.distance));
      const score = 0.5 + 0.5 * similarity;
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
  } catch (error) {
    // Fallback: niente semantico, prosegue il solo full-text sotto.
    const log = logger ?? console;
    log.warn(
      { err: error, projectId },
      "retrieval semantico non disponibile (embedding fallito); fallback full-text-only",
    );
  }

  // --- 2) Retrieval full-text ------------------------------------------------
  // websearch_to_tsquery tollera input utente arbitrario senza errori di
  // sintassi (niente escaping). ts_rank_cd normalizzato (flag 32: rank/(rank+1))
  // ∈ [0, 1); lo comprimiamo nella fascia [0, 0.5) per restare sotto i match
  // semantici. Lo snippet è un estratto del corpo via ts_headline.
  //
  // NOTA i18n: la config testuale è `'english'` per convenzione di progetto
  // (condivisa con la tabella `tickets`). Il corpus Docs è però MULTILINGUE
  // (es. pagine in italiano): lo stemming/stop-word inglese è una limitazione
  // nota — da rivedere in un futuro pass i18n con una config per-lingua. Qui NON
  // la cambiamo per non divergere dal resto del progetto.
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
