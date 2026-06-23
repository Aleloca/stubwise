import {
  docGenerationJobs,
  docNodes,
  docPages,
  docGenerations,
  projects,
  type Db,
} from "@stubwise/db";
import {
  resolveImplementsLinks,
  selectRelatedLinks,
  slugForNode,
  type LinkableNode,
  type NodeLink,
} from "@stubwise/docs-engine";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { and, eq, isNull, sql } from "drizzle-orm";
import { EMBED_BATCH_SIZE, embedAndStoreChunks } from "../embed.js";
import { pruneOldGenerations } from "../pipeline.js";
import { completeDocJob, failDocJob } from "../queue.js";
import type { DocNode } from "../nodes.js";

/**
 * FINALIZZAZIONE del motore documentazione ricorsivo (M6).
 *
 * Invocata quando l'ULTIMA radice di una generazione raggiunge `done` (la rilevazione
 * vera è cablata nel join/dispatch dalla M7; qui esponiamo `finalizeGeneration` come
 * funzione self-contained + l'helper `allRootsDone`). Trasforma il DAG di `doc_nodes`
 * `done` nell'output consumabile — `doc_pages` annidate + `doc_chunks` con embedding —
 * risolve i cross-link e fa lo SWAP del puntatore corrente, esattamente come la pipeline
 * map-reduce ma a partire dai nodi.
 *
 * FLUSSO (best-effort, transazioni per atomicità come pipeline.ts):
 *  1. CROSS-LINK implements: `resolveImplementsLinks` su tutti i nodi `done` → mappa
 *     nodeId → link `implements`/`implemented_by` (ancorati ai path, bidirezionali).
 *  2. PROIEZIONE doc_nodes → doc_pages: per ogni nodo `done` una pagina (kind=tree,
 *     slug/title/body, sourcePath = primo source_path, links = gli implements). I
 *     `parentId` dei nodi sono risolti a `parentId` delle pagine in DUE passaggi
 *     (inserisci tutte le pagine raccogliendo nodeId→pageId, poi UPDATE dei parent).
 *     I nodi `failed` sono SALTATI (loggati): un ramo fallito non blocca il resto.
 *  3. CHUNK + EMBED: `embedAndStoreChunks` (riuso ESATTO della pipeline) → doc_chunks.
 *     Ritorna anche il vettore per pagina (media dei chunk) per i related-link.
 *  4. RELATED (semantico, IN-MEMORY): per ogni pagina, `selectRelatedLinks` sui vettori
 *     di pagina già calcolati (cosine), escludendo self/padre/figli/già-linkate; i link
 *     `related` sono APPESI a doc_pages.links.
 *  5. SWAP + PRUNE + CLOSE: `projects.currentDocGenerationId = generationId`,
 *     generazione `succeeded` con stats + costo aggregato dai nodi, prune (corrente +
 *     precedente), trigger doc-job `succeeded`. Su QUALSIASI errore mid-finalize:
 *     generazione `failed`, NESSUNO swap.
 *
 * Step 1–4 (links + proiezione + embed + related) girano in UNA transazione: un throw a
 * metà fa rollback a ZERO pagine/chunk (niente output orfano sotto un `failed`), come la
 * pipeline esistente. Lo swap/prune/close avvengono FUORI dalla transazione, solo su
 * successo.
 *
 * IL WORKTREE NON VIENE CHIUSO QUI. La M7 (dispatch) possiede l'handle del worktree di
 * generazione e lo chiude DOPO il ritorno di `finalizeGeneration` (la finalizzazione fa
 * solo la finalizzazione DB + swap; il worktree è già inutile a questo punto perché tutti
 * i nodi sono `done`/`failed` e nessun job-nodo lo legge più).
 */

/** Drizzle DB o una sua transazione (stessa interfaccia di query). */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Numero massimo di link `related` per pagina. */
const RELATED_K = 3;

/** I `sourcePaths` di un nodo (colonna jsonb, tipata `unknown` da drizzle). */
function nodeSourcePaths(node: DocNode): string[] {
  return (node.sourcePaths as string[] | null) ?? [];
}

/**
 * Ritorna i nodi con gli slug RESI univoci nell'insieme (necessario per
 * `(generation_id, slug)` UNIQUE di doc_pages). Ordina deterministicamente per
 * (depth, position, id) e, per ogni slug già visto, ricava un suffisso via
 * `slugForNode` (che dedup su un set condiviso). Uno slug già unico resta invariato.
 * Lavora su una COPIA degli oggetti nodo (non muta gli originali del DB).
 */
