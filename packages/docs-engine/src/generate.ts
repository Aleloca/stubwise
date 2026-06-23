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
 *     diventano esaustive. L'output OBBEDISCE A UN CONTRATTO A MARCATORI come il map/reduce
 *     (vedi sotto): il corpo va RACCHIUSO tra `CAPABILITY_START_MARKER` e
 *     `CAPABILITY_END_MARKER`, ciascuno solo sulla propria riga. Il corpo estratto è poi
 *     VALIDATO (marker presenti e non vuoti, lunghezza ≥ `MIN_CAPABILITY_BODY_CHARS`,
 *     nessuna meta-summary che matcha `META_SUMMARY_RE`). Se la prima chiamata è INVALIDA
 *     si RIPROVA UNA volta; se anche il retry è invalido si fa FALLBACK alla descrizione
 *     breve dell'indice e la capability finisce in `capabilityFailures`. Estrarre tra i
 *     marker scarta naturalmente preamboli/chiusure che l'agent emette FUORI dai marker,
 *     così le meta-summary ("the documentation page is saved…", "I now have…") non
 *     finiscono mai pubblicate. Le capability oltre il budget NON vengono silenziosamente
 *     scartate: sono LOGGATE in `cappedCapabilities`.
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
 *
 * CONTRATTO DI PARSING (deep pass funzionale). Stessa filosofia a marcatori, ma con
 * UN solo blocco delimitato da una coppia start/end, ciascuno su riga propria:
 *
 *     ===CAPABILITY PAGE===
 *     <markdown del corpo pagina>
 *     ===END CAPABILITY PAGE===
 *
 * `parseDelimitedBody` (line-based, MAI substring/indexOf) estrae il testo tra la prima
 * riga-`CAPABILITY_START_MARKER` e la prima riga-`CAPABILITY_END_MARKER` successiva.
 * Estrarre tra i marker scarta naturalmente qualunque preambolo prima dello start o
 * chiusura dopo l'end. Il corpo estratto è poi VALIDATO (`isMetaSummary`/lunghezza in
 * `runGeneration`): marker mancanti/corpo vuoto, troppo corto, o che matcha
 * `META_SUMMARY_RE` ⇒ INVALIDO ⇒ retry una volta, poi fallback all'indice.
 */
import type { ModuleNode, RepoMap } from "./types.js";

export type { RepoMap, ModuleNode } from "./types.js";

/** Marker che delimita l'inizio della sezione tecnica nell'output dell'agent. */
export const TECHNICAL_MARKER = "===TECHNICAL===";
/** Marker che delimita l'inizio della sezione funzionale nell'output dell'agent. */
export const FUNCTIONAL_MARKER = "===FUNCTIONAL===";

/**
 * Marker che apre il corpo della pagina nel deep pass funzionale. L'INTERA risposta
 * dell'agent deve contenere il corpo TRA questo marker e `CAPABILITY_END_MARKER`,
 * ciascuno solo sulla propria riga; tutto ciò che è fuori dai marker viene ignorato.
 */
export const CAPABILITY_START_MARKER = "===CAPABILITY PAGE===";
/** Marker che chiude il corpo della pagina nel deep pass funzionale. */
export const CAPABILITY_END_MARKER = "===END CAPABILITY PAGE===";

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
   * Capability il cui deep pass è fallito, ciascuna come `"<title>: <reason>"` dove
   * `reason` ∈ {`no-markers`, `too-short`, `meta-summary`} (vedi `CapabilityRejection`):
   * la pagina esiste comunque, ma col solo testo dell'indice. Il motivo rende auditabile
   * PERCHÉ ogni capability è caduta in fallback (es. via `doc_generations.stats`).
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
 * Euristica anti-META-SUMMARY del deep pass. In produzione molte pagine tornavano come
 * la META-SUMMARY dell'agent ("The documentation page is written and saved to the plan
 * file…", "I now have a thorough understanding… here is the complete markdown body.")
 * invece del contenuto. Il contratto a marcatori riduce molto il problema (estraendo
 * SOLO tra i marker si scartano preamboli/chiusure fuori da essi), ma se l'agent mette
 * la meta-summary DENTRO i marker dobbiamo comunque scartarla.
 *
 * IMPORTANTE: questa euristica è applicata SOLO all'APERTURA del corpo (vedi
 * `isMetaSummary`), non a tutto il corpo. Una meta-summary genuina SOSTITUISCE l'intera
 * pagina e INIZIA con frasi-meta; una pagina vera (per contratto) inizia con un heading
 * `###` o contenuto reale. Applicarla a tutto il corpo darebbe falsi positivi: una
 * pagina vera di 3 KB può contenere "is complete and" o "let me know if" a metà testo
 * senza essere una meta-summary. Le frasi qui sono perciò segnali SPECIFICI di meta
 * (NON il generico connettore inglese "is ready/written/complete in/and", rimosso):
 * sull'apertura, dove una pagina vera avrebbe un `###`, sono affidabili.
 */
const META_SUMMARY_RE =
  /saved to the plan file|in the plan file|the documentation page (is|for)|let me know if|here is the (complete )?markdown|I now have a thorough/i;

