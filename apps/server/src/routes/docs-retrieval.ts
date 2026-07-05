/**
 * Retrieval ibrido (semantico + full-text) sui Docs.
 *
 * Due livelli di scope:
 *  - {@link retrieveChunks} — un singolo REPOSITORY e la sua generazione corrente
 *    (`repositories.currentDocGenerationId`) PIÙ le righe manuali
 *    (`generationId IS NULL`);
 *  - {@link retrieveChunksForProject} — CROSS-REPO su tutti i repository di un
 *    PROGETTO, con filtro generazione PER-REPO (Fase 2, D1);
 *  - {@link retrieveChunksAll} — CROSS-REPO GLOBALE su tutti i repository di ogni
 *    progetto, per la ricerca globale senza scope (Task 2).
 *
 * In entrambi i casi i chunk/pagine di generazioni stale NON sono mai restituiti —
 * stesso invariante dell'albero e della pagina singola. Usato dalla ricerca (M6.4)
 * e dalla chat RAG (M6.5): per questo la logica vive qui, fuori dalle route, così
 * tutti i consumatori la importano senza duplicarla.
 */

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { docChunks, docPages, repositories } from "@stubwise/db";
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
  /**
   * Repository d'origine della pagina. Valorizzato sempre — anche nel retrieval
   * per-repo (dove è costante) — così la chat/ricerca cross-repo (Fase 2) può
   * disambiguare la fonte per repository nelle citazioni e nel prompt.
   */
  repositoryId: string;
  repositorySlug: string;
  repositoryName: string;
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
 * Tabella su cui applicare il predicato di scope: `doc_chunks` (gamba semantica)
 * o `doc_pages` (gamba full-text). Entrambe espongono `repositoryId`/`generationId`,
 * quindi lo stesso predicato si costruisce indifferentemente sull'una o sull'altra.
 */
type ScopableTable = typeof docChunks | typeof docPages;

/**
 * Predicato di scope per UN repository: riga del repo AND (generazione corrente
 * OR manuale/`generationId IS NULL`). Quando il repo non ha ancora una
 * generazione corrente restano solo le righe manuali. È una funzione di `table`
 * così la si applica sia a `doc_chunks` (semantico) sia a `doc_pages` (full-text).
 */
function repoScopePredicate(repositoryId: string, currentGenerationId: string | null) {
  return (table: ScopableTable) => {
    const genFilter = currentGenerationId
      ? or(eq(table.generationId, currentGenerationId), isNull(table.generationId))
      : isNull(table.generationId);
    return and(eq(table.repositoryId, repositoryId), genFilter);
  };
}

/** Info di un repository per arricchire le citazioni (id/slug/name della fonte). */
interface RepoInfo {
  id: string;
  slug: string;
  name: string;
  currentDocGenerationId: string | null;
}

/**
 * Predicato di scope CROSS-REPO (Fase 2): OR di coppie, una per repository del
 * progetto — `(repository_id = A AND (generation_id = currentA OR generation_id IS NULL))`
 * OR `(repository_id = B AND (...))` ... Il filtro generazione è PER-REPO (D1):
 * NON si usa un `IN (currentGenIds)` piatto, che mescolerebbe la generazione
 * corrente di un repo con quella stale di un altro. L'indice
 * `doc_chunks (repository_id, generation_id)` copre la forma di ciascuna coppia.
 * I repo senza generazione corrente contribuiscono solo con le righe manuali.
 */
function crossRepoScopePredicate(
  repos: RepoInfo[],
  repositoryFilters?: Record<string, { paths: string[]; slugs: string[] }>,
) {
  return (table: ScopableTable) => {
    const perRepo = repos.map((r) => {
      const genFilter = r.currentDocGenerationId
        ? or(eq(table.generationId, r.currentDocGenerationId), isNull(table.generationId))
        : isNull(table.generationId);
      const base = and(eq(table.repositoryId, r.id), genFilter);
      // Filtro FINE per-repo (paths/slugs). Solo per i repo con entry nel filtro:
      // gli altri restano invariati (passa tutto il repo).
      const filter = repositoryFilters?.[r.id];
      if (!filter) return base;
      return and(base, pageMembershipPredicate(table, r, filter));
    });
    // or(...) con un solo elemento è quel predicato; con più, l'unione cross-repo.
    return perRepo.length === 1 ? perRepo[0] : or(...perRepo);
  };
}

/**
 * Carattere di escape per il `LIKE` dei prefissi path. Con `ESCAPE '\'` i
 * metacaratteri `%`/`_` (e lo stesso `\`) sono trattati LITERAL: un `sourcePath`
 * filtro che contiene `%`/`_` non fa mai wildcard match.
 */