function dedupeNodeSlugs(nodes: DocNode[]): DocNode[] {
  const ordered = [...nodes].sort(
    (a, b) => a.depth - b.depth || a.position - b.position || a.id.localeCompare(b.id),
  );
  const used = new Set<string>();
  return ordered.map((n) => {
    if (n.slug.length > 0 && !used.has(n.slug)) {
      used.add(n.slug);
      return n;
    }
    // Slug vuoto o già preso: ne ricavo uno univoco dal titolo (o dallo slug stesso).
    const base = n.title.length > 0 ? n.title : n.slug || n.id;
    return { ...n, slug: slugForNode(base, used) };
  });
}

export interface FinalizeGenerationDeps {
  db: Db;
  embeddingClient: EmbeddingClient;
  /** Override del tetto di input per chiamata `embed()` (default `EMBED_BATCH_SIZE`). Test. */
  embedBatchSize?: number;
}

export type FinalizeOutcome = "succeeded" | "failed";

/** Statistiche della generazione del DAG salvate in `doc_generations.stats` (jsonb). */
interface DagGenerationStats {
  /** Nodi totali della generazione. */
  nodes: number;
  /** Nodi proiettati in pagine (status `done`). */
  doneNodes: number;
  /** Nodi `failed` (saltati dalla proiezione). */
  failedNodes: number;
  /** Profondità massima raggiunta dal DAG. */
  maxDepth: number;
  /** Pagine proiettate. */
  pages: number;
  /** Chunk con embedding inseriti. */
  chunks: number;
}

/**
 * true se TUTTE le radici (`parentId IS NULL`) della generazione sono in stato `done`.
 * È il segnale di finalizzazione: il join porta una radice a `done` solo quando tutti i
 * suoi discendenti sono chiusi, quindi "tutte le radici done" ⇒ "l'intero DAG è chiuso".
 * False se non esiste alcuna radice (generazione mai seminata): non c'è nulla da
 * finalizzare. Una radice `failed` NON conta come `done`: in quel caso il DAG resta non
 * finalizzabile via questo gate (caso degenere gestito a monte).
 */
export async function allRootsDone(db: DbOrTx, generationId: string): Promise<boolean> {
  const roots = await db
    .select({ status: docNodes.status })
    .from(docNodes)
    .where(and(eq(docNodes.generationId, generationId), isNull(docNodes.parentId)));
  if (roots.length === 0) return false;
  return roots.every((r) => r.status === "done");
}

/** Una pagina proiettata con il suo id e i campi necessari all'embedding/related. */
interface ProjectedPage {
  id: string;
  nodeId: string;
  parentNodeId: string | null;
  slug: string;
  body: string;
  kind: DocNode["tree"];
  sourcePath: string | null;
}

/**
 * Proietta i nodi `done` in `doc_pages` (due passaggi sui parent) e scrive i link
 * `implements` su ciascuna pagina. Ritorna le pagine proiettate (con nodeId/parentNodeId
 * per i passi successivi). Tutto dentro il `tx` passato (atomicità delegata al chiamante).
 */
async function projectPages(
  tx: DbOrTx,
  projectId: string,
  generationId: string,
  doneNodes: DocNode[],
  implementsLinks: Map<string, NodeLink[]>,
): Promise<ProjectedPage[]> {
  // Passo 1: insert delle pagine (parentId null per ora), nodeId → pageId.
  const nodeToPage = new Map<string, string>();
  const projected: ProjectedPage[] = [];
  let position = 0;
  for (const node of doneNodes) {
    const sourcePath = nodeSourcePaths(node)[0] ?? null;
    const links = implementsLinks.get(node.id) ?? [];
    const [stored] = await tx
      .insert(docPages)
      .values({
        projectId,
        generationId,
        kind: node.tree,
        slug: node.slug,
        title: node.title,
        parentId: null,
        position,
        sourcePath,
        body: node.body,
        links: links.length > 0 ? links : null,
      })
      .returning({ id: docPages.id });
    if (!stored) throw new Error(`insert della pagina del nodo '${node.id}' non ha restituito la riga`);
    nodeToPage.set(node.id, stored.id);
    projected.push({
      id: stored.id,
      nodeId: node.id,
      parentNodeId: node.parentId,
      slug: node.slug,
      body: node.body,
      kind: node.tree,
      sourcePath,
    });
    position += 1;
  }

  // Passo 2: risoluzione dei parent (nodeId padre → pageId padre). Un parent saltato
  // (es. nodo padre `failed`, non proiettato) resta null: la pagina diventa una radice
  // dell'albero (difesa anti-orfano, non dovrebbe accadere se il padre è `done`).
  for (const page of projected) {
    if (!page.parentNodeId) continue;
    const parentPageId = nodeToPage.get(page.parentNodeId);
    if (!parentPageId) continue;
    await tx.update(docPages).set({ parentId: parentPageId }).where(eq(docPages.id, page.id));
  }

  return projected;
}