/**
 * Numero di caratteri iniziali del corpo su cui valutare l'euristica anti-meta-summary.
 * Si guarda solo l'APERTURA: una meta-summary genuina sostituisce l'intera pagina e
 * inizia con frasi-meta, mentre una pagina vera inizia con un heading `###`.
 */
const META_SUMMARY_HEAD_CHARS = 200;

/**
 * true se l'APERTURA del corpo (i primi ~`META_SUMMARY_HEAD_CHARS` caratteri, non tutto
 * il corpo) sembra una meta-summary dell'agent invece del contenuto. Ancorare l'euristica
 * all'apertura evita i falsi positivi: una pagina legittima che cita "is complete and" o
 * "let me know if" a metà testo NON viene scartata; solo una pagina che SI APRE con
 * frasi-meta lo è.
 */
function isMetaSummary(body: string): boolean {
  return META_SUMMARY_RE.test(body.slice(0, META_SUMMARY_HEAD_CHARS));
}

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
 * L'output OBBEDISCE A UN CONTRATTO A MARCATORI: l'INTERA risposta deve contenere il
 * corpo della pagina TRA `CAPABILITY_START_MARKER` e `CAPABILITY_END_MARKER`, ciascuno
 * solo sulla propria riga; tutto ciò che è fuori dai marker viene ignorato dal parser
 * (così preamboli e chiusure non vengono pubblicati). Il corpo TRA i marker NON deve
 * iniziare con un titolo di pagina (`#`/`##`): il titolo è reso a parte dalla UI, un
 * heading `# <titolo>` qui lo duplicherebbe; inizia direttamente dalle sezioni `###`.
 * Il prompt VIETA esplicitamente meta-commenti, preamboli, chiusure e ogni frase di
 * meta-summary (vedi `META_SUMMARY_RE`), e il salvataggio su file/menzione di "plan file":
 * sono proprio gli output che in produzione venivano pubblicati al posto del contenuto.
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
    "",
    "OUTPUT CONTRACT — obey this EXACTLY:",
    "Your ENTIRE response must contain the page body BETWEEN these two markers, each",
    "ALONE on its own line, nothing else on those lines:",
    `${CAPABILITY_START_MARKER}`,
    "<the full markdown body of the page goes here>",
    `${CAPABILITY_END_MARKER}`,
    "Any text OUTSIDE the markers is IGNORED, so put the COMPLETE page between them.",
    "The content between the markers must BE the documentation itself: start directly at a",
    "`###` sub-section, with NO top-level `#`/`##` title.",
    "It must contain NO meta-commentary, NO preamble and NO closing remarks. Specifically",
    "you MUST NOT: save anything to any file; mention \"the plan file\", files or plans; say",
    "things like \"the documentation page is…\", \"I now have…\", \"here is the markdown\", or",
    "\"let me know if…\". Do not wrap the whole document in a code fence. Write ONLY the",
    "documentation, between the two markers.",
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

/**
 * Estrae il testo racchiuso tra una coppia di marker start/end, riconosciuti SOLO come
 * RIGA INTERA (la riga, trimmata, è ESATTAMENTE il marker) — stessa filosofia di
 * `parseSections`, MAI substring/indexOf, così un marker a metà riga o dentro un fenced
 * code block non è un delimitatore. Usa la PRIMA riga-`start`, poi la PRIMA riga-`end`
 * successiva. Estrarre tra i marker scarta naturalmente preamboli prima dello start e
 * chiusure dopo l'end. Ritorna `null` (corpo non estraibile) se un marker manca, sono
 * fuori ordine, o il testo tra i due è vuoto una volta trimmato.
 */
function parseDelimitedBody(
  output: string,
  start: string,
  end: string,
): string | null {
  const lines = output.split("\n");
  const startLine = lines.findIndex((l) => l.trim() === start);
  if (startLine === -1) return null;
  const endLine = lines.findIndex(
    (l, i) => i > startLine && l.trim() === end,
  );
  if (endLine === -1) return null;
  const body = lines.slice(startLine + 1, endLine).join("\n").trim();
  return body === "" ? null : body;
}

/**
 * Motivo per cui un corpo del deep pass è stato RIFIUTATO (per auditabilità via log/heartbeat
 * e nelle stats di `doc_generations`):
 * - `no-markers`  — marker mancanti/fuori ordine o corpo vuoto tra essi (parse fallito);
 * - `too-short`   — più corto di `MIN_CAPABILITY_BODY_CHARS` (output vuoto/degenere);
 * - `meta-summary`— l'APERTURA del corpo matcha l'euristica anti-meta-summary.
 */
export type CapabilityRejection = "no-markers" | "too-short" | "meta-summary";

/**
 * Estrae e VALIDA il corpo del deep pass funzionale dall'output dell'agent. Ritorna
 * `{ body }` se valido, oppure `{ reason }` (uno di `CapabilityRejection`) se rifiutato,
 * così il chiamante può LOGGARE il motivo e registrarlo nelle stats. Cause di rifiuto:
 * marker mancanti/corpo vuoto (`no-markers`); più corto di `MIN_CAPABILITY_BODY_CHARS`
 * (`too-short`); l'apertura matcha l'euristica anti-meta-summary (`meta-summary`).
 * Rifiutato ⇒ il chiamante riprova o fa fallback all'indice.
 */
