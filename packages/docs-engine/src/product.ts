/**
 * PRODUCT — contratti dei prompt della classe `product`: la documentazione PUBBLICA,
 * per-superficie, rivolta all'utente finale (widget-ready). Diversa dagli alberi interni
 * (`technical`/`functional`), che parlano al dev/all'operatore: qui il registro è la
 * SECONDA PERSONA, gli interni (file, funzioni, tabelle, endpoint) sono BANDITI, e i nomi
 * che l'utente VEDE (label di menu/bottoni, URL pubblici) sono OBBLIGATORI.
 *
 * Ogni superficie pubblica del brief genera una VERTICALE con tre tipi di pagina:
 *  1. RADICE  — "Guida <superficie>": cosa può fare l'utente qui + getting-started
 *     (primo accesso, prerequisiti). `buildProductRootPrompt`.
 *  2. GUIDA   — how-to per un journey, a STRUTTURA IMPOSTA (Goal → Prerequisites →
 *     Steps con ancoraggi di navigazione → Expected result → Common issues).
 *     `buildProductGuidePrompt`. L'agente può rispondere `===SKIP===` se il journey non
 *     è realizzabile sulla superficie.
 *  3. FAQ     — domande in voce utente dalle "limitations" delle pagine functional, con
 *     risposte oneste (cosa non si può fare, workaround). `buildProductFaqPrompt`.
 *
 * ── FORMATO DI OUTPUT (documentato) ────────────────────────────────────────────────
 * RADICE e FAQ emettono il body tra `===PAGE===` / `===END PAGE===` (un blocco delimitato,
 * marcatore SOLO come riga intera, come tutto il motore); validato come gli altri body
 * (marcatori presenti, non vuoto, ≥ MIN_BODY_CHARS, apertura non-meta) via `validateBody`.
 * `parseProductPageOutput`.
 *
 * La GUIDA usa gli STESSI marcatori `===PAGE===`/`===END PAGE===`, ma il body ha una
 * struttura CONVENUTA: cinque sezioni `###` obbligatorie e, dentro `### Steps`, passi
 * numerati (`1.`, `2.`, …) ciascuno con un rigo di ancoraggio `NAV:` per i passi che
 * comportano un'azione nell'interfaccia:
 *
 *     ### Steps
 *     1. <istruzione>
 *        NAV: <Menu → Voce → Bottone> [/relative/url]
 *     2. ...
 *
 * `NAV:` è OBBLIGATORIO su ogni passo che agisce sull'interfaccia; l'URL tra `[...]` è
 * opzionale ma raccomandato quando esiste una route. `parseProductGuideOutput` VALIDA:
 *  - le cinque sezioni richieste sono presenti (### Goal / Prerequisites / Steps /
 *    Expected result / Common issues) → altrimenti `{ reason: "missing-sections" }`;
 *  - almeno UN `NAV:` esiste → altrimenti `{ reason: "no navigation anchors" }`;
 *  - i `NAV:` coprono ALMENO METÀ dei passi numerati (soglia documentata: `nav >=
 *    ceil(steps/2)`) → altrimenti `{ reason: "insufficient navigation anchors" }`.
 * Se l'agente emette `===SKIP===` (journey non realizzabile) → `{ skip: <motivo> }`.
 * Il parser NON lancia MAI: input spazzatura → `{ reason }`.
 *
 * Tutti i prompt rendono `briefContext` (che GIÀ include la sezione NEVER-disclose quando
 * il chiamante usa `briefPromptContext(brief, { includeSecrets: true })`) e i
 * `functionalSummaries` come DOMAIN KNOWLEDGE interno da RIESPRIMERE, non copiare.
 */

import type { BriefJourney, BriefSurface } from "./brief.js";
import { validateBody, type BodyRejection } from "./recursive/contract.js";

// ── Marcatori ──────────────────────────────────────────────────────────────────────────

/** Apre il body di una pagina product (radice / guida / FAQ). */
export const PRODUCT_PAGE_START_MARKER = "===PAGE===";
/** Chiude il body di una pagina product. */
export const PRODUCT_PAGE_END_MARKER = "===END PAGE===";
/** Emesso (riga intera) quando un journey NON è realizzabile sulla superficie. */
export const PRODUCT_SKIP_MARKER = "===SKIP===";

/** Le cinque sezioni `###` obbligatorie nel body di una guida, IN ORDINE. */
const GUIDE_SECTIONS = [
  "### Goal",
  "### Prerequisites",
  "### Steps",
  "### Expected result",
  "### Common issues",
] as const;

// ── Tipi ────────────────────────────────────────────────────────────────────────────────

