/**
 * Orchestrazione map-reduce di `@stubwise/docs-engine`: da un `RepoMap` a un
 * albero di `GeneratedPage` (tecniche + funzionali), tramite un agent AI iniettato.
 *
 * Logica PURA: l'unica dipendenza esterna è la funzione `AgentFn` passata da chi
 * chiama (nel worker l'agent Claude reale, nei test un fake). Niente fs/rete/db.
 *
 * Pipeline:
 *  1. MAP — per ogni modulo entro budget: `agent(buildModulePrompt(...))`, poi si
 *     parsa la risposta in un `ModuleDoc`. Un modulo che fa throw O la cui risposta
 *     non è parsabile è BEST-EFFORT: il suo path finisce in `moduleFailures`, la sua
 *     pagina viene saltata e la generazione prosegue.
 *  2. REDUCE — una sola chiamata `agent(buildReducePrompt(moduleDocs))` che sintetizza
 *     (a) una panoramica tecnica dell'architettura e (b) una mappa funzionale delle
 *     capability.
 *  3. COMPOSE — si compongono le `GeneratedPage`: una pagina tecnica di overview
 *     (root, `parentSlug: null`), una pagina tecnica per modulo riuscito
 *     (`parentSlug` = slug overview, `sourcePath` = path modulo) e una o più pagine
 *     funzionali derivate dalla mappa delle capability.
 *
 * CONTRATTO DI PARSING (map e reduce). L'output dell'agent DEVE contenere due
 * sezioni delimitate da marker testuali stabili su riga propria:
 *
 *     ===TECHNICAL===
 *     <markdown tecnico>
 *     ===FUNCTIONAL===
 *     <markdown funzionale>
 *
 * Il parser (`parseSections`) è deterministico: trova `TECHNICAL_MARKER`, poi
 * `FUNCTIONAL_MARKER`; il testo tra i due è la sezione tecnica, quello dopo il
 * secondo marker è la sezione funzionale. Se manca uno dei marker o una delle due
 * sezioni risulta vuota, il parse FALLISCE (→ `moduleFailures` nel map; nel reduce
 * si fa fallback a sezioni vuote, vedi `runGeneration`). I marker sono volutamente
 * improbabili nel markdown normale per ridurre i falsi delimitatori.
 */
import type { ModuleNode, RepoMap } from "./types.js";

export type { RepoMap, ModuleNode } from "./types.js";

/** Marker che delimita l'inizio della sezione tecnica nell'output dell'agent. */
export const TECHNICAL_MARKER = "===TECHNICAL===";
/** Marker che delimita l'inizio della sezione funzionale nell'output dell'agent. */
export const FUNCTIONAL_MARKER = "===FUNCTIONAL===";

/** Documentazione (tecnica + funzionale) prodotta dal map per un singolo modulo. */
export interface ModuleDoc {
  modulePath: string;
  technicalMarkdown: string;
  functionalMarkdown: string;
}

/** Una pagina di documentazione composta dall'orchestrazione (pronta da persistere). */
export interface GeneratedPage {
  kind: "technical" | "functional";
  /** Slug stabile e univoco all'interno della generazione. */
  slug: string;
  title: string;
  /** Slug della pagina padre, o `null` per le pagine root. */
  parentSlug: string | null;
  /** Path del modulo sorgente (solo pagine tecniche di modulo), altrimenti `null`. */
  sourcePath: string | null;
  body: string;
}

/** Funzione agent iniettata: dato un prompt (e cwd opzionale) ritorna testo. */
export type AgentFn = (input: {
  prompt: string;
  cwd?: string;
}) => Promise<string>;

/** Limiti opzionali per la generazione. */
export interface GenerationLimits {
  /** Numero massimo di moduli da mappare (default: tutti quelli nel `RepoMap`). */
  maxModules?: number;
}

export interface RunGenerationInput {
  repoMap: RepoMap;
  agent: AgentFn;
  limits?: GenerationLimits;
  /** Callback di avanzamento (usata dal worker per l'heartbeat). */
  onProgress?: (msg: string) => void;
  /** cwd opzionale propagato all'agent (es. directory del worktree). */
  cwd?: string;
}

export interface RunGenerationResult {
  pages: GeneratedPage[];
  /** Path dei moduli falliti (agent in errore o output non parsabile). */
  moduleFailures: string[];
}

/** Slug della pagina root con la panoramica tecnica dell'architettura. */
const OVERVIEW_SLUG = "overview";
/** Slug della pagina root con la mappa funzionale delle capability. */
const CAPABILITIES_SLUG = "capabilities";

/** Numero massimo di file elencati nel prompt per modulo (evita prompt enormi). */
const MAX_FILES_IN_PROMPT = 60;

