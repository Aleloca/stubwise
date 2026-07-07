/**
 * `@stubwise/docs-engine` — motore puro per la documentazione autogenerata.
 *
 * Logica deterministica e senza side-effect (niente fs/rete/db: il filesystem è un
 * `RepoReader` iniettato e l'agent AI è una `AgentFn` iniettata) per il motore a DAG
 * ricorsivo: orientamento → esplorazione → sintesi, con cross-link e proiezione in
 * pagine annidate. Tutta la logica AI usa un CONTRATTO A MARCATORI + validazione (mai
 * formato libero), parser per-riga robusti, e helper DAG puri (dedup, slug, link).
 *
 * Pubblici principali:
 *  - `recursive/*` — prompt + parser di orientamento/explore/synthesize (output
 *    machine-parsed) e gli helper DAG (`dedupeChildren`, `slugForNode`,
 *    `resolveImplementsLinks`, `selectRelatedLinks`);
 *  - `chunkMarkdown(md, opts)` — chunking markdown-aware (split per heading, target
 *    in token stimati, overlap) per l'embedding.
 *
 * La vecchia pipeline PIATTA (map-reduce + capability-pass: `buildRepoMap`,
 * `runGeneration`, i suoi prompt e i marcatori `===TECHNICAL===`/`===FUNCTIONAL===`/
 * `===CAPABILITY PAGE===`) è stata RIMOSSA, sostituita dal motore a DAG.
 */
export { chunkMarkdown, estimateTokens, TOKENS_PER_WORD } from "./chunk.js";
export type { MarkdownChunk, ChunkOptions } from "./chunk.js";

// ── Motore ricorsivo a DAG (contratto + parser dell'output strutturato) ───────────────
export {
  ORIENT_START_MARKER,
  ORIENT_END_MARKER,
  ORIENT_TECHNICAL_START_MARKER,
  ORIENT_TECHNICAL_END_MARKER,
  ORIENT_FUNCTIONAL_START_MARKER,
  ORIENT_FUNCTIONAL_END_MARKER,
  EXPLORE_BODY_START_MARKER,
  EXPLORE_BODY_END_MARKER,
  EXPLORE_CHILDREN_START_MARKER,
  EXPLORE_CHILDREN_END_MARKER,
  SOURCE_PATHS_START_MARKER,
  SOURCE_PATHS_END_MARKER,
  SYNTH_BODY_START_MARKER,
  SYNTH_BODY_END_MARKER,
  CHILD_FIELD_SEP,
  MIN_BODY_CHARS,
  parseChildList,
  parseChildBlock,
  parsePathList,
  extractBlock,
  validateBody,
} from "./recursive/contract.js";
export type {
  ChildSpec,
  ChildListResult,
  BodyRejection,
} from "./recursive/contract.js";

export { buildOrientPrompt, parseOrientPlan } from "./recursive/orient.js";
export type { OrientPlan } from "./recursive/orient.js";

export { buildExplorePrompt, parseExploreOutput } from "./recursive/explore.js";
export type {
  DocTree,
  ExploreInput,
  ExploreOutput,
  ExploreRejection,
} from "./recursive/explore.js";

export {
  buildSynthesizePrompt,
  parseSynthesisOutput,
} from "./recursive/synthesize.js";
export type {
  ChildSummary,
  SynthesizeInput,
} from "./recursive/synthesize.js";

export {
  pathCovers,
  dedupeChildren,
  slugForNode,
  resolveImplementsLinks,
  selectRelatedLinks,
  cosineSimilarity,
} from "./recursive/dag.js";
export type {
  DedupeResult,
  NodeTree,
  LinkableNode,
  LinkType,
  NodeLink,
  RelatedTarget,
  RelatedCandidate,
  SelectRelatedOptions,
} from "./recursive/dag.js";

export type { RepoFile, RepoReader } from "./fs.js";

// ── Auto-aggiornamento Docs (Fase 1): note di rilascio (changelog) ────────────────────
export {
  buildReleasePrompt,
  parseReleaseNotes,
  RELEASE_START_MARKER,
  RELEASE_END_MARKER,
  RELEASE_SLUGS_START_MARKER,
  RELEASE_SLUGS_END_MARKER,
  RELEASE_BODY_START_MARKER,
  RELEASE_BODY_END_MARKER,
} from "./releases.js";
export type { ReleaseInput, ReleaseNotes, ExistingPage } from "./releases.js";

// ── Auto-aggiornamento Docs (Fase 2): file cambiati → pagine impattate ────────────────
export { mapAffectedPages } from "./affected-pages.js";
export type { PageRef, AffectedPagesResult } from "./affected-pages.js";

// ── Auto-aggiornamento Docs (Fase 2): refresh mirato di una pagina ────────────────────
export {
  buildRefreshPagePrompt,
  parseRefreshedPage,
  REFRESH_NO_CHANGE_MARKER,
  REFRESH_UPDATED_START_MARKER,
  REFRESH_UPDATED_END_MARKER,
} from "./refresh-page.js";
export type { RefreshPageInput, RefreshedPage } from "./refresh-page.js";

// ── Auto-aggiornamento Docs (Fase 3): aggregazione aree nuove + mini-orient ───────────
export {
  aggregateNewAreas,
  buildGrowOrientPrompt,
  parseGrowOrientOutput,
  GROW_PROPOSAL_START_MARKER,
  GROW_PROPOSAL_END_MARKER,
} from "./grow.js";
export type {
  NewArea,
  AggregateOptions,
  GrowKind,
  GrowProposal,
  GrowExistingPage,
  GrowOrientInput,
} from "./grow.js";

// ── Brief + product (Fase A): contratto del project brief ─────────────────────────────
export {
  buildBriefPrompt,
  parseBriefOutput,
  briefPromptContext,
  BRIEF_IDENTITY_START_MARKER,
  BRIEF_IDENTITY_END_MARKER,
  BRIEF_ACTORS_START_MARKER,
  BRIEF_ACTORS_END_MARKER,
  BRIEF_SURFACES_START_MARKER,
  BRIEF_SURFACES_END_MARKER,
  BRIEF_GLOSSARY_START_MARKER,
  BRIEF_GLOSSARY_END_MARKER,
  BRIEF_INVARIANTS_START_MARKER,
  BRIEF_INVARIANTS_END_MARKER,
  BRIEF_CONFIDENTIAL_START_MARKER,
  BRIEF_CONFIDENTIAL_END_MARKER,
  BRIEF_JOURNEYS_START_MARKER,
  BRIEF_JOURNEYS_END_MARKER,
  BRIEF_SOURCES_START_MARKER,
  BRIEF_SOURCES_END_MARKER,
  BRIEF_FIELD_SEP,
} from "./brief.js";
export type {
  ProjectBrief,
  BriefActor,
  BriefSurface,
  BriefGlossaryEntry,
  BriefConfidentialFact,
  BriefJourney,
  BuildBriefPromptInput,
  BriefContextOptions,
} from "./brief.js";

// ── Brief + product (Fase B): contratti delle verticali product ───────────────────────
export {
  buildProductRootPrompt,
  buildProductGuidePrompt,
  buildProductFaqPrompt,
  parseProductPageOutput,
  parseProductGuideOutput,
  PRODUCT_PAGE_START_MARKER,
  PRODUCT_PAGE_END_MARKER,
  PRODUCT_SKIP_MARKER,
} from "./product.js";
export type {
  ProductPromptInput,
  ProductGuideRejection,
} from "./product.js";
