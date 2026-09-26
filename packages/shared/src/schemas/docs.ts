import { z } from "zod";
import { decisionSourceSchema } from "./project.js";

/**
 * Tipo di pagina di documentazione: "technical" (registro tecnico/dev),
 * "functional" (registro funzionale/business) — entrambi autogenerati —,
 * "product" (verticali PUBBLICHE per superficie: getting-started, guide di
 * journey e FAQ generate dopo la chiusura dei due alberi, seconda persona e
 * zero interni), "manual" (pagina curata a mano, non toccata dalla
 * rigenerazione) o "releases" (changelog/note di rilascio aggiornate in
 * automatico ai push). Fonte di verità condivisa tra db (enum `doc_page_kind`),
 * server (validazione) e web.
 */
export const docPageKindSchema = z.enum([
  "technical",
  "functional",
  "product",
  "manual",
  "releases",
]);
export type DocPageKind = z.infer<typeof docPageKindSchema>;

/**
 * Stato di una generazione di documentazione: "pending" (creata, non ancora
 * avviata), "running" (in corso), "paused" (sospesa per limite di utilizzo del
 * provider, ripresa automatica dal resume poller), "succeeded" / "failed"
 * (terminali).
 */
export const docGenerationStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "succeeded",
  "failed",
]);
export type DocGenerationStatus = z.infer<typeof docGenerationStatusSchema>;

/** Motivo per cui un job è in `held`: solo `limit` è auto-ripristinabile. */
export const heldReasonSchema = z.enum(["limit", "budget", "other"]);
export type HeldReason = z.infer<typeof heldReasonSchema>;

/**
 * Origine di una generazione: "manual" (avviata da un umano) o "push"
 * (innescata da un evento push del repo, fase 2 — già predisposta nello schema).
 */
export const docGenerationTriggerSchema = z.enum(["manual", "push"]);
export type DocGenerationTrigger = z.infer<typeof docGenerationTriggerSchema>;

/**
 * Stato di un job di doc-generation (project-scoped, coda dedicata): "queued",
 * "running", "succeeded", "failed", "held" (parcheggiato, es. cap di costo).
 */
export const docJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "held",
]);
export type DocJobStatus = z.infer<typeof docJobStatusSchema>;

/**
 * Stato di un nodo del DAG di documentazione ricorsivo: "pending" (creato,
 * claimabile per esplorazione), "exploring" (in esplorazione), "awaiting_children"
 * (ramo che attende i figli), "ready_to_synthesize" (figli completati, claimabile
 * per sintesi), "synthesizing" (in sintesi), "done" / "failed" (terminali). Fonte
 * di verità condivisa tra db (enum `doc_node_status`) e worker.
 */
export const docNodeStatusSchema = z.enum([
  "pending",
  "exploring",
  "awaiting_children",
  "ready_to_synthesize",
  "synthesizing",
  "done",
  "failed",
]);
export type DocNodeStatus = z.infer<typeof docNodeStatusSchema>;

/**
 * Albero di appartenenza di un nodo di documentazione: "technical" (registro
 * tecnico/dev), "functional" (registro funzionale/business) o "product"
 * (verticali pubbliche per superficie, generate dopo la chiusura dei due alberi
 * interni). Fonte di verità condivisa tra db (enum `doc_tree`) e worker: la
 * finalize mappa `doc_nodes.tree` → `doc_pages.kind`, quindi i nodi product
 * hanno `tree = 'product'` per proiettare `kind = 'product'`. Nota: gli explore
 * e synthesize ricorsivi operano SOLO su technical/functional (il loro
 * `DocTree` in docs-engine resta ai due alberi interni); i nodi product sono
 * creati e chiusi dall'handler product dedicato, non dal DAG explore/synthesize.
 */
export const docTreeSchema = z.enum(["technical", "functional", "product"]);
export type DocTree = z.infer<typeof docTreeSchema>;

