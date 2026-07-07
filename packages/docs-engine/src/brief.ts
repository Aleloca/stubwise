/**
 * PROJECT BRIEF — il contratto del "documentarista" (Fase A del brief+product).
 *
 * PRIMA di scomporre il repo in alberi di pagine, un agente read-only risponde alle
 * DOMANDE FONDANTI del prodotto e le emette in un contratto a marcatori PER SEZIONE
 * (stile del resto del motore: blocchi delimitati, marcatore SOLO sulla propria riga,
 * righe strutturate delimitate da ` :: `, MAI formato libero). Il brief così ottenuto
 * viene persistito (jsonb) e propagato ai prompt downstream (glossario/attori/invarianti
 * ovunque; fatti riservati SOLO nella pipeline `product`).
 *
 * Otto sezioni:
 *  1. IDENTITY   — prosa: cos'è il prodotto, chi paga per cosa (2-3 frasi).
 *  2. ACTORS     — ogni tipo di persona che interagisce, con flag internal.
 *  3. SURFACES   — ogni superficie d'ingresso (webapp/admin/API/canali), con `rootPath`
 *                  REALE nel repo, audience e flag internal.
 *  4. GLOSSARY   — 10-30 termini canonici del dominio (i nomi UFFICIALI).
 *  5. INVARIANTS — le regole di business centrali (una per riga).
 *  6. CONFIDENTIAL FACTS — euristiche esplicite (margini/markup, pricing/costi, tassi,
 *                  fornitori, competitor, superfici interne): fact/reason/source/avoid.
 *  7. JOURNEYS   — i 5-10 flussi utente principali, per attore.
 *  8. EXISTING SOURCES — README/ADR/docs/schema/contratti trovati (path reali).
 *
 * ── FORMATO (documentato) ─────────────────────────────────────────────────────────────
 * Ogni sezione è un blocco `===<NAME>===` … `===END <NAME>===` (marcatori riconosciuti
 * SOLO come riga intera, via `extractBlock`). IDENTITY è prosa libera dentro il blocco.
 * Le sezioni-lista sono UNA RIGA PER ELEMENTO, campi delimitati da ` :: ` (lo stesso
 * separatore robusto delle child-list del motore), `- ` iniziale opzionale:
 *  - ACTORS:              `name :: description :: internal`
 *  - SURFACES:            `name :: type :: rootPath :: audience :: internal`
 *  - GLOSSARY:            `term :: definition`
 *  - INVARIANTS:          testo libero (una riga per invariante)
 *  - CONFIDENTIAL FACTS:  `fact :: reason :: source :: avoid`
 *  - JOURNEYS:            `actor :: title :: summary`
 *  - EXISTING SOURCES:    path (una per riga)
 *
 * Il PARSER è best-effort PER SEZIONE: una sezione mancante/malformata → array vuoto
 * (stringa vuota per identity), MAI throw; `{ reason }` solo se NESSUNA sezione è
 * parsabile. Il flag `internal` è letto dall'ULTIMO campo della riga (fail-closed: per le
 * surfaces un ultimo campo non-booleano SCARTA la superficie, per gli actors → internal).
 */

import { extractBlock } from "./recursive/contract.js";

// ── Marcatori di sezione ──────────────────────────────────────────────────────────────