/**
 * Costruisce il prompt di MAP per un modulo. Include path, manifest, file,
 * superficie pubblica e dipendenze, e istruisce a produrre due sezioni delimitate
 * dai marker del contratto di parsing.
 */
export function buildModulePrompt(module: ModuleNode, repoMap: RepoMap): string {
  const files = module.files.slice(0, MAX_FILES_IN_PROMPT);
  const omitted = module.files.length - files.length;
  const langs = Object.entries(repoMap.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, n]) => `${ext} (${n})`)
    .join(", ");

  return [
    "You are documenting a single module of a software repository.",
    "Analyse ONLY the module described below, reading its files in the working directory.",
    "",
    `Module path: ${module.path}`,
    `Dominant language: ${module.language ?? "unknown"}`,
    `Manifest: ${module.manifest ?? "none"}`,
    `Public surface: ${module.publicSurface.join(", ") || "none detected"}`,
    `Depends on modules: ${module.dependsOn.join(", ") || "none detected"}`,
    "",
    "Files in this module:",
    ...files.map((f) => `- ${f}`),
    omitted > 0 ? `…and ${omitted} more file(s) omitted from this list.` : "",
    "",
    `Repository languages: ${langs || "unknown"}`,
    "",
    "Produce TWO sections, each introduced by its marker ALONE on its own line.",
    "Do not add anything before the first marker or between a marker and its section.",
    "",
    `${TECHNICAL_MARKER}`,
    "Technical documentation for developers: responsibilities, key files, public",
    "API/surface, data flow, important implementation details, and how this module",
    "relates to the modules it depends on. Use markdown with headings.",
    "",
    `${FUNCTIONAL_MARKER}`,
    "Functional documentation for non-developers: what business capabilities this",
    "module enables, described in plain language. Use markdown with headings.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Costruisce il prompt di REDUCE a partire dai `ModuleDoc` riusciti. Istruisce la
 * sintesi di (a) una panoramica tecnica dell'architettura e (b) una mappa
 * funzionale delle capability, con lo stesso contratto a due sezioni.
 */
export function buildReducePrompt(moduleDocs: ModuleDoc[]): string {
  const summaries = moduleDocs.map((d) =>
    [
      `### Module: ${d.modulePath}`,
      "Technical:",
      d.technicalMarkdown.trim(),
      "Functional:",
      d.functionalMarkdown.trim(),
    ].join("\n"),
  );

  return [
    "REDUCE step: synthesise repository-wide documentation from the per-module",
    "documentation below. Do NOT simply concatenate; produce a coherent synthesis.",
    "",
    "Produce TWO sections, each introduced by its marker ALONE on its own line.",
    "",
    `${TECHNICAL_MARKER}`,
    "A technical architecture overview for developers: the big picture, how the",
    "modules fit together, the main data/control flows and cross-cutting concerns.",
    "Use markdown with headings.",
    "",
    `${FUNCTIONAL_MARKER}`,
    "A functional capability map for non-developers. Organise it as one '## Capability:'",
    "heading per distinct business capability, each followed by a plain-language",
    "description. Use markdown.",
    "",
    "Per-module documentation to synthesise:",
    "",
    ...summaries,
  ].join("\n");
}

/**
 * Parsa l'output dell'agent secondo il contratto a due marker. Ritorna `null` se
 * uno dei marker manca o una delle due sezioni è vuota (output non parsabile).
 */
function parseSections(
  output: string,
): { technical: string; functional: string } | null {
  const techIdx = output.indexOf(TECHNICAL_MARKER);
  const funcIdx = output.indexOf(FUNCTIONAL_MARKER);
  if (techIdx === -1 || funcIdx === -1 || funcIdx <= techIdx) return null;
  const technical = output
    .slice(techIdx + TECHNICAL_MARKER.length, funcIdx)
    .trim();
  const functional = output.slice(funcIdx + FUNCTIONAL_MARKER.length).trim();
  if (technical === "" || functional === "") return null;
  return { technical, functional };
}

/** Trasforma un path di modulo in uno slug base (kebab, ascii-safe). */
function baseSlug(modulePath: string): string {
  const slug = modulePath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "module";
}

/**
 * Genera slug stabili e univoci. Lo slug base deriva deterministicamente dal path;
 * in caso di collisione si appende un suffisso numerico crescente (`-2`, `-3`, …),
 * sempre deterministico a parità di ordine d'ingresso.
 */
function makeUniqueSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  const slug = `${base}-${n}`;
  used.add(slug);
  return slug;
}