/** Input comune ai prompt della verticale product. */
export interface ProductPromptInput {
  /** La superficie PUBBLICA di cui si documenta la verticale (rootPath REALE nel repo). */
  surface: BriefSurface;
  /**
   * Contesto del brief da `briefPromptContext(brief, { includeSecrets: true })`: include
   * glossario/attori/invarianti E la sezione NEVER-disclose coi divieti sui fatti riservati.
   */
  briefContext: string;
  /** Conoscenza di dominio dalle pagine functional pertinenti (titolo + primo paragrafo). */
  functionalSummaries: { title: string; summary: string }[];
}

// ── Sezioni condivise dei prompt ─────────────────────────────────────────────────────────

/**
 * La cornice comune a tutti i prompt product: chi sei, il registro assoluto (seconda
 * persona, zero interni, nomi visibili obbligatori) e le fonti (codice read-only della
 * superficie, brief, functional summaries). Il `focusLine` differenzia il compito.
 */
function commonHead(input: ProductPromptInput): string[] {
  const s = input.surface;
  return [
    `You are writing PUBLIC, end-user documentation for the "${s.name}" surface of a`,
    "software product. Your reader is the END USER of this surface, NOT a developer and NOT",
    "an internal operator.",
    "",
    "REGISTER — the most important rule, never violate it:",
    "- Write in the SECOND PERSON, addressing the user directly (\"you\", \"your account\").",
    "- ZERO internals: NEVER mention or expose file paths, function/class/variable/table",
    "  names, endpoints, module names, code identifiers, frameworks, libraries or any",
    "  programming jargon. The reader must understand everything without knowing any code.",
    "- The names the user actually SEES are MANDATORY: use the real menu labels, button",
    "  labels, screen titles and public URLs exactly as they appear in the interface.",
    "",
    "GROUND IT IN THE REAL SURFACE — you are running READ-ONLY in the repository working",
    `directory. READ the code of this surface under "${s.rootPath}" (routes, navigation`,
    "entries, on-screen labels, forms) to be accurate about what the user can actually do",
    "and what they see. Derive the REAL navigation from the code; do not invent screens or",
    "labels. Never leak the technical detail you read — only its meaning for the user.",
    "",
    `Surface: ${s.name} (${s.type}) — audience: ${s.audience}. Real root path in the`,
    `repository (read-only): ${s.rootPath}.`,
  ];
}

/** Rende i functional summaries come DOMAIN KNOWLEDGE interno da riesprimere. */
function domainKnowledgeSection(input: ProductPromptInput): string[] {
  if (input.functionalSummaries.length === 0) return [];
  const items = input.functionalSummaries.map(
    (f) => `- ${f.title}: ${f.summary}`,
  );
  return [
    "",
    "DOMAIN KNOWLEDGE (internal summaries — do not copy verbatim, re-express for end users):",
    ...items,
  ];
}

/** Rende il briefContext (che GIÀ include la sezione NEVER-disclose) come prima sezione. */
function briefContextSection(input: ProductPromptInput): string[] {
  const ctx = input.briefContext.trim();
  if (ctx === "") return [];
  return [ctx, ""];
}

/** Il contratto di output a body singolo (radice / FAQ). */
function pageOutputContract(): string[] {
  return [
    "OUTPUT CONTRACT — obey this EXACTLY. Emit the page body BETWEEN these two markers, each",
    "marker ALONE on its own line, and NOTHING that matters outside them (any text outside",
    "is ignored):",
    PRODUCT_PAGE_START_MARKER,
    "<the full markdown body of THIS page>",
    PRODUCT_PAGE_END_MARKER,
    "Start the body DIRECTLY with `###` sub-sections; do NOT begin with a top-level `#`/`##`",
    "page title (the title is rendered separately by the UI). Do not wrap the body in a code",
    "fence. Do NOT save anything to any file and add NO meta-commentary, preamble or closing",
    "remarks.",
  ];
}

// ── Prompt: radice di verticale ──────────────────────────────────────────────────────────

/**
 * Prompt della RADICE della verticale: "Guida <superficie>". Copre COSA può fare l'utente
 * su questa superficie (panoramica delle aree/azioni principali) e il GETTING-STARTED
 * (primo accesso, prerequisiti, come orientarsi la prima volta). Body tra `===PAGE===`.
 */