/** Apre/chiude l'IDENTITÀ del prodotto (prosa: cos'è, chi paga per cosa). */
export const BRIEF_IDENTITY_START_MARKER = "===IDENTITY===";
export const BRIEF_IDENTITY_END_MARKER = "===END IDENTITY===";
/** Apre/chiude gli ATTORI (`name :: description :: internal`). */
export const BRIEF_ACTORS_START_MARKER = "===ACTORS===";
export const BRIEF_ACTORS_END_MARKER = "===END ACTORS===";
/** Apre/chiude le SUPERFICI (`name :: type :: rootPath :: audience :: internal`). */
export const BRIEF_SURFACES_START_MARKER = "===SURFACES===";
export const BRIEF_SURFACES_END_MARKER = "===END SURFACES===";
/** Apre/chiude il GLOSSARIO (`term :: definition`). */
export const BRIEF_GLOSSARY_START_MARKER = "===GLOSSARY===";
export const BRIEF_GLOSSARY_END_MARKER = "===END GLOSSARY===";
/** Apre/chiude gli INVARIANTI (una regola di business per riga). */
export const BRIEF_INVARIANTS_START_MARKER = "===INVARIANTS===";
export const BRIEF_INVARIANTS_END_MARKER = "===END INVARIANTS===";
/** Apre/chiude i FATTI RISERVATI (`fact :: reason :: source :: avoid`). */
export const BRIEF_CONFIDENTIAL_START_MARKER = "===CONFIDENTIAL FACTS===";
export const BRIEF_CONFIDENTIAL_END_MARKER = "===END CONFIDENTIAL FACTS===";
/** Apre/chiude i JOURNEY (`actor :: title :: summary`). */
export const BRIEF_JOURNEYS_START_MARKER = "===JOURNEYS===";
export const BRIEF_JOURNEYS_END_MARKER = "===END JOURNEYS===";
/** Apre/chiude le FONTI ESISTENTI (path reali, una per riga). */
export const BRIEF_SOURCES_START_MARKER = "===EXISTING SOURCES===";
export const BRIEF_SOURCES_END_MARKER = "===END EXISTING SOURCES===";

/** Separatore di campo nelle righe strutturate (come le child-list del motore). */
export const BRIEF_FIELD_SEP = " :: ";

// ── Tetti (cap) di parse ──────────────────────────────────────────────────────────────

/** Cap difensivi al parse (il prompt DICHIARA cap più stretti: glossario 30, facts 30,
 *  journeys 15; il parser è più permissivo per non buttare via lavoro buono). */
const CAP_ACTORS = 10;
const CAP_SURFACES = 12;
const CAP_GLOSSARY = 40;
const CAP_INVARIANTS = 40;
const CAP_FACTS = 30;
const CAP_JOURNEYS = 15;
const CAP_SOURCES = 60;

/** Lunghezza massima di una definizione di glossario resa in `briefPromptContext`. */
const CONTEXT_DEF_MAX = 200;

/** Cap dedicato per l'identity nel contesto: è prosa (2-3 frasi), sta più larga. */
const CONTEXT_IDENTITY_MAX = 450;

// ── Tipi ──────────────────────────────────────────────────────────────────────────────

/** Un tipo di persona che interagisce col prodotto. */
export interface BriefActor {
  name: string;
  description: string;
  /** true = staff/interno; false = utente esterno/pubblico. */
  internal: boolean;
}

/** Una superficie d'ingresso del prodotto (webapp, admin, API pubblica, canale…). */
export interface BriefSurface {
  name: string;
  type: string;
  /** Path radice REALE nel repo (senza slash iniziali/finali, mai `..`). */
  rootPath: string;
  audience: string;
  /** true = admin/staff-only (esclusa dalla pipeline product). */
  internal: boolean;
}

/** Un termine canonico del dominio (nome ufficiale + definizione una-riga). */
export interface BriefGlossaryEntry {
  term: string;
  definition: string;
}

/** Un fatto di business riservato rilevato nel repo/superfici interne. */
export interface BriefConfidentialFact {
  /** Cos'è il fatto (es. "markup del 18% sui token"). */
  fact: string;
  /** Perché è riservato. */
  reason: string;
  /** Dove nel codice/superfici è visibile. */
  source: string;
  /** Come NON deve apparire in una doc pubblica. */
  avoid: string;
}

/** Un flusso utente principale, ancorato a un attore. */
export interface BriefJourney {
  actor: string;
  title: string;
  summary: string;
}

/** Il project brief completo — risposta alle domande fondanti del prodotto. */
export interface ProjectBrief {
  identity: string;
  actors: BriefActor[];
  surfaces: BriefSurface[];
  glossary: BriefGlossaryEntry[];
  invariants: string[];
  confidentialFacts: BriefConfidentialFact[];
  journeys: BriefJourney[];
  existingSources: string[];
}

/** Input del prompt del brief. */
export interface BuildBriefPromptInput {
  /** Subject dei commit del repo (dal più recente), come contesto di orientamento. */
  commitSubjects?: string[];
}

// ── Prompt ────────────────────────────────────────────────────────────────────────────

/** Tetto di righe di commit nel prompt: niente contesto sterminato. */
const MAX_COMMITS = 200;

