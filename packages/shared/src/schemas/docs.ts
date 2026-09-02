import { z } from "zod";

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