function validCapabilityBody(
  output: string,
): { body: string; reason?: never } | { body?: never; reason: CapabilityRejection } {
  const body = parseDelimitedBody(
    output,
    CAPABILITY_START_MARKER,
    CAPABILITY_END_MARKER,
  );
  if (body === null) return { reason: "no-markers" };
  if (body.length < MIN_CAPABILITY_BODY_CHARS) return { reason: "too-short" };
  if (isMetaSummary(body)) return { reason: "meta-summary" };
  return { body };
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

/** Riga di heading markdown di livello 1/2 (`# Titolo` / `## Titolo`), titolo catturato. */
const LEADING_HEADING_RE = /^#{1,2}\s+(.+?)\s*$/;

/**
 * Risolve titolo + corpo della pagina tecnica di un modulo. Per la gran parte dei moduli
 * il titolo è l'ultimo segmento del path (`moduleTitle`) e il corpo resta invariato. Per
 * il modulo RADICE del repo (path `""`) `moduleTitle` è vuoto (produrrebbe un'etichetta in
 * bianco nell'albero): si deriva il titolo dal PRIMO heading markdown del corpo (`#`/`##`,
 * spogliato dei `#`) e, se usato, quella riga di heading viene RIMOSSA dal corpo per non
 * avere un doppio titolo; se il corpo non ha alcun heading iniziale si ripiega su "Root".
 */
function titleForModule(
  modulePath: string,
  body: string,
): { title: string; body: string } {
  const fromPath = moduleTitle(modulePath);
  if (fromPath !== "") return { title: fromPath, body };

  const lines = body.split("\n");
  const idx = lines.findIndex((l) => l.trim() !== "");
  if (idx !== -1) {
    const m = LEADING_HEADING_RE.exec(lines[idx]!.trim());
    if (m) {
      // Heading consumato come titolo: lo si toglie dal corpo (evita il doppio heading).
      lines.splice(idx, 1);
      return { title: m[1]!.trim(), body: lines.join("\n").trim() };
    }
  }
  return { title: "Root", body };
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
    // Il modulo radice del repo ha path "" → moduleTitle è vuoto (etichetta dell'albero
    // in bianco): si deriva il titolo dal PRIMO heading del corpo tecnico (rimosso poi
    // dal corpo per non duplicarlo), o "Root" se non c'è alcun heading.
    const { title, body } = titleForModule(doc.modulePath, doc.technicalMarkdown);
    pages.push({
      kind: "technical",
      slug,
      title,
      parentSlug: OVERVIEW_SLUG,
      sourcePath: doc.modulePath,
      body,
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

    const prompt = (cap: ParsedCapability) =>
      buildCapabilityPrompt({ title: cap.title, summary: cap.summary }, moduleDocs);

    for (let i = 0; i < caps.length; i += 1) {
      const cap = caps[i]!;
      const slug = makeUniqueSlug(baseSlug(cap.title), used);
      // fallback = SOLO la descrizione breve dell'indice (senza la riga di heading
      // `## Capability: <title>`): il titolo della pagina è reso a parte dalla UI, e
      // includere l'heading qui lo duplicherebbe. Garantisce comunque un corpo sempre
      // presente anche se il deep pass non produce output valido.
      let body = cap.summary;

      // 1° tentativo + 1 retry: l'agent deve tornare il corpo TRA i marker, e il corpo
      // estratto deve essere valido (non vuoto, ≥ MIN_CAPABILITY_BODY_CHARS, niente
      // meta-summary). Se entrambi i tentativi sono invalidi → fallback all'indice e si
      // registra il fallimento CON IL MOTIVO. `onProgress` batte attorno a OGNI tentativo
      // (heartbeat) e LOGGA il motivo del rifiuto, così un run è auditabile dai log.
      let valid: string | null = null;
      // best-effort: una chiamata in errore conta come tentativo invalido (no-markers).
      let lastReason: CapabilityRejection = "no-markers";
      for (let attempt = 1; attempt <= 2 && valid === null; attempt += 1) {
        onProgress?.(
          `capability ${i + 1}/${caps.length}: ${cap.title}` +
            (attempt > 1 ? ` (retry ${attempt - 1})` : ""),
        );
        try {
          const out = await agent({ prompt: prompt(cap), cwd });
          const res = validCapabilityBody(out);
          if (res.body !== undefined) {
            valid = res.body;
          } else {
            lastReason = res.reason;
            onProgress?.(
              `capability "${cap.title}" rejected: ${res.reason} (attempt ${attempt})`,
            );
          }
        } catch {
          lastReason = "no-markers";
        }
      }
      if (valid !== null) {
        body = valid;
      } else {
        // Registra il MOTIVO dell'ultimo tentativo, così `stats.capabilityFailures`
        // mostra PERCHÉ ogni capability è caduta in fallback.
        capabilityFailures.push(`${cap.title}: ${lastReason}`);
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
