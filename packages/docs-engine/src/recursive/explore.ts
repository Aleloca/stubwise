/**
 * EXPLORE — esplorazione ricorsiva di un nodo del DAG.
 *
 * Dato un nodo (unità tecnica o capability funzionale) l'agente, read-only nel worktree:
 *  - scrive il BODY della pagina (tra marcatori), a fondo e ancorato al codice;
 *  - elenca i SOTTO-NODI che MERITANO una pagina propria (child-list);
 *  - elenca i SOURCE-PATH coperti (lista delimitata).
 * Due varianti:
 *  - TECNICA: documenta l'unità di codice (cos'è, responsabilità, file/API, come funziona);
 *  - FUNZIONALE: documenta la capability in LINGUAGGIO NON TECNICO (tutto ciò che si può
 *    fare, passi, opzioni, limiti), mirror delle istruzioni forti di `buildCapabilityPrompt`.
 *
 * Output (contratto):
 *
 *     ===EXPLORE BODY===
 *     <markdown del corpo>
 *     ===END EXPLORE BODY===
 *     ===CHILDREN===
 *     - <title> :: <ref/paths> :: <why>
 *     ===END CHILDREN===
 *     ===SOURCE PATHS===
 *     - <path>
 *     ===END SOURCE PATHS===
 *
 * Child-list VUOTA (blocco presente ma senza righe) = FOGLIA (nessun figlio).
 * Il body è VALIDATO (marcatori presenti, non vuoto, ≥ MIN_BODY_CHARS, apertura non-meta).
 */

import {
  EXPLORE_BODY_END_MARKER,
  EXPLORE_BODY_START_MARKER,
  EXPLORE_CHILDREN_END_MARKER,
  EXPLORE_CHILDREN_START_MARKER,
  SOURCE_PATHS_END_MARKER,
  SOURCE_PATHS_START_MARKER,
  extractBlock,
  parseChildList,
  parsePathList,
  validateBody,
  type BodyRejection,
  type ChildSpec,
} from "./contract.js";

/** Albero di appartenenza del nodo. */
export type DocTree = "technical" | "functional";

/** Input del prompt di esplorazione di un nodo. */
export interface ExploreInput {
  tree: DocTree;
  /** Path o nome capability dell'unità da esplorare. */
  unitRef: string;
  /** Titolo del nodo (etichetta). */
  title: string;
  /** Contesto del padre (riassunto/intro), per orientare l'agente. */
  parentContext: string;
  /** Titoli degli antenati (radice→padre), per il contesto gerarchico. */
  ancestorTitles?: string[];
}

/** Righe del contratto di output comuni a entrambe le varianti di explore. */
function outputContractLines(): string[] {
  return [
    "OUTPUT CONTRACT — obey this EXACTLY. Emit THREE delimited blocks, each marker ALONE",
    "on its own line, and NOTHING that matters outside them (any text outside is ignored).",
    "",
    "1) The page body BETWEEN these markers:",
    EXPLORE_BODY_START_MARKER,
    "<the full markdown body of THIS page>",
    EXPLORE_BODY_END_MARKER,
    "Start the body DIRECTLY with `###` sub-sections; do NOT begin with a top-level `#`/",
    "`##` page title (the title is rendered separately by the UI and would be duplicated).",
    "",
    "2) The SUB-UNITS that DESERVE THEIR OWN PAGE (children), one per line, format",
    "`- <title> :: <paths> :: <why>` (fields separated by ' :: '; title required). Leave",
    "the block EMPTY (no lines) if this unit is small enough to stay a single page (a leaf):",
    EXPLORE_CHILDREN_START_MARKER,
    "- <child title> :: <path(s)> :: <why it deserves its own page>",
    EXPLORE_CHILDREN_END_MARKER,
    "",
    "3) The SOURCE PATHS this page covers, one path per line:",
    SOURCE_PATHS_START_MARKER,
    "- <path>",
    SOURCE_PATHS_END_MARKER,
    "",
    "ANTI-META RULES: write ONLY the documentation. Do NOT save anything to any file, do",
    "NOT mention \"the plan file\", files or plans, and do NOT add meta-commentary,",
    "preamble or closing remarks such as \"the documentation page is…\", \"I now have…\",",
    "\"here is the markdown\" or \"let me know if…\". Do not wrap the body in a code fence.",
  ];
}

/** Riga di contesto gerarchico (antenati + padre) condivisa dalle due varianti. */
function contextLines(input: ExploreInput): string[] {
  const trail = (input.ancestorTitles ?? []).join(" › ");
  return [
    `Unit reference: ${input.unitRef}`,
    `Page title: ${input.title}`,
    trail ? `Ancestry (root → parent): ${trail}` : "",
    "",
    "Context from the parent page (for orientation, do not copy verbatim):",
    input.parentContext.trim() || "(none)",
  ].filter((l) => l !== "");
}

/**
 * Costruisce il prompt di explore. Sceglie la variante tecnica o funzionale in base a
 * `input.tree`. Entrambe terminano con lo stesso contratto di output a tre blocchi.
 */
