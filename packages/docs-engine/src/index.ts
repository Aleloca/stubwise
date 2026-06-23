/**
 * `@stubwise/docs-engine` — motore puro per la documentazione autogenerata.
 *
 * Logica deterministica e senza side-effect (niente fs/rete/db: il filesystem è un
 * `RepoReader` iniettato e l'agent AI è una `AgentFn` iniettata) per generare, da un
 * repository, una documentazione tecnica + funzionale tramite map-reduce.
 *
 * Tre passi pubblici:
 *  - `buildRepoMap(reader, opts)` — pass strutturale: linguaggi, moduli (manifest,
 *    superficie pubblica, dipendenze) e cose escluse/tagliate → `RepoMap`;
 *  - `runGeneration({ repoMap, agent, … })` — orchestrazione map-reduce + deep pass:
 *    una pagina tecnica per modulo + overview, la mappa funzionale (indice), e una
 *    pagina funzionale PROFONDA per capability (deep pass per-capability, linguaggio
 *    non tecnico), best-effort sui fallimenti per-modulo e per-capability →
 *    `GeneratedPage[]` + `moduleFailures` + `capabilityFailures` + `cappedCapabilities`;
 *  - `chunkMarkdown(md, opts)` — chunking markdown-aware (split per heading, target
 *    in token stimati, overlap) per l'embedding.
 */
export { buildRepoMap } from "./structural.js";
export type { BuildRepoMapOptions } from "./structural.js";

export {
  runGeneration,
  buildModulePrompt,
  buildReducePrompt,
  buildCapabilityPrompt,
  TECHNICAL_MARKER,
  FUNCTIONAL_MARKER,
  CAPABILITY_START_MARKER,
  CAPABILITY_END_MARKER,
} from "./generate.js";
export type {
  ModuleDoc,
  CapabilitySummary,
  GeneratedPage,
  AgentFn,
  GenerationLimits,
  RunGenerationInput,
  RunGenerationResult,
} from "./generate.js";

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
export type { RepoMap, ModuleNode } from "./types.js";
