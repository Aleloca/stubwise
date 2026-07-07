import { docGenerations, docNodes, type Db } from "@stubwise/db";
import {
  briefPromptContext,
  buildProductFaqPrompt,
  buildProductGuidePrompt,
  buildProductRootPrompt,
  parseProductGuideOutput,
  parseProductPageOutput,
  pathCovers,
  slugForNode,
  type BriefJourney,
  type BriefSurface,
  type ProjectBrief,
} from "@stubwise/docs-engine";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AgentRunner } from "../../agent/runner.js";
import type { ResolvedProvider } from "../../providers/chain.js";
import { isLimitError } from "../../providers/limit.js";
import type { DocNode } from "../nodes.js";
import { summarizeBody } from "./synthesize-handler.js";

/**
 * PRODUCT HANDLER — la FASE `product` del motore documentazione ricorsivo (Fase B).
 *
 * Gira UNA VOLTA per generazione, DOPO che i due alberi interni (technical/functional)
 * sono chiusi (tutte le radici `done`) e PRIMA della finalizzazione (M6). I nodi che crea
 * sono nodi `done` del DAG (body valorizzato, tree='product'): entrano nella finalize
 * ESATTAMENTE come gli altri — proiettati in `doc_pages` kind='product', chunkati,
 * embeddati, contati nelle stats. Non partecipano ai cross-link `implements` (B1: la
 * finalize filtra i product dai linkable).
 *
 * Per ogni superficie PUBBLICA del brief genera una VERTICALE:
 *  - RADICE  ("Guida <superficie>"): getting-started + panoramica. `buildProductRootPrompt`.
 *  - GUIDE   (una per journey pertinente): how-to a struttura imposta con ancoraggi di
 *    navigazione validati. `buildProductGuidePrompt` → `parseProductGuideOutput`.
 *  - FAQ     (una): dalle "limitations" delle pagine functional pertinenti.
 *    `buildProductFaqPrompt`.
 *
 * ── SUPERFICI ELEGGIBILI (v1) ────────────────────────────────────────────────────────
 * In v1 le verticali product si generano SOLO per superfici UI PUBBLICHE:
 *  - `internal === false` (le admin/staff-only sono escluse by design);
 *  - il `type` NON indica un'API (euristica: contiene "api" case-insensitive → esclusa).
 * Le API pubbliche restano FUORI SCOPE v1: una guida a un'API ha un formato diverso
 * (reference di endpoint/parametri, non how-to con ancoraggi di navigazione UI). Le
 * escludiamo con un log esplicito; la loro documentazione resta negli alberi interni.
 *
 * ── DIFESA PASSIVA SUI SEGRETI ───────────────────────────────────────────────────────
 * I `functionalSummaries` di una verticale NON includono MAI le pagine functional la cui
 * fonte cade sotto una superficie INTERNA del brief: quelle pagine possono parlare di
 * margini/schermate admin e non devono nemmeno entrare come contesto interno di una
 * pagina pubblica. Il divieto categorico sui fatti riservati entra comunque via
 * `briefPromptContext(brief, { includeSecrets: true })` (la sezione NEVER-disclose);
 * l'audit vero e proprio è la Fase C.
 *
 * ── BUDGET ───────────────────────────────────────────────────────────────────────────
 * `maxProductPages` (DOC_PRODUCT_MAX_PAGES, default 12; 0 = fase spenta) è il tetto al
 * numero di pagine product create PER VERTICALE: OGNI superficie riparte col suo budget
 * pieno, così le superfici successive non restano affamate quando le prime esauriscono il
 * tetto. NON consuma `DOC_MAX_NODES` (budget separato dagli alberi interni). Al
 * raggiungimento del tetto DI UNA VERTICALE si passa alla successiva (log); le stats della
 * finalize riflettono i nodi effettivamente creati.
 *
 * ── COSTI ────────────────────────────────────────────────────────────────────────────
 * Ogni run product aggrega il suo costo su `doc_nodes.cost` del nodo che sta producendo
 * (radice/guida/FAQ), così la finalize lo somma in `doc_generations.cost` come per gli
 * altri nodi (Σ node.cost). Un retry somma sullo stesso nodo.
 *
 * ── RETROCOMPATIBILITÀ ───────────────────────────────────────────────────────────────
 * Brief assente, zero superfici eleggibili, o `maxProductPages === 0` → salto pulito
 * (log info), generazione INVARIATA. La fase è interamente additiva e non deve MAI far
 * fallire la generazione: ogni fallimento di un run è best-effort (log e si prosegue).
 */