/**
 * Finalizza la generazione `generationId`: proietta i nodi `done` in pagine annidate,
 * embedda i chunk, risolve i cross-link (implements + related), fa lo swap del puntatore
 * corrente, prune e chiude il trigger. Chiude SEMPRE il trigger qui (success/fail). NON
 * chiude il worktree (lo possiede la M7). Best-effort: su errore mid-finalize la
 * generazione è `failed` e NON si fa lo swap. Ritorna l'esito.
 */
export async function finalizeGeneration(
  deps: FinalizeGenerationDeps,
  generationId: string,
): Promise<FinalizeOutcome> {
  const { db, embeddingClient } = deps;

  // La generazione + il progetto (per projectId e per chiudere il trigger).
  const [generation] = await db
    .select()
    .from(docGenerations)
    .where(eq(docGenerations.id, generationId));
  if (!generation) return "failed";
  const projectId = generation.projectId;

  // Il trigger doc-job ancora `running` collegato a questa generazione (lasciato dalla M5a).
  const [trigger] = await db
    .select({ id: docGenerationJobs.id })
    .from(docGenerationJobs)
    .where(
      and(
        eq(docGenerationJobs.generationId, generationId),
        eq(docGenerationJobs.status, "running"),
      ),
    );

  // Tutti i nodi della generazione (per stats, cross-link, proiezione).
  const allNodes = await db.select().from(docNodes).where(eq(docNodes.generationId, generationId));
  const failedNodes = allNodes.filter((n) => n.status === "failed");

  // SLUG UNIVOCI per la proiezione: doc_pages ha `(generation_id, slug)` UNIQUE. Gli
  // slug dei nodi sono già pensati per essere univoci (orientamento + createChildren),
  // ma due explore CONCORRENTI di nodi-fratelli con lo stesso titolo possono produrre
  // lo stesso slug (le loro transazioni non condividono un lock). Qui — punto unico che
  // possiede l'invariante doc_pages — RI-UNIFICO gli slug in ordine deterministico
  // (position, id) prima di costruire i cross-link e la proiezione, così links e pagine
  // restano coerenti (stesso slug ovunque). I nodi `done` arrivano con lo slug
  // finale già risolto.
  const doneNodes = dedupeNodeSlugs(allNodes.filter((n) => n.status === "done"));

  // Costo aggregato: somma dei costi dei nodi + il costo dell'orientamento già scritto in
  // generation.cost (la M5a vi mette il costo dell'orient). I nodi portano il loro costo.
  const nodesCost = allNodes.reduce((sum, n) => sum + Number(n.cost ?? 0), 0);
  const baseCost = Number(generation.cost ?? 0);
  const costUsd = baseCost + nodesCost;

  // 1) Cross-link implements (path-anchored, bidirezionale) su tutti i nodi `done`.
  const linkable: LinkableNode[] = doneNodes.map((n) => ({
    id: n.id,
    tree: n.tree,
    slug: n.slug,
    title: n.title,
    sourcePaths: nodeSourcePaths(n),
  }));
  const implementsLinks = resolveImplementsLinks(linkable);

  let stats: DagGenerationStats;
  try {
    stats = await db.transaction(async (tx) => {
      // 2) Proiezione doc_nodes → doc_pages (due passaggi sui parent) + link implements.
      const projected = await projectPages(
        tx,
        projectId,
        generationId,
        doneNodes,
        implementsLinks,
      );

      // 3) Chunk + embed (riuso esatto della pipeline): doc_chunks + vettori di pagina.
      const embedPages = projected.map((p) => ({
        id: p.id,
        body: p.body,
        kind: p.kind,
        sourcePath: p.sourcePath,
      }));
      const embedded = await embedAndStoreChunks(tx, embeddingClient, {
        projectId,
        generationId,
        pages: embedPages,
        batchSize: deps.embedBatchSize ?? EMBED_BATCH_SIZE,
      });

      // 4) Related links (semantici, in-memory) appesi a doc_pages.links.
      // `implementsLinks` è keyed per nodeId: lo ri-chiavo per pageId (la chiave delle
      // pagine proiettate) così i related si concatenano ai link implements già scritti.
      const titleByNode = new Map(doneNodes.map((n) => [n.id, n.title]));
      const existingLinksByPage = new Map<string, NodeLink[]>();
      for (const p of projected) {
        const links = implementsLinks.get(p.nodeId);
        if (links && links.length > 0) existingLinksByPage.set(p.id, links);
      }
      const candidates = projected
        .filter((p) => embedded.pageVectors.has(p.id))
        .map((p) => ({
          id: p.id,
          vector: embedded.pageVectors.get(p.id) as number[],
          slug: p.slug,
          title: titleByNode.get(p.nodeId) ?? p.slug,
        }));
      await appendRelated(tx, projected, embedded.pageVectors, existingLinksByPage, candidates);

      return {
        nodes: allNodes.length,
        doneNodes: doneNodes.length,
        failedNodes: failedNodes.length,
        maxDepth: allNodes.reduce((m, n) => Math.max(m, n.depth), 0),
        pages: projected.length,
        chunks: embedded.chunkCount,
      } satisfies DagGenerationStats;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(docGenerations)
      .set({ status: "failed", error: message, finishedAt: sql`now()` })
      .where(eq(docGenerations.id, generationId));
    if (trigger) {
      await failDocJob(db, trigger.id, {
        log: `[docs] finalizzazione fallita: ${message}`,
        error: message,
      });
    }
    return "failed";
  }

  const costString = costUsd.toFixed(6);

  // 5) Chiusura: generazione `succeeded` con stats + costo, SWAP, prune, trigger succeeded.
  if (failedNodes.length > 0) {
    console.error(
      `[stubwise-worker] doc-generation ${generationId} finalizzata con ${failedNodes.length} nodo/i falliti (saltati dalle pagine)`,
    );
  }

  await db
    .update(docGenerations)
    .set({ status: "succeeded", cost: costString, stats, finishedAt: sql`now()` })
    .where(eq(docGenerations.id, generationId));

  // SWAP: il puntatore corrente passa a questa generazione SOLO ora (su successo).
  await db
    .update(projects)
    .set({ currentDocGenerationId: generationId })
    .where(eq(projects.id, projectId));

  // PRUNE: corrente + precedente (cascade su doc_pages/doc_chunks).
  await pruneOldGenerations(db, projectId, generationId);

  if (trigger) {
    await completeDocJob(db, trigger.id, {
      log: `[docs] generazione completata: ${stats.pages} pagine (${stats.doneNodes} nodi, profondità ${stats.maxDepth}), ${stats.chunks} chunk, costo $${costString}`,
      generationId,
    });
  }

  return "succeeded";
}

/**
 * Calcola e appende i link `related` alle pagine. Estratto come funzione locale per
 * evitare il rumore della firma; usa i candidati già risolti a titolo dal chiamante.
 */
async function appendRelated(
  tx: DbOrTx,
  projected: ProjectedPage[],
  pageVectors: Map<string, number[]>,
  existingLinks: Map<string, NodeLink[]>,
  candidates: { id: string; vector: number[]; slug: string; title: string }[],
): Promise<void> {
  // Indici padre/figli per pageId (per l'esclusione).
  const nodeToPageId = new Map<string, string>();
  for (const p of projected) nodeToPageId.set(p.nodeId, p.id);
  const parentByPage = new Map<string, string | null>();
  const childrenByParent = new Map<string, string[]>();
  for (const p of projected) {
    const parentPageId = p.parentNodeId ? (nodeToPageId.get(p.parentNodeId) ?? null) : null;
    parentByPage.set(p.id, parentPageId);
    if (parentPageId) {
      const arr = childrenByParent.get(parentPageId) ?? [];
      arr.push(p.id);
      childrenByParent.set(parentPageId, arr);
    }
  }
  // Slug → pageId per escludere le pagine già linkate (implements/implemented_by).
  const slugToPageId = new Map<string, string>();
  for (const c of candidates) slugToPageId.set(c.slug, c.id);

  for (const page of projected) {
    const vector = pageVectors.get(page.id);
    if (!vector) continue; // pagina senza chunk: nessun related.

    const exclude = new Set<string>([page.id]);
    const parentPageId = parentByPage.get(page.id);
    if (parentPageId) exclude.add(parentPageId);
    for (const childId of childrenByParent.get(page.id) ?? []) exclude.add(childId);
    const already = existingLinks.get(page.id) ?? [];
    for (const l of already) {
      const linkedPageId = slugToPageId.get(l.slug);
      if (linkedPageId) exclude.add(linkedPageId);
    }

    const related = selectRelatedLinks({ id: page.id, vector }, candidates, {
      k: RELATED_K,
      exclude,
    });
    if (related.length === 0) continue;

    const merged = [...already, ...related];
    await tx.update(docPages).set({ links: merged }).where(eq(docPages.id, page.id));
  }
}