/**
 * Costruisce il prompt del DOCUMENTARISTA: un singolo run agente READ-ONLY che, PRIMA di
 * qualsiasi scomposizione, risponde alle domande fondanti del prodotto e le emette col
 * contratto a marcatori per sezione. L'agente PUÒ leggere il codice per fondare le
 * risposte (in particolare i `rootPath` delle superfici, che devono essere REALI).
 */
export function buildBriefPrompt(input: BuildBriefPromptInput): string {
  const commits =
    input.commitSubjects && input.commitSubjects.length > 0
      ? input.commitSubjects
          .slice(0, MAX_COMMITS)
          .map((s) => `- ${s}`)
          .join("\n")
      : "(no commit subjects)";

  return [
    "You are the DOCUMENTARIAN for a software product. BEFORE anyone decomposes this",
    "repository into documentation pages, YOU answer the founding questions about the",
    "product. You are running READ-ONLY in the repository working directory: you MAY and",
    "SHOULD read the code to ground every answer in what the product ACTUALLY is and does.",
    "Do NOT invent. Do NOT save anything to any file.",
    "",
    "COMMIT SUBJECTS (most recent first), for orientation:",
    commits,
    "",
    "ANSWER THESE EIGHT QUESTIONS, in order:",
    "",
    "1. IDENTITY. What is this product, in 2-3 sentences? WHO pays for WHAT? Name the",
    "   value it delivers and to whom — not the tech stack.",
    "",
    "2. ACTORS. Every KIND of person who interacts with the product: business user, internal",
    "   staff/operator, partner, end-user of the product's channels, API integrator, and so",
    "   on. For each, a one-line description and whether they are INTERNAL (staff/operators",
    "   of the company running the product) or external.",
    "",
    "3. SURFACES. Every ENTRY SURFACE of the product: the customer web app, the admin/back",
    "   office app, the public API, each outbound channel, etc. For each surface give its",
    "   REAL root path in THIS repository (verify it by reading the code — a folder that",
    "   actually exists), its type, its audience, and whether it is INTERNAL. An admin or",
    "   staff-only surface is INTERNAL.",
    "",
    "4. GLOSSARY. 10 to 30 canonical domain terms, each with a one-line definition. These",
    "   are the OFFICIAL names to be used everywhere in the documentation — the words the",
    "   product itself uses for its concepts.",
    "",
    "5. INVARIANTS. The central business rules that always hold. Include concrete VALUES",
    "   only when they are NOT confidential; otherwise state the rule without the number.",
    "",
    "6. CONFIDENTIAL FACTS. Business facts that must NEVER leak into public documentation.",
    "   Hunt for them with THESE heuristics: margins / markups; internal pricing or cost",
    "   structure; conversion or exchange rates; supplier terms and conditions; any",
    "   reference to competitors; and ANYTHING visible ONLY from an INTERNAL surface (admin",
    "   / back office) or from code that computes economic figures. For EACH fact give:",
    "   what it is, WHY it is confidential, WHERE in the code it is visible, and HOW it must",
    `   NOT appear in a public document (e.g. "never state a percentage margin or a`,
    `   wholesale price").`,
    "",
    "7. JOURNEYS. The 5 to 10 main user flows, one per line, attributed to an actor: a",
    "   short title and a one-line summary of the flow.",
    "",
    "8. EXISTING SOURCES. README files, ADRs, hand-written docs/ pages, the DB schema, API",
    "   contracts — the real paths of documentation that already exists in the repo. (These",
    "   are NOT noise: they feed the brief.)",
    "",
    "CAPS: at most 30 glossary terms, at most 30 confidential facts, at most 15 journeys.",
    "",
    "OUTPUT CONTRACT — obey this EXACTLY. Emit ONE block per section, each marker ALONE on",
    "its own line, and NOTHING that matters outside the blocks (any other text is ignored).",
    "IDENTITY is free prose. Every LIST section is ONE ITEM PER LINE with fields separated",
    `by ' :: ' (space-colon-colon-space). 'internal' is 'true' or 'false'. Leave a section`,
    "block EMPTY if you genuinely have nothing for it, but never omit its markers.",
    "",
    BRIEF_IDENTITY_START_MARKER,
    "<2-3 sentences: what the product is and who pays for what>",
    BRIEF_IDENTITY_END_MARKER,
    BRIEF_ACTORS_START_MARKER,
    "<actor name> :: <one-line description> :: <internal true|false>",
    BRIEF_ACTORS_END_MARKER,
    BRIEF_SURFACES_START_MARKER,
    "<surface name> :: <type> :: <real/root/path> :: <audience> :: <internal true|false>",
    BRIEF_SURFACES_END_MARKER,
    BRIEF_GLOSSARY_START_MARKER,
    "<canonical term> :: <one-line definition>",
    BRIEF_GLOSSARY_END_MARKER,
    BRIEF_INVARIANTS_START_MARKER,
    "<one business invariant per line>",
    BRIEF_INVARIANTS_END_MARKER,
    BRIEF_CONFIDENTIAL_START_MARKER,
    "<fact> :: <why confidential> :: <where in code> :: <how it must NOT appear publicly>",
    BRIEF_CONFIDENTIAL_END_MARKER,
    BRIEF_JOURNEYS_START_MARKER,
    "<actor> :: <journey title> :: <one-line summary>",
    BRIEF_JOURNEYS_END_MARKER,
    BRIEF_SOURCES_START_MARKER,
    "<real/path/to/existing/source>",
    BRIEF_SOURCES_END_MARKER,
    "",
    "Do NOT save anything to any file and write NOTHING that matters outside the markers.",
  ].join("\n");
}

