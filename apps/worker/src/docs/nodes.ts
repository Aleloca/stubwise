import { docNodes, type Db } from "@stubwise/db";
import { slugForNode } from "@stubwise/docs-engine";
import { and, eq, inArray, sql } from "drizzle-orm";

export type DocNode = typeof docNodes.$inferSelect;

/**
 * Drizzle DB o una sua transazione: espongono la stessa interfaccia di query,
 * così gli helper sui nodi funzionano sia con `db` sia con il `tx` passato
 * dentro `db.transaction(...)`. Mirror del DbOrTx di pipeline.ts.
 */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Stati da cui un worker può reclamare un nodo (vedi la subquery di
 * claimNextNode): `pending` → fase di esplorazione, `ready_to_synthesize` →
 * fase di sintesi (il padre i cui figli sono tutti chiusi). Gli altri stati o
 * sono terminali (`done`/`failed`) o "in volo" (`exploring`/`synthesizing`/
 * `awaiting_children`, non reclamabili).
 *
 * Stati "in lavorazione" di un nodo: un worker può far avanzare o chiudere un
 * nodo solo finché è in uno di questi. Le transizioni terminali
 * (completeNode/failNode) filtrano su questo insieme: se nel frattempo il nodo
 * è stato riportato in coda (requeueStaleNodes) e reclamato da un altro worker,
 * l'UPDATE non tocca righe — il chiamante ha perso la ownership e si ferma.
 * Questo status-guard è anche la garanzia anti-doppio-join: una sola
 * transizione `exploring|synthesizing → done|failed` può andare a buon fine per
 * un dato nodo, quindi `joinParent` sul padre viene innescato ESATTAMENTE una
 * volta per figlio.
 */
const ACTIVE_STATUSES = ["exploring", "synthesizing"] as const;

export type NodePhase = "explore" | "synthesize";

export interface ClaimedNode {
  node: DocNode;
  phase: NodePhase;
}

/**
 * Reclama atomicamente il nodo claimabile più vecchio e lo fa avanzare.
 * Il claim è un singolo UPDATE con subquery `FOR UPDATE SKIP LOCKED`: due
 * worker concorrenti non possono mai prendere lo stesso nodo, chi trova la riga
 * già lockata passa alla successiva (o riceve null se non c'è nulla). La
 * transizione dipende dallo stato di partenza letto dentro la stessa riga:
 * `pending → exploring` (fase explore), `ready_to_synthesize → synthesizing`
 * (fase synthesize). Un CASE lato DB sceglie il nuovo stato in modo che la
 * transizione resti atomica con la selezione. L'ORDER BY created_at + il filtro
 * su status sfruttano doc_nodes_claimable_idx. Mirror di claimNextDocJob.
 */
export async function claimNextNode(db: DbOrTx): Promise<ClaimedNode | null> {
  const [node] = await db
    .update(docNodes)
    .set({
      status: sql`CASE WHEN ${docNodes.status} = 'pending' THEN 'exploring'::doc_node_status ELSE 'synthesizing'::doc_node_status END`,
      lastActivityAt: sql`now()`,
    })
    .where(
      eq(
        docNodes.id,
        sql`(SELECT id FROM doc_nodes WHERE status IN ('pending', 'ready_to_synthesize') ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`,
      ),
    )
    .returning();
  if (!node) return null;
  // Il nodo è già stato scritto col nuovo stato: derivo la fase dal risultato.
  const phase: NodePhase = node.status === "exploring" ? "explore" : "synthesize";
  return { node, phase };
}

/**
 * Heartbeat silenzioso: bumpa SOLO `lastActivityAt`. Pensato per essere
 * chiamato a intervalli (<< della soglia di staleness) da un explore/synthesize
 * lungo ma vivo, così requeueStaleNodes non lo riporta in coda creando un
 * doppio lavoro. Idempotente e innocuo su un nodo già chiuso. Mirror di
 * touchDocJob.
 */
export async function touchNode(db: DbOrTx, nodeId: string): Promise<void> {
  await db
    .update(docNodes)
    .set({ lastActivityAt: sql`now()` })
    .where(eq(docNodes.id, nodeId));
}

/**
 * Persiste il costo (USD) del nodo: la somma dei run dell'agente
 * (explore/synthesize) di QUESTO nodo. Scritto al termine del dispatch del nodo,
 * così la finalizzazione (M6) lo somma in `doc_generations.cost` (Σ node.cost +
 * costo dell'orientamento). NON è status-guarded: il costo è una metrica
 * additiva e va registrata anche se nel frattempo la ownership del nodo è
 * cambiata (il lavoro è comunque costato). Numeric a 6 decimali come la colonna.
 */
export async function recordNodeCost(db: DbOrTx, nodeId: string, costUsd: number): Promise<void> {
  await db
    .update(docNodes)
    .set({ cost: costUsd.toFixed(6) })
    .where(eq(docNodes.id, nodeId));
}