export interface RunProductPhaseDeps {
  db: Db;
  runner: AgentRunner;
  /** Directory del worktree CONDIVISO della generazione (cwd read-only dell'agente). */
  worktreeDir: string;
  /** Modello AI degli agenti product (DOC_GENERATION_MODEL). */
  model: string;
  /** Timeout (ms) di ogni run dell'agente (DOC_AGENT_TIMEOUT_MS). */
  agentTimeoutMs: number;
  /** Turni massimi di ogni run dell'agente. */
  maxTurns: number;
  /**
   * Tetto al numero di pagine product create PER VERTICALE/superficie
   * (DOC_PRODUCT_MAX_PAGES): ogni verticale riparte col suo budget pieno.
   * 0 = fase spenta (salto pulito). Budget SEPARATO da DOC_MAX_NODES.
   */
  maxProductPages: number;
  /** Credenziale AI risolta dalla catena (prima voce); undefined = auth storica. */
  provider?: ResolvedProvider;
}

/** Esito della fase product: quante pagine sono state create (per il log del chiamante). */
export interface ProductPhaseResult {
  /** Pagine product create (radici + guide + FAQ) ed effettivamente `done` nel DAG. */
  pagesCreated: number;
}

/**
 * Regex delle sezioni "limiti/cosa non fa" nel body di una pagina functional. Euristica
 * semplice e documentata: righe di heading (markdown `#`) il cui testo esprime un limite,
 * in inglese o in italiano. Il testo del heading (senza `#`) diventa una `limitation` per
 * il prompt FAQ. Se nessun heading matcha, la FAQ della verticale è saltata.
 */
const LIMITATION_HEADING_RE =
  /limit|cannot|not (possible|supported)|non (puoi|è possibile|si può|si puo)/i;

/** Solo le righe di heading markdown (`#`…`######` a inizio riga). */
const MARKDOWN_HEADING_RE = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/;

/**
 * true se la superficie è ELEGGIBILE per una verticale product v1: pubblica (`internal
 * === false`) e NON un'API (il `type` non contiene "api"). Le due esclusioni sono
 * loggate separatamente dal chiamante per tracciabilità.
 */
function isApiSurface(surface: BriefSurface): boolean {
  return /api/i.test(surface.type);
}

/**
 * Filtra le superfici del brief tenendo SOLO quelle eleggibili (pubbliche, non-API),
 * loggando ogni esclusione. Preserva l'ordine del brief.
 */
function eligibleSurfaces(brief: ProjectBrief): BriefSurface[] {
  const eligible: BriefSurface[] = [];
  for (const surface of brief.surfaces) {
    if (surface.internal) {
      // Superficie interna (admin/staff): esclusa by design dalla pipeline pubblica.
      continue;
    }
    if (isApiSurface(surface)) {
      console.error(
        `[stubwise-worker] docs product: superficie "${surface.name}" (${surface.type}) esclusa ` +
          "(API pubblica: fuori scope v1, formato guida diverso)",
      );
      continue;
    }
    eligible.push(surface);
  }
  return eligible;
}