// ── Parser ────────────────────────────────────────────────────────────────────────────

/** Split di una riga strutturata sui campi ` :: `, `- `/`* ` iniziale rimosso, trim. */
function splitFields(line: string): string[] {
  const stripped = line.replace(/^[-*]\s*/, "").trim();
  return stripped.split(BRIEF_FIELD_SEP).map((f) => f.trim());
}

/** Token che significano INTERNO (true). */
const INTERNAL_TRUE = new Set(["true", "yes", "y", "internal", "staff", "admin"]);
/** Token che significano ESTERNO/PUBBLICO (false). */
const INTERNAL_FALSE = new Set(["false", "no", "n", "external", "public"]);

/**
 * Interpreta un token booleano `internal`. Ritorna `true`/`false` se riconosciuto,
 * `null` se NON è un booleano riconoscibile: chi chiama decide cosa fare del null
 * (SCARTA la superficie / attore interno), MAI silenziosamente false → pubblico.
 */
function parseInternalToken(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (INTERNAL_TRUE.has(v)) return true;
  if (INTERNAL_FALSE.has(v)) return false;
  return null;
}

/**
 * Normalizza un rootPath: slash iniziali/finali rimossi, slash ripetuti collassati.
 * Ritorna `null` (superficie da SCARTARE) se vuoto o con un segmento `..` (traversal):
 * nessun path radice legittimo del repo ne ha.
 */
function normalizeRootPath(p: string): string | null {
  const segs = p.trim().split("/").filter((seg) => seg !== "");
  if (segs.length === 0 || segs.includes("..")) return null;
  return segs.join("/");
}