/**
 * PROJECT BRIEF — le "domande fondanti" del prodotto prodotte nel primo step
 * dell'orientamento e persistite su `doc_generations.brief` (jsonb). Rispecchia
 * `ProjectBrief` di `@stubwise/docs-engine` (fonte di verità del parser); qui vive
 * lo schema di VALIDAZIONE per la route server `GET .../docs/brief` e per il tipo
 * consumato dalla SPA (tab Brief). Superficie INTERNA autenticata: include i
 * `confidentialFacts` (che NON entrano mai nella documentazione pubblica — la tab
 * serve proprio all'audit).
 */
export const projectBriefSchema = z.object({
  identity: z.string(),
  actors: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      internal: z.boolean(),
    }),
  ),
  surfaces: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      rootPath: z.string(),
      audience: z.string(),
      internal: z.boolean(),
    }),
  ),
  glossary: z.array(z.object({ term: z.string(), definition: z.string() })),
  invariants: z.array(z.string()),
  confidentialFacts: z.array(
    z.object({
      fact: z.string(),
      reason: z.string(),
      source: z.string(),
      avoid: z.string(),
    }),
  ),
  journeys: z.array(
    z.object({ actor: z.string(), title: z.string(), summary: z.string() }),
  ),
  existingSources: z.array(z.string()),
});
export type ProjectBrief = z.infer<typeof projectBriefSchema>;

/**
 * Una pagina `product` ESCLUSA dal verificatore segreti (Fase C, fail-closed): dopo la
 * riscrittura mirata ha ancora fatto passare (o non era più parsabile) un fatto riservato,
 * quindi NON è stata pubblicata. Persistita in `doc_generations.stats.productExclusions` dal
 * worker (finalize) ed esposta dalla route `GET .../docs/brief` alla tab Brief della SPA per
 * l'ispezionabilità (title = pagina esclusa, fact = fatto/passaggio incriminato troncato).
 */
export const productExclusionSchema = z.object({
  title: z.string(),
  fact: z.string(),
});
export type ProductExclusion = z.infer<typeof productExclusionSchema>;

/**
 * Nodo dell'albero di NAVIGAZIONE della sezione Docs: quanto basta a
 * disegnare la sidebar. L'albero arriva PIATTO — la gerarchia si ricostruisce
 * da `parentId` — così il client sceglie da sé come renderlo.
 *
 * ⚠️ Da non confondere con {@link docTreeSchema}, che è l'albero di
 * APPARTENENZA di un nodo di GENERAZIONE (technical/functional/product): quello
 * riguarda come la documentazione viene prodotta, questo come viene sfogliata.
 */
export const docTreeNodeSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  parentId: z.uuid().nullable(),
  position: z.number().int(),
  sourcePath: z.string().nullable(),
  isManual: z.boolean(),
  createdAt: z.string(),
  viewCount: z.number().int(),
  // Solo per kind="releases": significatività della release; null altrove.
  significant: z.boolean().nullable(),
});
export type DocTreeNode = z.infer<typeof docTreeNodeSchema>;

/**
 * Un cross-link risolto di una pagina: il `type` raggruppa la relazione,
 * `slug`+`title` linkano la pagina target.
 */
export const docPageLinkSchema = z.object({
  type: z.enum(["implements", "implemented_by", "related"]),
  slug: z.string(),
  title: z.string(),
});
export type DocPageLink = z.infer<typeof docPageLinkSchema>;

/** Pagina completa di documentazione: corpo markdown più metadati. */
export const docPageSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  parentId: z.uuid().nullable(),
  position: z.number().int(),
  sourcePath: z.string().nullable(),
  body: z.string(),
  isManual: z.boolean(),
  // commitSha della generazione di appartenenza; null per le pagine manuali.
  commitSha: z.string().nullable(),
  // URL web del commit sul provider: null per le manuali, o se il repoUrl non è
  // parsabile (la UI mostra il solo sha).
  commitUrl: z.string().nullable(),
  // Cross-link risolti a fine generazione; null se non calcolati (manuali, o
  // generazioni del vecchio motore).
  links: z.array(docPageLinkSchema).nullable(),
  updatedAt: z.string(),
  createdAt: z.string(),
  viewCount: z.number().int(),
  significant: z.boolean().nullable(),
});
export type DocPage = z.infer<typeof docPageSchema>;