/**
 * I journey del brief PERTINENTI a una superficie pubblica: quelli di attori ESTERNI. Il
 * match attore→superficie è volutamente permissivo (il brief non lega un journey a una
 * superficie): la superficie è il CONTESTO del run, e generiamo per TUTTI i journey di
 * attori esterni; l'agente emette `===SKIP===` se il journey non è realizzabile qui. Un
 * journey il cui attore non compare tra gli attori del brief (o è vuoto) è tenuto
 * (fail-open verso l'inclusione: la superficie pubblica lo giustifica, lo skip lo filtra).
 */
function relevantJourneys(brief: ProjectBrief): BriefJourney[] {
  const internalActors = new Set(
    brief.actors.filter((a) => a.internal).map((a) => a.name.trim().toLowerCase()),
  );
  return brief.journeys.filter((j) => {
    const actor = j.actor.trim().toLowerCase();
    // Attore esplicitamente INTERNO → journey escluso (è un flusso da back office).
    return !internalActors.has(actor);
  });
}

/**
 * Predicato UNICO delle fonti di una verticale (usato sia per i `functionalSummaries` sia
 * per le `limitations`): il nodo functional `done` è PERTINENTE alla superficie se almeno
 * una sua fonte cade SOTTO `surface.rootPath` (pathCovers) e NESSUNA cade sotto il
 * rootPath di una superficie INTERNA (difesa passiva: mai contesto interno in una pagina
 * pubblica). Un nodo senza fonti è escluso.
 */
function functionalNodeCovers(
  surface: BriefSurface,
  node: DocNode,
  internalRootPaths: string[],
): boolean {
  const paths = (node.sourcePaths as string[] | null) ?? [];
  if (paths.length === 0) return false;
  if (!paths.some((p) => pathCovers(surface.rootPath, p))) return false;
  // Difesa passiva: se una qualsiasi fonte cade sotto una superficie interna, escludi.
  return !paths.some((p) => internalRootPaths.some((root) => pathCovers(root, p)));
}

/**
 * I nodi functional `done` PERTINENTI a una superficie (`functionalNodeCovers`): fonti sia
 * dei `functionalSummaries` sia delle `limitations`. Preserva l'ordine d'ingresso.
 */
function functionalNodesFor(
  surface: BriefSurface,
  functionalNodes: DocNode[],
  internalRootPaths: string[],
): DocNode[] {
  return functionalNodes.filter((node) =>
    functionalNodeCovers(surface, node, internalRootPaths),
  );
}

/**
 * `functionalSummaries` per una superficie: titolo + primo paragrafo (`summarizeBody`)
 * dei nodi functional pertinenti (`functionalNodesFor`, difesa passiva inclusa).
 */
function functionalSummariesFor(
  summaryNodes: DocNode[],
): { title: string; summary: string }[] {
  return summaryNodes.map((node) => ({
    title: node.title,
    summary: summarizeBody(node.body ?? ""),
  }));
}

/**
 * Estrae le `limitations` per la FAQ di una superficie: i heading "limiti/cosa non fa"
 * (LIMITATION_HEADING_RE) delle pagine functional pertinenti alla superficie. Semplice e
 * documentato: prende il TESTO del heading come voce di limitazione. Deduplica, cap a 20.
 */
function limitationsFor(
  functionalSummaryNodes: DocNode[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const node of functionalSummaryNodes) {
    for (const line of (node.body ?? "").split("\n")) {
      const m = MARKDOWN_HEADING_RE.exec(line);
      if (!m) continue;
      const heading = m[1]?.trim() ?? "";
      if (heading === "" || !LIMITATION_HEADING_RE.test(heading)) continue;
      if (seen.has(heading)) continue;
      seen.add(heading);
      out.push(heading);
      if (out.length >= 20) return out;
    }
  }
  return out;
}

/** Risultato di UN run product: body valido, oppure skip, oppure fallito (dopo retry). */
type RunOutcome =
  | { kind: "body"; body: string; costUsd: number }
  | { kind: "skip"; reason: string; costUsd: number }
  | { kind: "failed"; costUsd: number };