export function buildExplorePrompt(input: ExploreInput): string {
  const head =
    input.tree === "technical"
      ? technicalLines(input)
      : functionalLines(input);
  return [...head, "", ...outputContractLines()].join("\n");
}

/** Variante TECNICA: documenta a fondo l'unità di codice, ancorata al codice. */
function technicalLines(input: ExploreInput): string[] {
  return [
    "You are writing ONE deep page of TECHNICAL documentation about a single code unit of",
    "a software repository, for developers. You are running READ-ONLY in the repository",
    "working directory: READ the relevant code to be accurate — ground everything in what",
    "the code ACTUALLY does, do not invent.",
    "",
    ...contextLines(input),
    "",
    "DOCUMENT THIS UNIT DEEPLY:",
    "- what it IS and its responsibilities (the role it plays in the system);",
    "- its key files, modules, public API/surface and important types;",
    "- HOW IT WORKS: the main data/control flows, key algorithms or mechanisms, and how",
    "  it relates to the units it depends on or collaborates with;",
    "- important implementation details, invariants and gotchas.",
    "Use MULTIPLE `###` sub-sections; be thorough and concrete.",
    "",
    "THEN decide the SUB-UNITS that DESERVE THEIR OWN PAGE: the natural sub-decomposition",
    "of this unit (sub-modules, major files or subsystems substantial enough to warrant a",
    "dedicated page). A minor part stays inside THIS page — do NOT split trivially. If the",
    "unit is cohesive and small, it is a LEAF: emit NO children.",
  ];
}

/**
 * Variante FUNZIONALE: documenta la capability in LINGUAGGIO NON TECNICO. Mirror delle
 * istruzioni forti di `buildCapabilityPrompt` (regola di linguaggio assoluta, enumerazione
 * esaustiva, grounding-poi-traduzione), riusate qui per la profondità già validata.
 */
function functionalLines(input: ExploreInput): string[] {
  return [
    "You are writing ONE complete, DEEP page of FUNCTIONAL documentation about a single",
    "product capability (a feature area / block of the product).",
    "",
    ...contextLines(input),
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
    "- for each thing, describe the STEPS in words, the inputs/choices involved, and the",
    "  constraints, rules and limits that apply.",
    "",
    "GROUND IT IN THE REAL BEHAVIOUR — you are running READ-ONLY in the repository working",
    "directory. INSPECT the relevant code to be accurate and exhaustive about what the",
    "product ACTUALLY does (do not invent features, do not omit real ones), but TRANSLATE",
    "every finding into plain product language. Never leak the technical detail you read;",
    "only its meaning for the user. Use MULTIPLE `###` sub-sections; be thorough.",
    "",
    "THEN decide the SUB-CAPABILITIES that DESERVE THEIR OWN PAGE: distinct sub-areas of",
    "this capability substantial enough for a dedicated page, each with the source path(s)",
    "that IMPLEMENT it. A minor aspect stays inside THIS page. If the capability is",
    "cohesive and small, it is a LEAF: emit NO children.",
  ];
}

/** Esito valido di un explore parsato. */
export interface ExploreOutput {
  body: string;
  /** Figli (vuoto = foglia). */
  children: ChildSpec[];
  sourcePaths: string[];
}

/**
 * Parsa e VALIDA l'output di explore. Ritorna `{ body, children, sourcePaths }` se valido,
 * oppure `{ reason }` se invalido:
 *  - body non valido (marcatori mancanti / vuoto / troppo corto / meta) → `BodyRejection`;
 *  - blocco CHILDREN assente (marcatori mancanti) → `no-children-block` (contratto violato).
 * Un blocco CHILDREN presente ma vuoto è LEGITTIMO (foglia → `children: []`). Il blocco
 * SOURCE PATHS è tollerante: se manca → `sourcePaths: []` (il body resta pubblicabile).
 * Le righe-figlio malformate sono saltate (vedi `parseChildList`).
 */
export function parseExploreOutput(
  output: string,
): ExploreOutput | { reason: ExploreRejection } {
  const bodyRes = validateBody(
    output,
    EXPLORE_BODY_START_MARKER,
    EXPLORE_BODY_END_MARKER,
  );
  if (bodyRes.body === undefined) return { reason: bodyRes.reason };

  const childrenBlock = extractBlock(
    output,
    EXPLORE_CHILDREN_START_MARKER,
    EXPLORE_CHILDREN_END_MARKER,
  );
  // Il blocco CHILDREN è OBBLIGATORIO (anche se vuoto): la sua ASSENZA è contratto
  // violato; un blocco vuoto è la foglia.
  if (childrenBlock === null) return { reason: "no-children-block" };
  const children = parseChildList(childrenBlock).children;

  // SOURCE PATHS tollerante: assente → [] (non invalida il body già valido).
  const pathsBlock = extractBlock(
    output,
    SOURCE_PATHS_START_MARKER,
    SOURCE_PATHS_END_MARKER,
  );
  const sourcePaths = pathsBlock === null ? [] : parsePathList(pathsBlock);

  return { body: bodyRes.body, children, sourcePaths };
}

/** Motivo di rifiuto di un output explore (body invalido o blocco children mancante). */
export type ExploreRejection = BodyRejection | "no-children-block";