/**
 * Uno "spazio" dell'hub Docs: un repository che ha documentazione (almeno una
 * pagina della generazione corrente o manuale). `lastGenerationAt` e
 * `lastCommitSha` sono null finché non c'è una generazione corrente riuscita —
 * per esempio negli spazi con sole pagine manuali.
 */
export const docSpaceSchema = z.object({
  repositoryId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  pageCount: z.number().int(),
  lastGenerationAt: z.string().nullable(),
  lastCommitSha: z.string().nullable(),
});
export type DocSpace = z.infer<typeof docSpaceSchema>;

/** Una sessione della chat RAG sui Docs (per-repository o di progetto). */
export const docChatSessionSchema = z.object({ id: z.uuid(), createdAt: z.string() });
export type DocChatSession = z.infer<typeof docChatSessionSchema>;

/**
 * Un messaggio persistito di una sessione di chat sui Docs. `citations` è
 * `unknown` di proposito, ai due capi: è una colonna jsonb e il contratto non
 * ne stringe la forma — chi le usa se le valida.
 */
export const docChatMessageSchema = z.object({
  id: z.uuid(),
  role: z.string(),
  content: z.string(),
  citations: z.unknown().nullable(),
  createdAt: z.string(),
});
export type DocChatMessage = z.infer<typeof docChatMessageSchema>;

/**
 * Una fonte allegata a una risposta della chat RAG (una pagina di
 * documentazione citata). Rispecchia `Citation` di
 * `apps/server/src/routes/docs-rag.ts` — a differenza di
 * `docChatMessageSchema.citations` (jsonb non tipizzato, storico) questa è la
 * forma di una risposta 200 VERA (`docsChatAnswerSchema`), validata dal
 * serializerCompiler Zod: qui la stringiamo.
 */
export const docsChatSourceSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  repositoryId: z.uuid(),
  repositorySlug: z.string(),
  repositoryName: z.string(),
});
export type DocsChatSource = z.infer<typeof docsChatSourceSchema>;

/**
 * Risposta JSON non-streaming della chat RAG (`?stream=false`, fase 4 mobile):
 * usata dai client che non leggono SSE. Stesso contenuto della modalità
 * streaming — testo completo + fonti + sessionId, che nell'SSE arrivano
 * frammentati fra gli eventi `delta` e `done` — in un unico body. Condivisa
 * dalle tre chat RAG (Docs per-repository, Docs di progetto, raffinamento del
 * backlog): per il backlog `sessionId` è l'id della voce (non c'è una tabella
 * di sessioni dedicata, vedi `backlog.ts`).
 */
export const docsChatAnswerSchema = z.object({
  answer: z.string(),
  sources: z.array(docsChatSourceSchema),
  sessionId: z.uuid(),
});
export type DocsChatAnswer = z.infer<typeof docsChatAnswerSchema>;

// ---------------------------------------------------------------------------
// HIGHLIGHTS, BRIEF E RICERCA DI PROGETTO («la documentazione nell'app, come
// sul web», 25 set 2026). Erano scritti solo nel server — `docs-highlights.ts`,
// dentro la rotta del brief in `docs.ts`, `project-docs.ts` — e li legge ora
// anche l'app: spostati qui SENZA cambiarne la forma, le rotte li importano.
// ---------------------------------------------------------------------------

/** Riferimento leggero a una pagina in una lista di highlights. */
export const highlightRefSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  viewCount: z.number().int(),
});

/**
 * Riferimento a una release nel changelog: `createdAt` è la data della entry
 * (le release sono pagine persistenti create al push), `significant` la
 * significatività calcolata dal worker (null per le release pre-migrazione).
 * `commitSha` è quello della generazione di appartenenza: per le release, che
 * sono persistenti (generationId null), è sempre null — il commit si legge
 * dallo slug `release-YYYYMMDD-HHmm-<sha>`.
 */
export const releaseRefSchema = z.object({
  slug: z.string(),
  title: z.string(),
  createdAt: z.string(),
  significant: z.boolean().nullable(),
  commitSha: z.string().nullable(),
});

