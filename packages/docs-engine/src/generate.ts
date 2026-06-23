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
 *     capability (l'INDICE: una voce `## Capability:` per capability con descrizione
 *     breve).
 *  3. CAPABILITY DEEP PASS — per ogni capability dell'indice (entro budget
 *     `maxCapabilities`) una chiamata dedicata `agent(buildCapabilityPrompt(...))` che
 *     scrive una pagina funzionale PROFONDA in linguaggio NON tecnico (come la pagina
 *     tecnica di modulo è profonda, ma tradotta in termini di prodotto). È così che le
 *     pagine funzionali smettono di essere un solo paragrafo derivato dall'indice e
 *     diventano esaustive. BEST-EFFORT: se l'agent fa throw o ritorna output
 *     vuoto/troppo corto, si fa FALLBACK alla descrizione breve dell'indice e la
 *     capability finisce in `capabilityFailures`. Le capability oltre il budget NON
 *     vengono silenziosamente scartate: sono LOGGATE in `cappedCapabilities`.
 *  4. COMPOSE — si compongono le `GeneratedPage`: una pagina tecnica di overview
 *     (root, `parentSlug: null`), una pagina tecnica per modulo riuscito
 *     (`parentSlug` = slug overview, `sourcePath` = path modulo), la mappa funzionale
 *     root (l'indice del reduce, `parentSlug: null`) e una pagina funzionale per
 *     capability con il CORPO PROFONDO del deep pass (o il fallback dell'indice).
 *
 * CONTRATTO DI PARSING (map e reduce). L'output dell'agent DEVE contenere due
 * sezioni delimitate da marker testuali stabili su riga propria:
 *
 *     ===TECHNICAL===
 *     <markdown tecnico>
 *     ===FUNCTIONAL===
 *     <markdown funzionale>
 *
 * Il parser (`parseSections`) è deterministico: i marker sono riconosciuti SOLO
 * come riga intera (la riga, trimmata, è esattamente il marker), così un marker a
 * metà riga o dentro un fenced code block non è un delimitatore; trova la prima
 * riga `TECHNICAL_MARKER`, poi la prima `FUNCTIONAL_MARKER`; il testo tra i due è la
 * sezione tecnica, quello dopo il secondo marker è la sezione funzionale. Se manca
 * uno dei marker, sono fuori ordine, o una delle due sezioni risulta vuota, il parse
 * FALLISCE (→ `moduleFailures` nel map; nel reduce si fa fallback a sezioni vuote,
 * vedi `runGeneration`). I marker sono volutamente improbabili nel markdown normale
 * per ridurre i falsi delimitatori.
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
  /**
   * Numero massimo di capability documentate in profondità nel deep pass (default
   * `DEFAULT_MAX_CAPABILITIES`). Le capability oltre il budget non sono scartate in
   * silenzio: i loro titoli finiscono in `cappedCapabilities`.
   */
  maxCapabilities?: number;
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
  /**
   * Titoli delle capability il cui deep pass è fallito (agent in errore o output
   * vuoto/troppo corto): la pagina esiste comunque, ma col solo testo dell'indice.
   */
  capabilityFailures: string[];
  /**
   * Titoli delle capability tagliate dal budget `maxCapabilities` (non documentate
   * in profondità). Loggate qui, mai scartate in silenzio.
   */
  cappedCapabilities: string[];
}

/** Slug della pagina root con la panoramica tecnica dell'architettura. */
const OVERVIEW_SLUG = "overview";
/** Slug della pagina root con la mappa funzionale delle capability. */
const CAPABILITIES_SLUG = "capabilities";

/** Numero massimo di file elencati nel prompt per modulo (evita prompt enormi). */
const MAX_FILES_IN_PROMPT = 60;

/**
 * Budget di default delle capability documentate in profondità nel deep pass
 * (override via `limits.maxCapabilities`). Mirroring del cap dei moduli: protegge
 * da repo con moltissime capability (un run dell'agente per capability).
 */
const DEFAULT_MAX_CAPABILITIES = 40;

/**
 * Guardia anti-output-VUOTO del deep pass: un output che, una volta trimmato, è più
 * corto di questa soglia è trattato come vuoto/degenere (whitespace o quasi) e si fa
 * fallback al testo breve dell'indice. NON è un gate di qualità/profondità: non giudica
 * il contenuto, serve solo a non sostituire la descrizione della mappa con il nulla.
 */
const MIN_CAPABILITY_BODY_CHARS = 80;

/**
 * Numero massimo di sintesi funzionali di modulo incluse (e loro lunghezza) nel
 * prompt di una capability, per dare all'agent il contesto di "dove vive nel
 * prodotto" senza far esplodere il prompt.
 */
const MAX_MODULE_HINTS_IN_CAPABILITY_PROMPT = 40;
const MAX_MODULE_HINT_CHARS = 600;

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

/** Una capability dell'indice funzionale: titolo + descrizione breve dal reduce. */
export interface CapabilitySummary {
  title: string;
  summary: string;
}

/**
 * Costruisce il prompt del DEEP PASS per una singola capability. A differenza del map
 * (che produce una sezione funzionale breve per modulo) qui si chiede UNA INTERA
 * PAGINA funzionale PROFONDA su questa capability/blocco, in LINGUAGGIO NON TECNICO.
 *
 * Il prompt è VOLUTAMENTE forte sui tre requisiti centrali: (1) linguaggio semplice e
 * orientato al prodotto/utente, ZERO gergo tecnico (niente nomi di file, funzioni,
 * classi, framework, identificatori di codice); (2) enumerazione ESAUSTIVA di tutto
 * ciò che l'utente può fare nel blocco (azioni, opzioni, varianti, configurazioni, ciò
 * che è possibile E ciò che non lo è, passi, input/scelte, vincoli/limiti);
 * (3) GROUNDING nel codice — l'agent gira read-only nel worktree e DEVE esplorare il
 * codice rilevante per essere accurato ed esaustivo, ma TRADUCE sempre in linguaggio
 * semplice, senza MAI esporre dettaglio tecnico.
 *
 * L'output è UN solo corpo markdown (nessun marker macchina). NON deve iniziare con un
 * titolo di pagina (`#`/`##`): il titolo della pagina è reso a parte dalla UI, un heading
 * `# <titolo>` qui lo duplicherebbe. Il corpo inizia direttamente con il contenuto / le
 * sezioni `###`, che danno la profondità come nelle altre pagine.
 */
export function buildCapabilityPrompt(
  capability: CapabilitySummary,
  moduleDocs: ModuleDoc[],
): string {
  const hints = moduleDocs
    .slice(0, MAX_MODULE_HINTS_IN_CAPABILITY_PROMPT)
    .map((d) => {
      const text = d.functionalMarkdown.trim().slice(0, MAX_MODULE_HINT_CHARS);
      // Etichetta amichevole = ultimo segmento del path (vedi moduleTitle), NON il
      // path completo: l'orientamento resta, ma non si passa al modello una stringa
      // a forma di identificatore/path (riduce il leak di dettaglio tecnico).
      return `- ${moduleTitle(d.modulePath)}: ${text}`;
    });

  return [
    "You are writing ONE complete, DEEP page of FUNCTIONAL documentation about a",
    "single product capability (a single feature area / block of the product).",
    "",
    `Capability title: ${capability.title}`,
    `Brief description (from the capability map): ${capability.summary.trim() || "(none)"}`,
    "",
    "ABSOLUTE LANGUAGE RULE — this is the most important instruction, do not violate it:",
    "Write in PLAIN, NON-TECHNICAL language, for a business/product reader who does NOT",
    "read code. NEVER mention or expose any technical detail: no file paths, no function,",
    "class, variable, table, endpoint or module NAMES, no code identifiers, no framework",
    "or library names, no programming jargon. If you discover such things in the code,",
    "TRANSLATE them into what they MEAN for the user in business/product terms. A reader",
    "must be able to understand everything without knowing a single line of code.",
    "",
    "BE EXHAUSTIVE — enumerate EVERYTHING a user can do in this block:",
    "- every action, operation and task available here;",
    "- every option, variant, mode and configuration, and the choices/inputs each needs;",
    "- what is POSSIBLE here AND, explicitly, what is NOT possible (limits, things you",
    "  cannot do, edge cases that are blocked);",
    "- for each thing, describe the STEPS in words (how a user would actually do it),",
    "  the inputs/choices involved, and the constraints, rules and limits that apply.",
    "",
    "GROUND IT IN THE REAL BEHAVIOUR — you are running read-only in the repository",
    "working directory. INSPECT the relevant code to be accurate and exhaustive about",
    "what the product ACTUALLY does (do not invent features, do not omit real ones), but",
    "TRANSLATE every finding into plain product language as required above. Never leak the",
    "technical detail you read; only its meaning for the user.",
    "",
    "DEPTH — aim for coverage comparable to a thorough technical reference, but functional:",
    "use MULTIPLE `###` sub-sections (e.g. one per group of actions / per option area),",
    "not a single paragraph. Be thorough and concrete.",
    "",
    "Do NOT start the page with a top-level page title (`#` or `##` heading repeating the",
    "capability name): the page title is rendered separately by the UI and would be",
    "duplicated. Start DIRECTLY with the content, using `###` sub-sections for structure.",
    "Output ONLY the markdown body of the page (no preamble, no markers, no code fences",
    "around the whole document).",
    "",
    "For orientation, here are brief functional summaries of the product's areas (use them",
    "only to locate where this capability lives — do NOT copy their wording, and still",
    "obey the plain-language rule):",
    "",
    ...(hints.length > 0 ? hints : ["- (no module summaries available)"]),
  ].join("\n");
}

/**
 * Parsa l'output dell'agent secondo il contratto a due marker. I marker sono
 * riconosciuti solo come RIGA INTERA (la riga, una volta trimmata, è ESATTAMENTE
 * il marker), come dice il contratto ("marker ALONE on its own line"): un marker
 * che compare a metà riga o dentro un fenced code block NON è un delimitatore.
 * Si usa la PRIMA riga-marker di ciascun tipo. Ritorna `null` se uno dei marker
 * manca, sono fuori ordine, o una delle due sezioni è vuota (output non parsabile).
 */
function parseSections(
  output: string,
): { technical: string; functional: string } | null {
  const lines = output.split("\n");
  const techLine = lines.findIndex((l) => l.trim() === TECHNICAL_MARKER);
  const funcLine = lines.findIndex((l) => l.trim() === FUNCTIONAL_MARKER);
  if (techLine === -1 || funcLine === -1 || funcLine <= techLine) return null;
  const technical = lines.slice(techLine + 1, funcLine).join("\n").trim();
  const functional = lines.slice(funcLine + 1).join("\n").trim();
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

/** Una capability estratta dall'indice: titolo e descrizione breve (senza heading). */
interface ParsedCapability {
  /** Titolo del blocco `## Capability: <nome>`. */
  title: string;
  /**
   * Testo SOTTO l'heading `## Capability: <title>`, SENZA la riga di heading: la
   * descrizione breve dell'indice. Usato come grounding del deep pass e come corpo di
   * FALLBACK della pagina funzionale (l'heading è escluso apposta: il titolo della
   * pagina è reso a parte dalla UI e un heading qui lo duplicherebbe).
   */
  summary: string;
}

/**
 * Spezza il markdown della mappa funzionale in una capability per ogni heading
 * `## Capability: <nome>`. Se non ne trova nessuna, ritorna una singola capability con
 * l'intero corpo come `summary`. Restituisce `{ title, summary }` (in ordine
 * d'apparizione) senza slug (assegnato dal chiamante).
 */
function splitCapabilities(functionalMarkdown: string): ParsedCapability[] {
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
    return [{ title: "Capabilities", summary: functionalMarkdown.trim() }];
  }
  return sections.map((s) => ({
    title: s.title || "Capability",
    // summary = corpo senza la riga di heading (la prima).
    summary: s.body.slice(1).join("\n").trim(),
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

  // Pagina funzionale root (mappa capability = INDICE, invariata)
  used.add(CAPABILITIES_SLUG);
  pages.push({
    kind: "functional",
    slug: CAPABILITIES_SLUG,
    title: "Capability Map",
    parentSlug: null,
    sourcePath: null,
    body: capabilitiesMarkdown,
  });

  // CAPABILITY DEEP PASS: una pagina funzionale PROFONDA per capability (entro budget).
  const capabilityFailures: string[] = [];
  const cappedCapabilities: string[] = [];

  if (capabilitiesMarkdown.trim() !== "") {
    const allCaps = splitCapabilities(capabilitiesMarkdown);
    const maxCapabilities = limits?.maxCapabilities ?? DEFAULT_MAX_CAPABILITIES;
    const caps = allCaps.slice(0, Math.max(0, maxCapabilities));
    // Capability oltre il budget: LOGGATE (mai scartate in silenzio), pattern del
    // cap dei moduli. Restano comunque nella mappa root (l'indice le elenca tutte).
    for (const over of allCaps.slice(caps.length)) cappedCapabilities.push(over.title);

    for (let i = 0; i < caps.length; i += 1) {
      const cap = caps[i]!;
      const slug = makeUniqueSlug(baseSlug(cap.title), used);
      // fallback = SOLO la descrizione breve dell'indice (senza la riga di heading
      // `## Capability: <title>`): il titolo della pagina è reso a parte dalla UI, e
      // includere l'heading qui lo duplicherebbe. Garantisce comunque un corpo sempre
      // presente anche se il deep pass non produce output valido.
      let body = cap.summary;
      onProgress?.(`capability ${i + 1}/${caps.length}: ${cap.title}`);
      try {
        const out = await agent({
          prompt: buildCapabilityPrompt(
            { title: cap.title, summary: cap.summary },
            moduleDocs,
          ),
          cwd,
        });
        const deep = out.trim();
        if (deep.length >= MIN_CAPABILITY_BODY_CHARS) {
          body = deep;
        } else {
          capabilityFailures.push(cap.title);
        }
      } catch {
        // best-effort: deep pass fallito → si tiene il fallback dell'indice.
        capabilityFailures.push(cap.title);
      }
      onProgress?.(`capability ${i + 1}/${caps.length}: ${cap.title} done`);
      pages.push({
        kind: "functional",
        slug,
        title: cap.title,
        parentSlug: CAPABILITIES_SLUG,
        sourcePath: null,
        body,
      });
    }
  }

  return { pages, moduleFailures, capabilityFailures, cappedCapabilities };
}
