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
 *  - `runGeneration({ repoMap, agent, … })` — orchestrazione map-reduce: una pagina
 *    tecnica per modulo + overview, più una mappa funzionale delle capability,
 *    best-effort sui fallimenti per-modulo → `GeneratedPage[]` + `moduleFailures`;
 *  - `chunkMarkdown(md, opts)` — chunking markdown-aware (split per heading, target
 *    in token stimati, overlap) per l'embedding.
 */
export { buildRepoMap } from "./structural.js";
export type { BuildRepoMapOptions } from "./structural.js";

export {
  runGeneration,
  buildModulePrompt,
  buildReducePrompt,
  TECHNICAL_MARKER,
  FUNCTIONAL_MARKER,
} from "./generate.js";
export type {
  ModuleDoc,
  GeneratedPage,
  AgentFn,
  GenerationLimits,
  RunGenerationInput,
  RunGenerationResult,
} from "./generate.js";

export { chunkMarkdown, estimateTokens, TOKENS_PER_WORD } from "./chunk.js";
export type { MarkdownChunk, ChunkOptions } from "./chunk.js";

export type { RepoFile, RepoReader } from "./fs.js";
export type { RepoMap, ModuleNode } from "./types.js";