export function buildProductRootPrompt(input: ProductPromptInput): string {
  return [
    ...briefContextSection(input),
    ...commonHead(input),
    ...domainKnowledgeSection(input),
    "",
    `WRITE THE ROOT PAGE OF THE "${input.surface.name}" GUIDE. It is the landing page a user`,
    "reaches first. Cover:",
    "- GETTING STARTED: how to access this surface for the very FIRST time, what you need",
    "  before you begin (prerequisites, an account, anything to set up), and how to find",
    "  your way around — name the real menus and areas the user sees.",
    "- WHAT YOU CAN DO HERE: an overview of the main things the user can accomplish on this",
    "  surface, each pointing (by its visible name) to where it lives. Be concrete but keep",
    "  this a landing overview, not a full how-to (the how-tos are separate guide pages).",
    "Use MULTIPLE `###` sub-sections. Be thorough and concrete, always in the second person.",
    "",
    ...pageOutputContract(),
  ].join("\n");
}

// ── Prompt: guida how-to ─────────────────────────────────────────────────────────────────

/**
 * Prompt di una GUIDA how-to per un `journey`, a STRUTTURA IMPOSTA. Ogni passo che agisce
 * sull'interfaccia DEVE avere il rigo `NAV:` (derivato dalla navigazione REALE del codice).
 * Se il journey non è realizzabile su questa superficie, l'agente emette `===SKIP===`.
 */