/** Righe non vuote (dopo trim) del testo interno di un blocco. */
function nonEmptyLines(inner: string): string[] {
  return inner
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

function parseActors(output: string): BriefActor[] {
  const inner = extractBlock(output, BRIEF_ACTORS_START_MARKER, BRIEF_ACTORS_END_MARKER);
  if (inner === null) return [];
  const actors: BriefActor[] = [];
  for (const line of nonEmptyLines(inner)) {
    const fields = splitFields(line);
    const [name = "", description = ""] = fields;
    if (name === "") continue;
    // `internal` è l'ULTIMO campo: un ` :: ` spurio nella description non lo sposta.
    // Ultimo campo non riconoscibile come booleano → fail-closed verso INTERNO (true).
    const internal = parseInternalToken(fields[fields.length - 1] ?? "") ?? true;
    actors.push({ name, description, internal });
    if (actors.length >= CAP_ACTORS) break;
  }
  return actors;
}

function parseSurfaces(output: string): BriefSurface[] {
  const inner = extractBlock(output, BRIEF_SURFACES_START_MARKER, BRIEF_SURFACES_END_MARKER);
  if (inner === null) return [];
  const surfaces: BriefSurface[] = [];
  for (const line of nonEmptyLines(inner)) {
    const fields = splitFields(line);
    const [name = "", type = "", rootPathRaw = "", audience = ""] = fields;
    if (name === "") continue;
    const rootPath = normalizeRootPath(rootPathRaw);
    // rootPath assente/traversal → superficie SCARTATA (senza radice reale è inutile).
    if (rootPath === null) continue;
    // `internal` è l'ULTIMO campo: un ` :: ` spurio nell'audience lo sposterebbe. Se
    // l'ultimo campo NON è un booleano riconoscibile → SCARTA la superficie (direzione
    // pericolosa: un ADMIN classificato pubblico si porta dietro una verticale pubblica).
    const internal = parseInternalToken(fields[fields.length - 1] ?? "");
    if (internal === null) continue;
    surfaces.push({ name, type, rootPath, audience, internal });
    if (surfaces.length >= CAP_SURFACES) break;
  }
  return surfaces;
}

function parseGlossary(output: string): BriefGlossaryEntry[] {
  const inner = extractBlock(output, BRIEF_GLOSSARY_START_MARKER, BRIEF_GLOSSARY_END_MARKER);
  if (inner === null) return [];
  const entries: BriefGlossaryEntry[] = [];
  for (const line of nonEmptyLines(inner)) {
    const [term = "", ...rest] = splitFields(line);
    if (term === "") continue;
    entries.push({ term, definition: rest.join(BRIEF_FIELD_SEP).trim() });
    if (entries.length >= CAP_GLOSSARY) break;
  }
  return entries;
}

function parseInvariants(output: string): string[] {
  const inner = extractBlock(
    output,
    BRIEF_INVARIANTS_START_MARKER,
    BRIEF_INVARIANTS_END_MARKER,
  );
  if (inner === null) return [];
  const out: string[] = [];
  for (const line of nonEmptyLines(inner)) {
    const text = line.replace(/^[-*]\s*/, "").trim();
    if (text === "") continue;
    out.push(text);
    if (out.length >= CAP_INVARIANTS) break;
  }
  return out;
}

function parseConfidentialFacts(output: string): BriefConfidentialFact[] {
  const inner = extractBlock(
    output,
    BRIEF_CONFIDENTIAL_START_MARKER,
    BRIEF_CONFIDENTIAL_END_MARKER,
  );
  if (inner === null) return [];
  const facts: BriefConfidentialFact[] = [];
  for (const line of nonEmptyLines(inner)) {
    const [fact = "", reason = "", source = "", avoid = ""] = splitFields(line);
    if (fact === "") continue;
    facts.push({ fact, reason, source, avoid });
    if (facts.length >= CAP_FACTS) break;
  }
  return facts;
}

function parseJourneys(output: string): BriefJourney[] {
  const inner = extractBlock(output, BRIEF_JOURNEYS_START_MARKER, BRIEF_JOURNEYS_END_MARKER);
  if (inner === null) return [];
  const journeys: BriefJourney[] = [];
  for (const line of nonEmptyLines(inner)) {
    const [actor = "", title = "", ...rest] = splitFields(line);
    // Serve almeno un titolo per essere utile; l'attore può essere vuoto.
    if (actor === "" && title === "") continue;
    journeys.push({ actor, title, summary: rest.join(BRIEF_FIELD_SEP).trim() });
    if (journeys.length >= CAP_JOURNEYS) break;
  }
  return journeys;
}

function parseExistingSources(output: string): string[] {
  const inner = extractBlock(output, BRIEF_SOURCES_START_MARKER, BRIEF_SOURCES_END_MARKER);
  if (inner === null) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of nonEmptyLines(inner)) {
    const path = line.replace(/^[-*]\s*/, "").trim();
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= CAP_SOURCES) break;
  }
  return out;
}

function parseIdentity(output: string): string {
  const inner = extractBlock(
    output,
    BRIEF_IDENTITY_START_MARKER,
    BRIEF_IDENTITY_END_MARKER,
  );
  return inner === null ? "" : inner.trim();
}

/**
 * Parsa l'output del documentarista in `ProjectBrief`. BEST-EFFORT PER SEZIONE, non lancia
 * MAI: una sezione mancante o malformata → array vuoto (stringa vuota per identity), MAI
 * l'intero brief perso. Normalizza: rootPath senza slash iniziali/finali e senza `..`
 * (altrimenti la superficie è scartata); flag internal robusto; cap per sezione.
 *
 * Ritorna `{ reason }` SOLO se NESSUNA sezione è parsabile (output tutto-prosa, niente
 * marcatori riconoscibili): non c'è nulla di utile da persistere.
 */