const LIKE_ESCAPE = "\\";

/**
 * Escapa un prefisso path perché sia LITERAL dentro un `LIKE ... ESCAPE '\'`:
 * `\`, `%`, `_` diventano `\\`, `\%`, `\_`. L'ordine conta (prima il backslash).
 */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Predicato di APPARTENENZA di una pagina al filtro fine di UN repo, come
 * `<pageId|id> IN (SELECT id FROM doc_pages WHERE <visibilità> AND (<paths> OR <slugs>))`.
 *
 * La subquery replica ESATTAMENTE la visibilità dello scope corrente del repo
 * (generazione corrente O manuale/`generationId IS NULL`), così le pagine
 * manuali restano raggiungibili come lo sono dallo scope. La colonna della gamba
 * differisce: `doc_chunks.page_id` (semantica) o `doc_pages.id` (full-text) —
 * distinta via `ScopableTable`.
 *
 * FAIL-CLOSED: se paths e slugs sono entrambi vuoti la condizione interna è
 * `sql\`false\``, quindi la subquery è vuota e NESSUNA pagina del repo passa.
 */
function pageMembershipPredicate(
  table: ScopableTable,
  repo: RepoInfo,
  filter: { paths: string[]; slugs: string[] },
) {
  // Visibilità della pagina identica allo scope del repo (stessa generazione
  // corrente O manuale): RIUSA repoScopePredicate su doc_pages invece di
  // replicare la condizione — identica per costruzione, un solo punto di verità.
  const visibility = repoScopePredicate(repo.id, repo.currentDocGenerationId)(docPages);

  // Match sui prefissi path: esatto (`source_path = p`) O sotto la directory
  // (`source_path LIKE p_escaped || '/%' ESCAPE '\'`), col confine `/`.
  const pathClauses = filter.paths.map((p) => {
    const escaped = escapeLikePrefix(p);
    return or(
      eq(docPages.sourcePath, p),
      sql`${docPages.sourcePath} LIKE ${`${escaped}/%`} ESCAPE ${LIKE_ESCAPE}`,
    );
  });
  // Match sugli slug espliciti (pagine senza path / manuali).
  const slugClause = filter.slugs.length > 0 ? inArray(docPages.slug, filter.slugs) : undefined;

  const selectors = [...pathClauses, ...(slugClause ? [slugClause] : [])];
  // Nessun selettore (paths+slugs vuoti) → fail-closed: nessuna pagina passa.
  const membership = selectors.length > 0 ? or(...selectors) : sql`false`;

  // `visibility` include già `repository_id = repo.id`: la subquery è le pagine
  // del repo, nello scope corrente, che soddisfano il filtro fine.
  const subquery = sql`(SELECT ${docPages.id} FROM ${docPages} WHERE ${and(
    visibility,
    membership,
  )})`;

  // La colonna della gamba: page_id sui chunk, id sulle pagine.
  const column = table === docChunks ? docChunks.pageId : docPages.id;
  return inArray(column, subquery);
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
  /**
   * Whitelist di repository su cui restringere il retrieval cross-repo di
   * PROGETTO (usata dal widget di assistenza: solo i repo esposti al pubblico).
   * Quando presente, dalla lista dei repo del progetto si tengono SOLO quelli il
   * cui id compare qui — per INTERSEZIONE, così id stale (repo cancellati o non
   * più nel progetto) sono tollerati naturalmente senza dover esistere. Lista
   * vuota → nessun repo → retrieval vuoto. Assente → nessun filtro (tutti i repo
   * del progetto), comportamento invariato per gli altri chiamanti.
   */
  repositoryIds?: string[];
  /**
   * Filtro FINE per-repo (widget path filter): per ogni `repositoryId` una
   * whitelist di prefissi `sourcePath` (`paths`) e/o `slugs` espliciti. Solo le
   * pagine il cui `sourcePath` combacia con un prefisso (match esatto O sotto la
   * directory, confine `/`) OPPURE il cui `slug` è elencato passano da quel repo.
   *
   * Semantica per repository della whitelist (`repositoryIds`):
   *  - repo CON entry e paths/slugs non entrambi vuoti: filtrato;
   *  - repo CON entry ma paths+slugs vuoti: FAIL-CLOSED, niente da quel repo;
   *  - repo SENZA entry: nessun filtro fine, passa tutto (come oggi).
   *
   * I prefissi sono trattati come LITERAL nel `LIKE` (escape di `\`, `%`, `_`):
   * un path con `%`/`_` non fa mai wildcard match. Assente: nessun filtro fine
   * (identico al comportamento odierno), usato solo dal widget di assistenza.
   */
  repositoryFilters?: Record<string, { paths: string[]; slugs: string[] }>;
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
  repositoryId: string,
  query: string,
  options: RetrieveChunksOptions = {},
): Promise<RetrievedChunk[]> {
  // Generazione corrente + info del repository: definiscono lo scope (entrambe le
  // gambe) e arricchiscono le citazioni col repository d'origine.
  const [repository] = await db
    .select({
      id: repositories.id,
      slug: repositories.slug,
      name: repositories.name,
      currentDocGenerationId: repositories.currentDocGenerationId,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  if (!repository) return [];

  return retrieveWithScope(db, embeddingClient, query, {
    k: options.k ?? 10,
    logger: options.logger,
    scope: repoScopePredicate(repository.id, repository.currentDocGenerationId),
    logContext: { repositoryId },
  });
}

/**
 * Numero massimo di repository documentati oltre i quali `k` non cresce più, e
 * passo di crescita per repo aggiuntivo. `k = min(8 + 4*(nRepoDocumentati-1), 24)`
 * (D6): un solo repo → 8 (come la chat per-repo); cresce per non perdere copertura
 * sui progetti con molti repo, ma con un tetto per non gonfiare il contesto LLM.
 */
const PROJECT_K_BASE = 8;
const PROJECT_K_STEP = 4;
const PROJECT_K_MAX = 24;

/**
 * Retrieval ibrido CROSS-REPO a livello di PROGETTO (Fase 2).
 *
 * Aggrega i Docs di TUTTI i repository del progetto in un'unica ricerca, con lo
 * stesso ranking della versione per-repo. Lo scope applica il filtro generazione
 * PER-REPO (D1): per ogni repo, la sua generazione corrente OPPURE le righe
 * manuali — costruito come OR di coppie (vedi {@link crossRepoScopePredicate}),
 * NON come un `IN` piatto che mescolerebbe generazioni stale tra repo.
 *
 * Ogni `RetrievedChunk` è arricchito con `repositoryId/slug/name` della pagina di
 * origine, così la chat di progetto può citare il repository di ciascuna fonte.
 *
 * `k` (se non passato esplicitamente) è proporzionale al numero di repo
 * DOCUMENTATI (D6): `min(8 + 4*(nRepoDocumentati-1), 24)`.
 *
 * Se il progetto non ha repository, o nessuno con documentazione (generazione
 * corrente o pagine manuali), ritorna `[]`.
 */
export async function retrieveChunksForProject(
  db: Db,
  embeddingClient: EmbeddingClient,
  projectId: string,
  query: string,
  options: RetrieveChunksOptions = {},
): Promise<RetrievedChunk[]> {
  // Tutti i repo del progetto, con la rispettiva generazione corrente.
  const allRepos = await db
    .select({
      id: repositories.id,
      slug: repositories.slug,
      name: repositories.name,
      currentDocGenerationId: repositories.currentDocGenerationId,
    })
    .from(repositories)
    .where(eq(repositories.projectId, projectId));

  // Whitelist opzionale (widget): intersezione con i repo del progetto. Gli id
  // nella whitelist possono essere STALE (repo cancellato/spostato): l'intersezione
  // li scarta senza assumere che esistano. Assente → tutti i repo del progetto.
  const repos = options.repositoryIds
    ? allRepos.filter((r) => options.repositoryIds!.includes(r.id))
    : allRepos;

  // Nessun repo (progetto vuoto o whitelist che non interseca nulla) → niente da
  // recuperare.
  if (repos.length === 0) return [];

  // `k` proporzionale al numero di repo DOCUMENTATI: hanno una generazione
  // corrente (o quantomeno possono avere righe manuali). Per il dimensionamento
  // di k contiamo i repo con generazione corrente; il minimo è 1 per non far
  // collassare k quando solo le pagine manuali sono presenti.
  const documentedCount = Math.max(
    1,
    repos.filter((r) => r.currentDocGenerationId !== null).length,
  );
  const k =
    options.k ??
    Math.min(PROJECT_K_BASE + PROJECT_K_STEP * (documentedCount - 1), PROJECT_K_MAX);

  return retrieveWithScope(db, embeddingClient, query, {
    k,
    logger: options.logger,
    scope: crossRepoScopePredicate(repos, options.repositoryFilters),
    logContext: { projectId },
  });
}

/**
 * Retrieval ibrido CROSS-REPO GLOBALE (Task 2): come {@link retrieveChunksForProject}
 * ma sui repository di TUTTI i progetti — nessun filtro `projectId`. Serve la
 * corsia LENTA della ricerca globale (spotlight Cmd/K senza scope di repository):
 * il retrieval semantico federato su tutto il corpus Docs.
 *
 * Riusa lo stesso {@link crossRepoScopePredicate} (OR-di-coppie per-repo, filtro
 * generazione corrente PER-REPO, righe manuali) e lo stesso cuore condiviso
 * {@link retrieveWithScope} (due gambe, dedup, merge/rank, resilienza embedding).
 *
 * `k` è dimensionato sul numero di repo DOCUMENTATI come per il progetto (D6),
 * salvo override esplicito. Se non esiste alcun repository documentato (nessuna
 * generazione corrente né pagina manuale) ritorna `[]`.
 */
export async function retrieveChunksAll(
  db: Db,
  embeddingClient: EmbeddingClient,
  query: string,
  options: RetrieveChunksOptions = {},
): Promise<RetrievedChunk[]> {
  // TUTTI i repository (di ogni progetto), con la rispettiva generazione corrente.
  const repos = await db
    .select({
      id: repositories.id,
      slug: repositories.slug,
      name: repositories.name,
      currentDocGenerationId: repositories.currentDocGenerationId,
    })
    .from(repositories);

  // Nessun repository → niente da recuperare.
  if (repos.length === 0) return [];

  // Stesso dimensionamento di k del progetto: proporzionale ai repo documentati.
  const documentedCount = Math.max(
    1,
    repos.filter((r) => r.currentDocGenerationId !== null).length,
  );
  const k =
    options.k ??
    Math.min(PROJECT_K_BASE + PROJECT_K_STEP * (documentedCount - 1), PROJECT_K_MAX);

  return retrieveWithScope(db, embeddingClient, query, {
    k,
    logger: options.logger,
    scope: crossRepoScopePredicate(repos),
    logContext: { scope: "global" },
  });
}

/** Predicato di scope applicabile a `doc_chunks` o `doc_pages`. */
type ScopePredicate = (table: ScopableTable) => ReturnType<typeof and>;

interface RetrieveWithScopeArgs {
  k: number;
  logger?: RetrievalLogger;
  /** Predicato di scope (repo singolo o cross-repo), applicato a entrambe le gambe. */
  scope: ScopePredicate;
  /** Contesto per i log del fallback semantico (repositoryId o projectId). */
  logContext: Record<string, string>;
}

/**
 * Cuore condiviso del retrieval ibrido, parametrizzato dal `scope` (per-repo o
 * cross-repo) e dalla lista `repos` per l'arricchimento. Le due gambe (semantica
 * + full-text), il dedup per pagina, il merge/rank e la resilienza all'embedding
 * KO sono identici per entrambi i chiamanti: vivono qui, una sola volta.
 *
 * Le query joinano `doc_pages` → `repositories` per portare `repositoryId/slug/name`
 * della pagina d'origine in ogni `RetrievedChunk` (uniforme per-repo e cross-repo).
 */
async function retrieveWithScope(
  db: Db,
  embeddingClient: EmbeddingClient,
  query: string,
  args: RetrieveWithScopeArgs,
): Promise<RetrievedChunk[]> {
  const { k, logger, scope, logContext } = args;

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
        repositoryId: repositories.id,
        repositorySlug: repositories.slug,
        repositoryName: repositories.name,
        content: docChunks.content,
        distance: sql<number>`(${docChunks.embedding} <=> ${queryLiteral}::vector)`,
      })
      .from(docChunks)
      .innerJoin(docPages, eq(docChunks.pageId, docPages.id))
      .innerJoin(repositories, eq(docPages.repositoryId, repositories.id))
      .where(and(scope(docChunks), sql`${docChunks.embedding} IS NOT NULL`))
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
        repositoryId: row.repositoryId,
        repositorySlug: row.repositorySlug,
        repositoryName: row.repositoryName,
      });
    }
  } catch (error) {
    // Fallback: niente semantico, prosegue il solo full-text sotto.
    const log = logger ?? console;
    log.warn(
      { err: error, ...logContext },
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
      repositoryId: repositories.id,
      repositorySlug: repositories.slug,
      repositoryName: repositories.name,
      rank: sql<number>`ts_rank_cd(${docPages.searchTsv}, ${tsq}, 32)`,
      snippet: sql<string>`ts_headline('english', ${docPages.body}, ${tsq}, 'MaxFragments=1,MaxWords=40,MinWords=15')`,
    })
    .from(docPages)
    .innerJoin(repositories, eq(docPages.repositoryId, repositories.id))
    .where(and(scope(docPages), sql`${docPages.searchTsv} @@ ${tsq}`))
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
      repositoryId: row.repositoryId,
      repositorySlug: row.repositorySlug,
      repositoryName: row.repositoryName,
    });
  }

  // Rank finale: score discendente (semantici e hybrid in cima per costruzione),
  // troncato a k pagine.
  return [...byPage.values()].sort((a, b) => b.score - a.score).slice(0, k);
}