/** Tutti i kind, con conteggio: chiavi sempre presenti (0 se nessuna pagina). */
export const countsByKindSchema = z.object({
  technical: z.number().int(),
  functional: z.number().int(),
  product: z.number().int(),
  manual: z.number().int(),
  releases: z.number().int(),
});

/** Highlights di un singolo repository (overview di repo). */
export const repoHighlightsSchema = z.object({
  countsByKind: countsByKindSchema,
  topViewed: z.array(highlightRefSchema),
  recentlyUpdated: z.array(highlightRefSchema),
  latestReleases: z.array(releaseRefSchema),
});

/** Come {@link highlightRefSchema}, arricchito col repository d'origine. */
export const projectHighlightRefSchema = highlightRefSchema.extend({
  repositoryId: z.uuid(),
  repositorySlug: z.string(),
  repositoryName: z.string(),
});

/** Come {@link releaseRefSchema}, arricchito col repository d'origine. */
export const projectReleaseRefSchema = releaseRefSchema.extend({
  repositoryId: z.uuid(),
  repositorySlug: z.string(),
  repositoryName: z.string(),
});

/**
 * Riferimento a una DECISIONE nel registro di progetto (Fase 5), come compare
 * nella home Docs accanto a "Novità".
 *
 * Solo il necessario a orientarsi e a decidere se aprire la pagina completa:
 * chi ha deciso è un'email, non l'oggetto attore intero — nella home la riga è
 * una sola, e il resto sta in `/api/projects/:id/decisions`.
 */
export const decisionHighlightRefSchema = z.object({
  id: z.uuid(),
  // `decisionSourceSchema` (schemas/project.ts) e non una lista ripetuta: le
  // sorgenti crescono (la fase 6 ha aggiunto `email`) e una copia locale si
  // scopre disallineata solo quando la risposta non serializza più.
  source: decisionSourceSchema,
  title: z.string(),
  decision: z.string(),
  decidedByEmail: z.string().nullable(),
  decidedAt: z.string(),
  superseded: z.boolean(),
});

/** Highlights aggregate di progetto (changelog cross-repo + pagine top). */
export const projectHighlightsSchema = z.object({
  countsByKind: countsByKindSchema,
  topViewed: z.array(projectHighlightRefSchema),
  latestReleases: z.array(projectReleaseRefSchema),
  /**
   * Le ultime decisioni registrate sul progetto.
   *
   * `.optional()` come ogni campo nuovo di una risposta esistente: un client
   * compilato prima della fase 5 non lo conosce, e un server sceso di immagine
   * non lo produce. Chi lo legge tratta l'assenza come "nessuna decisione".
   */
  latestDecisions: z.array(decisionHighlightRefSchema).optional(),
});
export type RepoHighlights = z.infer<typeof repoHighlightsSchema>;
export type ProjectHighlights = z.infer<typeof projectHighlightsSchema>;

/**
 * Risposta di `GET /api/repositories/:id/docs/brief`: il brief della
 * generazione corrente (o, in mancanza, della più recente che ne ha uno), la
 * generazione da cui viene e le esclusioni della Fase C della STESSA
 * generazione. Prima era scritta dentro la rotta.
 */
export const docBriefResponseSchema = z.object({
  brief: projectBriefSchema,
  generation: z.object({
    createdAt: z.string(),
    commitSha: z.string().nullable(),
  }),
  productExclusions: z.array(productExclusionSchema),
});
export type DocBriefResponse = z.infer<typeof docBriefResponseSchema>;

/**
 * Un risultato della ricerca CROSS-REPO nei Docs di un progetto
 * (`GET /api/projects/:id/docs/search`): stesso shape della ricerca per-repo
 * (slug/title/kind/snippet/score/source) arricchito col repository d'origine.
 * Prima era `searchResultSchema`, locale a `project-docs.ts`.
 */
export const projectDocsSearchResultSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  snippet: z.string(),
  score: z.number(),
  source: z.enum(["semantic", "fulltext", "hybrid"]),
  repositoryId: z.uuid(),
  repositorySlug: z.string(),
  repositoryName: z.string(),
});
export type ProjectDocsSearchResult = z.infer<typeof projectDocsSearchResultSchema>;