/**
 * Esegue UN run dell'agente product per un prompt e ne parsa l'output col `parse` dato,
 * con UN retry sul solo `{ reason }` (output malformato/ancoraggi insufficienti). Uno
 * `{ skip }` NON viene ritentato (è una risposta legittima). Il limite del provider è
 * trattato come fallimento non-fatale della sola pagina (la fase è additiva e best-effort;
 * NON mette in pausa la generazione — a questo punto il DAG interno è già chiuso). Il
 * costo è aggregato su TUTTI i tentativi.
 */
async function runProductPage(
  deps: RunProductPhaseDeps,
  prompt: string,
  parse: (
    output: string,
  ) => { body: string } | { skip: string } | { reason: unknown },
): Promise<RunOutcome> {
  const providerOpt = deps.provider !== undefined ? { provider: deps.provider } : {};
  let costUsd = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let output: string;
    try {
      const result = await deps.runner.run({
        cwd: deps.worktreeDir,
        prompt,
        model: deps.model,
        permissionMode: "plan",
        maxTurns: deps.maxTurns,
        timeoutMs: deps.agentTimeoutMs,
        ...providerOpt,
      });
      costUsd += result.usage?.totalCostUsd ?? 0;
      // Limite del provider: NON è un output invalido e non consuma un secondo run —
      // la pagina è saltata (best-effort). La fase gira dopo il DAG interno, quindi non
      // c'è un DAG da mettere in pausa; il costo del run parziale è comunque aggregato.
      if (isLimitError(result)) return { kind: "failed", costUsd };
      output = result.output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[stubwise-worker] docs product: run fallito (${message})`);
      return { kind: "failed", costUsd };
    }
    const parsed = parse(output);
    if ("body" in parsed) return { kind: "body", body: parsed.body, costUsd };
    if ("skip" in parsed) return { kind: "skip", reason: parsed.skip, costUsd };
    // `{ reason }`: output malformato → un retry, poi scarto.
  }
  return { kind: "failed", costUsd };
}

/** Inserisce un nodo product `done` (body valorizzato) col suo slug univoco e costo. */
async function insertProductNode(
  db: Db,
  generationId: string,
  repositoryId: string,
  parentId: string | null,
  depth: number,
  position: number,
  title: string,
  slug: string,
  body: string,
  costUsd: number,
): Promise<string> {
  const [node] = await db
    .insert(docNodes)
    .values({
      generationId,
      repositoryId,
      parentId,
      tree: "product",
      status: "done",
      depth,
      position,
      title,
      slug,
      body,
      sourcePaths: [],
      cost: costUsd.toFixed(6),
      finishedAt: sql`now()`,
    })
    .returning({ id: docNodes.id });
  if (!node) throw new Error("insert del nodo product non ha restituito la riga");
  return node.id;
}

/**
 * Esegue la FASE product per la generazione. Vedi il docblock del modulo. Ritorna il
 * numero di pagine product create (per il log del chiamante). NON lancia MAI: ogni
 * fallimento è best-effort (log e si prosegue), così la fase non rompe la finalizzazione.
 */
export async function runProductPhase(
  deps: RunProductPhaseDeps,
  generationId: string,
): Promise<ProductPhaseResult> {
  const { db } = deps;

  // GATE 1 — fase spenta.
  if (deps.maxProductPages <= 0) {
    console.error(
      `[stubwise-worker] docs product: fase disabilitata (DOC_PRODUCT_MAX_PAGES=0) per la generazione ${generationId}`,
    );
    return { pagesCreated: 0 };
  }

  // GATE 2 — brief presente.
  const [gen] = await db
    .select({ brief: docGenerations.brief, repositoryId: docGenerations.repositoryId })
    .from(docGenerations)
    .where(eq(docGenerations.id, generationId));
  const brief = (gen?.brief ?? null) as ProjectBrief | null;
  if (!gen || brief === null) {
    console.error(
      `[stubwise-worker] docs product: nessun brief per la generazione ${generationId}, fase saltata`,
    );
    return { pagesCreated: 0 };
  }
  const repositoryId = gen.repositoryId;

  // GATE 3 — superfici pubbliche UI eleggibili.
  const surfaces = eligibleSurfaces(brief);
  if (surfaces.length === 0) {
    console.error(
      `[stubwise-worker] docs product: nessuna superficie pubblica UI nel brief della generazione ${generationId}, fase saltata`,
    );
    return { pagesCreated: 0 };
  }

  // Il contesto del brief CON segreti (la sezione NEVER-disclose) per TUTTI i run product.
  const briefContext = briefPromptContext(brief, { includeSecrets: true });

  // Nodi functional `done` della generazione (fonti dei summaries/limitations) + gli slug
  // già usati (per generare slug product univoci nell'insieme della generazione).
  const functionalNodes = await db
    .select()
    .from(docNodes)
    .where(
      and(
        eq(docNodes.generationId, generationId),
        eq(docNodes.tree, "functional"),
        eq(docNodes.status, "done"),
      ),
    )
    .orderBy(asc(docNodes.depth), asc(docNodes.position));
  const usedSlugs = new Set(
    (
      await db
        .select({ slug: docNodes.slug })
        .from(docNodes)
        .where(eq(docNodes.generationId, generationId))
    )
      .map((r) => r.slug)
      .filter((s) => s.length > 0),
  );

  // Rootpath delle superfici INTERNE (difesa passiva sui functionalSummaries).
  const internalRootPaths = brief.surfaces.filter((s) => s.internal).map((s) => s.rootPath);

  const journeys = relevantJourneys(brief);

  let pagesCreated = 0;
  let position = 0; // posizione tra le radici product (dopo le radici interne).

  for (const surface of surfaces) {
    // Budget PER VERTICALE: ogni superficie riparte col suo tetto pieno, così le superfici
    // successive non restano affamate quando le prime esauriscono il budget.
    let verticalPages = 0;

    // Fonti della verticale: nodi functional pertinenti (con difesa passiva), usati sia per
    // i summaries sia per le limitations della FAQ.
    const summaryNodes = functionalNodesFor(surface, functionalNodes, internalRootPaths);
    const functionalSummaries = functionalSummariesFor(summaryNodes);

    // ── RADICE della verticale ──────────────────────────────────────────────────────────
    const rootPrompt = buildProductRootPrompt({ surface, briefContext, functionalSummaries });
    const rootOutcome = await runProductPage(deps, rootPrompt, parseProductPageOutput);
    if (rootOutcome.kind !== "body") {
      // Senza radice le guide non avrebbero un genitore: si scarta la verticale INTERA. Il
      // costo del run fallito NON va perso: senza un nodo su cui accumularlo (nessun nodo
      // creato) lo sommiamo ADDITIVAMENTE su doc_generations.cost (come orient somma il suo
      // costo alla generazione); la finalize aggiunge poi Σ node.cost a questa base.
      console.error(
        `[stubwise-worker] docs product: radice della superficie "${surface.name}" non prodotta ` +
          `(esito ${rootOutcome.kind}) → verticale scartata`,
      );
      if (rootOutcome.costUsd > 0) await bumpGenerationCost(db, generationId, rootOutcome.costUsd);
      continue;
    }
    const rootTitle = `${surface.name} guide`;
    const rootSlug = slugForNode(rootTitle, usedSlugs);
    const rootId = await insertProductNode(
      db,
      generationId,
      repositoryId,
      null,
      0,
      position,
      rootTitle,
      rootSlug,
      rootOutcome.body,
      rootOutcome.costUsd,
    );
    position += 1;
    pagesCreated += 1;
    verticalPages += 1;

    let childPosition = 0;

    // ── GUIDE (una per journey pertinente) ──────────────────────────────────────────────
    for (const journey of journeys) {
      if (verticalPages >= deps.maxProductPages) break;
      const guidePrompt = buildProductGuidePrompt({
        surface,
        briefContext,
        functionalSummaries,
        journey,
      });
      const outcome = await runProductPage(deps, guidePrompt, parseProductGuideOutput);
      if (outcome.kind === "skip") {
        console.error(
          `[stubwise-worker] docs product: guida "${journey.title}" su "${surface.name}" saltata dall'agente (${outcome.reason})`,
        );
        // Il costo dello skip va comunque contato: lo accumulo sulla radice.
        if (outcome.costUsd > 0) await bumpNodeCost(db, rootId, outcome.costUsd);
        continue;
      }
      if (outcome.kind === "failed") {
        console.error(
          `[stubwise-worker] docs product: guida "${journey.title}" su "${surface.name}" non prodotta (dopo retry) → scartata`,
        );
        if (outcome.costUsd > 0) await bumpNodeCost(db, rootId, outcome.costUsd);
        continue;
      }
      const guideSlug = slugForNode(journey.title, usedSlugs);
      await insertProductNode(
        db,
        generationId,
        repositoryId,
        rootId,
        1,
        childPosition,
        journey.title,
        guideSlug,
        outcome.body,
        outcome.costUsd,
      );
      childPosition += 1;
      pagesCreated += 1;
      verticalPages += 1;
    }

    // ── FAQ della verticale ─────────────────────────────────────────────────────────────
    if (verticalPages < deps.maxProductPages) {
      const limitations = limitationsFor(summaryNodes);
      if (limitations.length === 0) {
        console.error(
          `[stubwise-worker] docs product: nessuna limitazione estratta per "${surface.name}", FAQ saltata`,
        );
      } else {
        const faqPrompt = buildProductFaqPrompt({
          surface,
          briefContext,
          functionalSummaries,
          limitations,
        });
        const outcome = await runProductPage(deps, faqPrompt, parseProductPageOutput);
        if (outcome.kind === "body") {
          const faqTitle = `${surface.name} FAQ`;
          const faqSlug = slugForNode(faqTitle, usedSlugs);
          await insertProductNode(
            db,
            generationId,
            repositoryId,
            rootId,
            1,
            childPosition,
            faqTitle,
            faqSlug,
            outcome.body,
            outcome.costUsd,
          );
          childPosition += 1;
          pagesCreated += 1;
          verticalPages += 1;
        } else {
          console.error(
            `[stubwise-worker] docs product: FAQ di "${surface.name}" non prodotta (esito ${outcome.kind})`,
          );
          if (outcome.costUsd > 0) await bumpNodeCost(db, rootId, outcome.costUsd);
        }
      }
    }
  }

  console.error(
    `[stubwise-worker] docs product: generazione ${generationId} — ${pagesCreated} pagine product create`,
  );
  return { pagesCreated };
}

/** Accumula un costo (di uno skip/retry/fallimento senza nodo proprio) su un nodo esistente. */
async function bumpNodeCost(db: Db, nodeId: string, costUsd: number): Promise<void> {
  await db
    .update(docNodes)
    .set({ cost: sql`coalesce(${docNodes.cost}, 0) + ${costUsd.toFixed(6)}` })
    .where(eq(docNodes.id, nodeId));
}

/**
 * Accumula ADDITIVAMENTE un costo su `doc_generations.cost` (come orient somma il suo
 * costo alla generazione). Usato quando la RADICE di una verticale fallisce: nessun nodo
 * viene creato, quindi il costo del run non avrebbe altrimenti dove essere aggregato. La
 * finalize sommerà poi Σ node.cost a questa base (vedi finalize.ts, baseCost + nodesCost).
 */
async function bumpGenerationCost(db: Db, generationId: string, costUsd: number): Promise<void> {
  await db
    .update(docGenerations)
    .set({ cost: sql`coalesce(${docGenerations.cost}, 0) + ${costUsd.toFixed(6)}` })
    .where(eq(docGenerations.id, generationId));
}