export interface ExploreResult {
  /** Corpo markdown della pagina prodotto dall'esplorazione. */
  body: string;
  /** Path sorgente coperti dal nodo. */
  sourcePaths: string[];
}

/**
 * Persiste l'esito dell'esplorazione di un nodo (body + source_paths) prima
 * della creazione dei figli. Status-guarded su `exploring`: scrive solo se il
 * nodo è ancora di chi sta esplorando (ownership), così un esito tardivo di un
 * worker che ha perso la riga non la sovrascrive.
 */
export async function writeExploreResult(
  db: DbOrTx,
  nodeId: string,
  result: ExploreResult,
): Promise<boolean> {
  const updated = await db
    .update(docNodes)
    .set({
      body: result.body,
      sourcePaths: result.sourcePaths,
      lastActivityAt: sql`now()`,
    })
    .where(and(eq(docNodes.id, nodeId), eq(docNodes.status, "exploring")))
    .returning({ id: docNodes.id });
  return updated.length > 0;
}

export interface ChildSpec {
  tree: DocNode["tree"];
  title?: string;
  slug?: string;
  unitRef?: string | null;
  sourcePaths?: string[];
}

/**
 * Crea i nodi figli di `parentId` e arma il join, tutto in UNA transazione:
 *  - inserisce le righe figlie (`pending`, depth = padre+1, position = indice),
 *    ereditando generationId/projectId dal padre;
 *  - imposta `parent.pending_children = specs.length` (il contatore del join);
 *  - porta il padre da `exploring` a `awaiting_children`.
 * L'atomicità è essenziale: il contatore e lo stato del padre devono diventare
 * visibili insieme alle righe figlie, altrimenti un figlio potrebbe completarsi
 * e tentare il join prima che il contatore esista. `specs` NON dev'essere vuoto
 * (una foglia chiama completeNode, non createChildren): l'invariante è asserito.
 */
export async function createChildren(
  db: DbOrTx,
  parentId: string,
  specs: ChildSpec[],
): Promise<void> {
  if (specs.length === 0) {
    throw new Error("createChildren richiede almeno un figlio: una foglia usa completeNode");
  }
  await db.transaction(async (tx) => {
    const [parent] = await tx
      .select({
        generationId: docNodes.generationId,
        projectId: docNodes.projectId,
        depth: docNodes.depth,
      })
      .from(docNodes)
      .where(eq(docNodes.id, parentId))
      .for("update");
    if (!parent) throw new Error(`nodo padre ${parentId} non trovato`);

    // SLUG univoci NELLA generazione: la finalizzazione proietta ogni nodo in una
    // doc_page con `(generation_id, slug)` UNIQUE, quindi due nodi della stessa
    // generazione non possono condividere lo slug. Lo spec può portarne uno (le radici
    // dall'orientamento); altrimenti lo genero qui da `title` con `slugForNode` su un
    // set che parte dagli slug GIÀ presenti nella generazione (letti sotto il row-lock
    // del padre) + quelli appena assegnati ai fratelli. Un title vuoto degrada a uno
    // slug stabile e univoco (slugForNode garantisce non-vuoto e dedup).
    const existing = await tx
      .select({ slug: docNodes.slug })
      .from(docNodes)
      .where(eq(docNodes.generationId, parent.generationId));
    const usedSlugs = new Set(existing.map((r) => r.slug).filter((s) => s.length > 0));

    await tx.insert(docNodes).values(
      specs.map((spec, index) => ({
        generationId: parent.generationId,
        projectId: parent.projectId,
        parentId,
        tree: spec.tree,
        status: "pending" as const,
        depth: parent.depth + 1,
        position: index,
        unitRef: spec.unitRef ?? null,
        title: spec.title ?? "",
        slug:
          spec.slug && spec.slug.length > 0
            ? spec.slug
            : slugForNode(spec.title ?? "", usedSlugs),
        sourcePaths: spec.sourcePaths ?? [],
      })),
    );

    await tx
      .update(docNodes)
      .set({
        pendingChildren: specs.length,
        status: "awaiting_children",
        lastActivityAt: sql`now()`,
      })
      .where(eq(docNodes.id, parentId));
  });
}

/**
 * Chiude un nodo come `done`: status-guarded su `exploring|synthesizing` (set
 * finishedAt). Se la transizione va a buon fine e il nodo ha un padre, innesca
 * il join sul padre. Lo status-guard garantisce che la transizione possa
 * riuscire al più una volta: di conseguenza joinParent è chiamato esattamente
 * una volta per nodo (niente doppio decremento). Restituisce false se la
 * ownership è persa (un altro worker ha già chiuso/ripreso il nodo): in quel
 * caso NON tocca il padre.
 */