export function buildProductGuidePrompt(
  input: ProductPromptInput & { journey: BriefJourney },
): string {
  const j = input.journey;
  return [
    ...briefContextSection(input),
    ...commonHead(input),
    ...domainKnowledgeSection(input),
    "",
    "WRITE A STEP-BY-STEP HOW-TO GUIDE for this user journey:",
    `- Journey: ${j.title}`,
    j.actor ? `- Actor: ${j.actor}` : "",
    j.summary ? `- Summary: ${j.summary}` : "",
    "",
    "The guide MUST follow this EXACT structure — five `###` sections, in this order:",
    ...GUIDE_SECTIONS.map((h) => `  ${h}`),
    "",
    "Under `### Steps`, write NUMBERED steps (`1.`, `2.`, …). EVERY step that involves an",
    "action in the interface MUST be followed by a navigation anchor line starting with",
    "`NAV:` that names the path the user follows and, when a route exists, the relative URL",
    "in square brackets. This anchor is MANDATORY and derived from the REAL surface code",
    "(routes, navigation entries, on-screen labels). Format:",
    "",
    "  1. Open the new top-up form.",
    "     NAV: Top-ups → New top-up [/topups/new]",
    "",
    "The `NAV:` line is REQUIRED for every action step; the `[/url]` part is optional but",
    "recommended whenever a route exists. Pure-reading steps (\"you will see …\") need no NAV.",
    "",
    "If this journey CANNOT be carried out on this surface (it belongs to another surface,",
    `e.g. an internal/admin one), do NOT invent a guide. Emit the marker ${PRODUCT_SKIP_MARKER}`,
    "alone on its own line, followed by a one-line reason, and nothing else.",
    "",
    "OUTPUT CONTRACT — obey this EXACTLY. EITHER emit the guide body between the two markers",
    "below (each marker ALONE on its own line, the five sections inside, in order), OR emit",
    `${PRODUCT_SKIP_MARKER} + a reason. Nothing that matters outside the markers.`,
    PRODUCT_PAGE_START_MARKER,
    GUIDE_SECTIONS.join("\n...\n"),
    "...",
    PRODUCT_PAGE_END_MARKER,
    "Start the body DIRECTLY with `### Goal`; do NOT begin with a `#`/`##` page title. Do not",
    "wrap the body in a code fence. Do NOT save anything to any file and add NO",
    "meta-commentary, preamble or closing remarks.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ── Prompt: FAQ ──────────────────────────────────────────────────────────────────────────

/**
 * Prompt della FAQ della verticale, costruita dalle `limitations` (estratti delle pagine
 * functional pertinenti: cosa NON si può fare, limiti, casi bloccati). Domande in voce
 * utente + risposte ONESTE (dire chiaramente cosa non è possibile, e il workaround se c'è).
 */
export function buildProductFaqPrompt(
  input: ProductPromptInput & { limitations: string[] },
): string {
  const limitations =
    input.limitations.length > 0
      ? input.limitations.map((l) => `- ${l}`).join("\n")
      : "(no explicit limitations were extracted; derive honest FAQs from the surface code)";
  return [
    ...briefContextSection(input),
    ...commonHead(input),
    ...domainKnowledgeSection(input),
    "",
    `WRITE THE FAQ PAGE for the "${input.surface.name}" surface. Turn the LIMITATIONS below`,
    "into honest questions a real user would ask, each with a straight, HONEST answer:",
    "clearly state what is NOT possible and, when one exists, the workaround. Never oversell;",
    "an honest \"you cannot do this here\" is the right answer. Phrase every QUESTION in the",
    "user's own voice (second person) and keep answers concrete and reassuring.",
    "",
    "LIMITATIONS (things the product cannot do / edge cases that are blocked):",
    limitations,
    "",
    "Use a `###` sub-section per question (the heading IS the question) followed by its",
    "answer. Add any other genuinely common questions you can ground in the surface code.",
    "",
    ...pageOutputContract(),
  ].join("\n");
}

// ── Parser: pagina product (radice / FAQ) ────────────────────────────────────────────────

/**
 * Parsa e VALIDA il body di una pagina product (radice / FAQ). Stessa validazione degli
 * altri body del motore: marcatori presenti, corpo non vuoto, ≥ `MIN_BODY_CHARS`, apertura
 * non-meta. Ritorna `{ body }` se valido, `{ reason }` (un `BodyRejection`) altrimenti.
 * Non lancia MAI.
 */
export function parseProductPageOutput(
  output: string,
): { body: string } | { reason: BodyRejection } {
  const res = validateBody(output, PRODUCT_PAGE_START_MARKER, PRODUCT_PAGE_END_MARKER);
  if (res.body === undefined) return { reason: res.reason };
  return { body: res.body };
}

/** Motivo di rifiuto di una guida (oltre ai `BodyRejection` del body). */
export type ProductGuideRejection =
  | BodyRejection
  | "missing-sections"
  | "no navigation anchors"
  | "insufficient navigation anchors";

/** Righe che aprono un passo numerato in `### Steps` (`1.`, `2.`, … a inizio riga). */
const NUMBERED_STEP_RE = /^\s*\d+\.\s+/;
/** Riga di ancoraggio di navigazione (`NAV:` a inizio riga, dopo eventuale indentazione). */
const NAV_ANCHOR_RE = /^\s*NAV:\s*\S/;

/**
 * Parsa e VALIDA l'output di una GUIDA how-to. Tre esiti (mai throw):
 *  - `{ skip }`   — l'agente ha emesso `===SKIP===` (journey non realizzabile); il motivo
 *    è il resto del blocco, stringa vuota se assente;
 *  - `{ reason }` — output invalido: body non estraibile/troppo corto/meta (`BodyRejection`),
 *    una delle cinque sezioni mancante (`missing-sections`), oppure ancoraggi insufficienti
 *    (`no navigation anchors` se ZERO `NAV:`; `insufficient navigation anchors` se i `NAV:`
 *    sono meno della metà dei passi numerati, soglia `nav >= ceil(steps/2)`);
 *  - `{ body, navAnchors }` — guida valida, col conteggio degli ancoraggi trovati.
 *
 * Precedenza: lo SKIP è controllato PRIMA del body (uno skip legittimo non ha body).
 */
export function parseProductGuideOutput(
  output: string,
): { body: string; navAnchors: number } | { skip: string } | { reason: ProductGuideRejection } {
  // SKIP ha la precedenza: marcatore riconosciuto SOLO come riga intera.
  const lines = output.split("\n");
  const skipLine = lines.findIndex((l) => l.trim() === PRODUCT_SKIP_MARKER);
  if (skipLine !== -1) {
    const reason = lines
      .slice(skipLine + 1)
      .join("\n")
      .trim();
    return { skip: reason };
  }

  const res = validateBody(output, PRODUCT_PAGE_START_MARKER, PRODUCT_PAGE_END_MARKER);
  if (res.body === undefined) return { reason: res.reason };
  const body = res.body;

  // Tutte e cinque le sezioni devono essere presenti (marcatore `###` come inizio riga).
  const bodyLines = body.split("\n");
  const hasSection = (heading: string): boolean =>
    bodyLines.some((l) => l.trim() === heading);
  if (!GUIDE_SECTIONS.every(hasSection)) return { reason: "missing-sections" };

  // Conta i passi numerati e gli ancoraggi NAV nell'INTERO body (semplice e robusto: i
  // NAV vivono comunque solo sotto `### Steps`).
  const steps = bodyLines.filter((l) => NUMBERED_STEP_RE.test(l)).length;
  const navAnchors = bodyLines.filter((l) => NAV_ANCHOR_RE.test(l)).length;

  if (navAnchors === 0) return { reason: "no navigation anchors" };
  // Soglia documentata: almeno la METÀ dei passi (arrotondata per eccesso) ha un NAV.
  const required = Math.ceil(steps / 2);
  if (navAnchors < required) return { reason: "insufficient navigation anchors" };

  return { body, navAnchors };
}