/** Titolo leggibile per la pagina di un modulo (ultimo segmento del path). */
function moduleTitle(modulePath: string): string {
  const segs = modulePath.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? modulePath;
}

/**
 * Spezza il markdown della mappa funzionale in una pagina per ogni heading
 * `## Capability: <nome>`. Se non ne trova nessuna, ritorna una singola pagina con
 * l'intero corpo. Restituisce `{ title, body }` senza slug (assegnato dal chiamante).
 */
function splitCapabilities(
  functionalMarkdown: string,
): { title: string; body: string }[] {
  const lines = functionalMarkdown.split("\n");
  const re = /^##\s+Capability:\s*(.+?)\s*$/i;
  const sections: { title: string; body: string[] }[] = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (m) {
      sections.push({ title: m[1]!.trim(), body: [line] });
    } else if (sections.length > 0) {
      sections[sections.length - 1]!.body.push(line);
    }
    // righe prima della prima capability (preambolo) sono ignorate: la pagina
    // funzionale root porta comunque l'intera mappa.
  }
  if (sections.length === 0) {
    return [{ title: "Capabilities", body: functionalMarkdown.trim() }];
  }
  return sections.map((s) => ({
    title: s.title || "Capability",
    body: s.body.join("\n").trim(),
  }));
}

/**
 * Esegue la generazione map-reduce. Vedi il doc-header del modulo per il contratto
 * di parsing e la semantica best-effort.
 */
export async function runGeneration(
  input: RunGenerationInput,
): Promise<RunGenerationResult> {
  const { repoMap, agent, limits, onProgress, cwd } = input;
  const max = limits?.maxModules ?? repoMap.modules.length;
  const modules = repoMap.modules.slice(0, max);

  const moduleDocs: ModuleDoc[] = [];
  const moduleFailures: string[] = [];

  // MAP (best-effort, sequenziale per heartbeat ordinato)
  for (let i = 0; i < modules.length; i += 1) {
    const module = modules[i]!;
    onProgress?.(`map ${i + 1}/${modules.length}: ${module.path}`);
    try {
      const out = await agent({
        prompt: buildModulePrompt(module, repoMap),
        cwd,
      });
      const parsed = parseSections(out);
      if (!parsed) {
        moduleFailures.push(module.path);
        continue;
      }
      moduleDocs.push({
        modulePath: module.path,
        technicalMarkdown: parsed.technical,
        functionalMarkdown: parsed.functional,
      });
    } catch {
      moduleFailures.push(module.path);
    }
  }

  // REDUCE (una sola chiamata)
  onProgress?.("reduce: synthesising overview + capability map");
  let overviewBody = "";
  let capabilitiesMarkdown = "";
  try {
    const out = await agent({ prompt: buildReducePrompt(moduleDocs), cwd });
    const parsed = parseSections(out);
    if (parsed) {
      overviewBody = parsed.technical;
      capabilitiesMarkdown = parsed.functional;
    }
  } catch {
    // best-effort: reduce fallito → overview/capabilities vuoti, le pagine di
    // modulo restano comunque disponibili.
  }
  onProgress?.("reduce: done");

  // COMPOSE
  const used = new Set<string>();
  const pages: GeneratedPage[] = [];

  // Overview tecnica (root)
  used.add(OVERVIEW_SLUG);
  pages.push({
    kind: "technical",
    slug: OVERVIEW_SLUG,
    title: "Architecture Overview",
    parentSlug: null,
    sourcePath: null,
    body: overviewBody,
  });

  // Pagine tecniche per modulo (figlie dell'overview)
  for (const doc of moduleDocs) {
    const slug = makeUniqueSlug(baseSlug(doc.modulePath), used);
    pages.push({
      kind: "technical",
      slug,
      title: moduleTitle(doc.modulePath),
      parentSlug: OVERVIEW_SLUG,
      sourcePath: doc.modulePath,
      body: doc.technicalMarkdown,
    });
  }

  // Pagina funzionale root (mappa capability) + figlie per capability
  used.add(CAPABILITIES_SLUG);
  pages.push({
    kind: "functional",
    slug: CAPABILITIES_SLUG,
    title: "Capability Map",
    parentSlug: null,
    sourcePath: null,
    body: capabilitiesMarkdown,
  });

  if (capabilitiesMarkdown.trim() !== "") {
    for (const cap of splitCapabilities(capabilitiesMarkdown)) {
      const slug = makeUniqueSlug(baseSlug(cap.title), used);
      pages.push({
        kind: "functional",
        slug,
        title: cap.title,
        parentSlug: CAPABILITIES_SLUG,
        sourcePath: null,
        body: cap.body,
      });
    }
  }

  return { pages, moduleFailures };
}