export async function completeNode(db: DbOrTx, nodeId: string): Promise<boolean> {
  const [updated] = await db
    .update(docNodes)
    .set({ status: "done", finishedAt: sql`now()`, lastActivityAt: sql`now()` })
    .where(and(eq(docNodes.id, nodeId), inArray(docNodes.status, [...ACTIVE_STATUSES])))
    .returning({ parentId: docNodes.parentId });
  if (!updated) return false;
  if (updated.parentId) await joinParent(db, updated.parentId);
  return true;
}

/**
 * Chiude un nodo come `failed`: status-guarded su `exploring|synthesizing` (set
 * finishedAt + error). Come completeNode, se la transizione riesce e c'è un
 * padre innesca il join: un figlio FALLITO deve comunque far avanzare il join
 * del padre, altrimenti il padre resterebbe per sempre in `awaiting_children`
 * (deadlock). Restituisce false se la ownership è persa.
 */
export async function failNode(db: DbOrTx, nodeId: string, error: string): Promise<boolean> {
  const [updated] = await db
    .update(docNodes)
    .set({ status: "failed", error, finishedAt: sql`now()`, lastActivityAt: sql`now()` })
    .where(and(eq(docNodes.id, nodeId), inArray(docNodes.status, [...ACTIVE_STATUSES])))
    .returning({ parentId: docNodes.parentId });
  if (!updated) return false;
  if (updated.parentId) await joinParent(db, updated.parentId);
  return true;
}

/**
 * IL JOIN ATOMICO — cuore del milestone. Decrementa di 1 il contatore
 * `pending_children` del padre e, quando arriva a 0 mentre il padre è ancora in
 * `awaiting_children`, lo fa avanzare a `ready_to_synthesize` (così diventa
 * reclamabile per la sintesi).
 *
 * Race-safety: l'intera operazione gira in una transazione che apre con un
 * `SELECT ... FOR UPDATE` sulla riga del padre. Figli concorrenti che si
 * chiudono nello stesso istante serializzano su quel row-lock: ognuno legge il
 * contatore aggiornato dal precedente, lo decrementa e committa, così N
 * decrementi portano il contatore esattamente da N a 0 senza perdite né valori
 * negativi. La transizione `awaiting_children → ready_to_synthesize` è
 * status-guarded sul valore appena letto: solo il decremento che porta il
 * contatore a 0 trova ancora il padre in `awaiting_children` e lo flippa — gli
 * altri lo trovano già flippato (o ≠ awaiting_children) e non fanno nulla.
 * Risultato: il flip avviene ESATTAMENTE una volta.
 *
 * Ho scelto il DECREMENTO di un contatore (vs. contare i figli non-done) perché
 * sotto il row-lock del padre è O(1) e immune al numero di figli; conta solo
 * che il decremento+flip avvengano dentro lo stesso lock.
 */
export async function joinParent(db: DbOrTx, parentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ pendingChildren: docNodes.pendingChildren, status: docNodes.status })
      .from(docNodes)
      .where(eq(docNodes.id, parentId))
      .for("update");
    if (!parent) return;

    // Non scendere mai sotto zero: difesa contro un join duplicato accidentale.
    const remaining = Math.max(parent.pendingChildren - 1, 0);
    const flip = remaining === 0 && parent.status === "awaiting_children";

    await tx
      .update(docNodes)
      .set({
        pendingChildren: remaining,
        lastActivityAt: sql`now()`,
        ...(flip ? { status: "ready_to_synthesize" as const } : {}),
      })
      .where(eq(docNodes.id, parentId));
  });
}

/**
 * Riporta in coda i nodi `exploring`/`synthesizing` senza attività oltre la
 * soglia: il segno di un worker crashato a metà nodo. La staleness si misura su
 * `lastActivityAt` (non su createdAt): un nodo lungo che continua a battere
 * (touchNode) è vivo e non va toccato. Ogni stato torna al suo stato claimabile
 * di partenza — `exploring → pending`, `synthesizing → ready_to_synthesize` —
 * così il claim successivo lo riprende dalla fase giusta. `finishedAt` resta
 * null (il nodo non è concluso). Restituisce quanti nodi sono stati
 * ripristinati. Mirror di requeueStaleDocJobs.
 */
export async function requeueStaleNodes(db: DbOrTx, staleMinutes: number): Promise<number> {
  const requeued = await db
    .update(docNodes)
    .set({
      status: sql`CASE WHEN ${docNodes.status} = 'exploring' THEN 'pending'::doc_node_status ELSE 'ready_to_synthesize'::doc_node_status END`,
      lastActivityAt: sql`now()`,
    })
    .where(
      and(
        inArray(docNodes.status, [...ACTIVE_STATUSES]),
        sql`${docNodes.lastActivityAt} < now() - make_interval(mins => ${staleMinutes}::int)`,
      ),
    )
    .returning({ id: docNodes.id });
  return requeued.length;
}