export function parseBriefOutput(output: string): ProjectBrief | { reason: string } {
  const brief: ProjectBrief = {
    identity: parseIdentity(output),
    actors: parseActors(output),
    surfaces: parseSurfaces(output),
    glossary: parseGlossary(output),
    invariants: parseInvariants(output),
    confidentialFacts: parseConfidentialFacts(output),
    journeys: parseJourneys(output),
    existingSources: parseExistingSources(output),
  };

  const empty =
    brief.identity === "" &&
    brief.actors.length === 0 &&
    brief.surfaces.length === 0 &&
    brief.glossary.length === 0 &&
    brief.invariants.length === 0 &&
    brief.confidentialFacts.length === 0 &&
    brief.journeys.length === 0 &&
    brief.existingSources.length === 0;

  if (empty) return { reason: "no parsable brief sections" };
  return brief;
}

// ── Contesto per i prompt downstream ──────────────────────────────────────────────────

/** Opzioni di `briefPromptContext`. */
export interface BriefContextOptions {
  /** Se true, includi la sezione NEVER-disclose coi fatti riservati (solo product). */
  includeSecrets?: boolean;
}

/** Tronca a `max` caratteri con ellissi, senza spezzare a metà una parola quando facile. */
function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trimEnd()}…`;
}

/**
 * Rende il brief in un BLOCCO COMPATTO da iniettare nei prompt downstream: identity (1
 * riga), attori (nome + internal), glossario (term: definition), invarianti. Con
 * `includeSecrets` aggiunge la sezione NEVER-disclose. Per NON far riecheggiare il valore
 * sensibile a un agente che PRODUCE testo pubblico, si rende SOLO il divieto categorico
 * (`Never: <avoid>`); il fact letterale è il fallback solo quando `avoid` manca. Di default
 * i segreti NON sono inclusi (solo la pipeline product li vede). Progettato per restare
 * sotto ~1500 parole anche a cap pieni (definizioni troncate a 200 char).
 */
export function briefPromptContext(
  brief: ProjectBrief,
  opts?: BriefContextOptions,
): string {
  const lines: string[] = ["PROJECT CONTEXT — use this glossary and terminology consistently:"];

  if (brief.identity !== "") {
    lines.push("", `Identity: ${truncate(brief.identity, CONTEXT_IDENTITY_MAX)}`);
  }

  if (brief.actors.length > 0) {
    lines.push("", "Actors:");
    for (const a of brief.actors) {
      lines.push(`- ${a.name}${a.internal ? " (internal)" : ""}`);
    }
  }

  if (brief.glossary.length > 0) {
    lines.push("", "Glossary (use these exact terms):");
    for (const g of brief.glossary) {
      lines.push(`- ${g.term}: ${truncate(g.definition, CONTEXT_DEF_MAX)}`);
    }
  }

  if (brief.invariants.length > 0) {
    lines.push("", "Business invariants:");
    for (const inv of brief.invariants) {
      lines.push(`- ${truncate(inv, CONTEXT_DEF_MAX)}`);
    }
  }

  if (opts?.includeSecrets && brief.confidentialFacts.length > 0) {
    lines.push(
      "",
      "NEVER disclose the following confidential facts. Do NOT state them, imply them, or",
      "let them be inferred; if asked, neither confirm nor deny:",
    );
    for (const f of brief.confidentialFacts) {
      // Il valore letterale (es. "markup 18%") NON deve finire in un prompt che PRODUCE
      // testo pubblico: potrebbe riecheggiarlo. Quando c'è un `avoid` categorico lo usiamo
      // come solo divieto; il fact letterale è il fallback solo se avoid manca. Il valore
      // integrale resta nei dati del brief per l'auditor della Fase C.
      const avoid = f.avoid.trim();
      const rule =
        avoid !== ""
          ? `Never: ${truncate(avoid, CONTEXT_DEF_MAX)}`
          : truncate(f.fact, CONTEXT_DEF_MAX);
      lines.push(`- ${rule}`);
    }
  }

  return lines.join("\n");
}
