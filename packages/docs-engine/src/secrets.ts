/**
 * SECRETS — il VERIFICATORE fail-closed della Fase C: un agente separato, in registro da
 * RED-TEAMER, che controlla ogni pagina `product` GIÀ generata contro i fatti riservati del
 * brief PRIMA di pubblicarla. È un audit puramente TESTUALE: il prompt contiene tutto (i
 * fatti COMPLETI e il body della pagina), quindi non serve alcun accesso al filesystem.
 *
 * Differenza chiave rispetto ai prompt di generazione: là i fatti entrano SOLO come divieto
 * categorico (`Never: <avoid>`), per non far riecheggiare il valore sensibile a un agente
 * che PRODUCE testo pubblico (vedi `briefPromptContext`). QUI invece l'auditor DEVE conoscere
 * il valore letterale (fact+reason+avoid) per riconoscerlo nel testo: si dà tutto.
 *
 * ── CONTRATTO DI OUTPUT (documentato) ─────────────────────────────────────────────────
 *     ===VERDICT===
 *     CLEAN | VIOLATION
 *     ===DETAIL===
 *     <solo se VIOLATION: quale fatto + il passaggio incriminato citato>
 *
 * Il PARSER è FAIL-CLOSED: `CLEAN` è accettato SOLO con un match esplicito (case-insensitive)
 * del verdetto; QUALSIASI altra cosa — output vuoto, marcatore VERDICT assente, verdetto
 * diverso da CLEAN/VIOLATION ("ok", "maybe", …), prosa senza marcatori — diventa una
 * VIOLATION con detail `"unparseable audit output"`. Un output ambiguo non pubblica mai.
 *
 * ── RISCRITTURA MIRATA ────────────────────────────────────────────────────────────────
 * Su VIOLATION la pipeline (Fase C, worker) chiede UNA riscrittura mirata con
 * `buildSecretsRewritePrompt`: rimuovi/neutralizza SOLO il passaggio incriminato, tieni
 * intatto il resto. La riscrittura RIUSA i marcatori product `===PAGE===`/`===END PAGE===`
 * e si PARSA con `parseProductPageOutput` (già esistente), poi si ri-audita una volta; se
 * boccia ancora, la pagina è ESCLUSA (fail-closed).
 */

import type { BriefConfidentialFact } from "./brief.js";
import {
  PRODUCT_PAGE_END_MARKER,
  PRODUCT_PAGE_START_MARKER,
} from "./product.js";

// ── Marcatori del contratto di audit ──────────────────────────────────────────────────

/** Apre la riga del verdetto (`CLEAN` | `VIOLATION`). */
export const SECRETS_VERDICT_MARKER = "===VERDICT===";
/** Apre il dettaglio (popolato SOLO su VIOLATION: fatto + passaggio incriminato). */
export const SECRETS_DETAIL_MARKER = "===DETAIL===";

/** Delimitatori del body della pagina reso nel prompt di audit (leggibili, non i marker). */
const AUDIT_PAGE_START = "----- BEGIN PAGE -----";
const AUDIT_PAGE_END = "----- END PAGE -----";

/** Cap del detail di una violazione (evita log/DB gonfiati da un audit prolisso). */
const DETAIL_MAX = 500;

// ── Tipi ──────────────────────────────────────────────────────────────────────────────

/** Input del prompt di audit: la pagina da verificare e i fatti riservati COMPLETI. */
export interface SecretsAuditInput {
  /** Titolo della pagina (contesto per l'auditor). */
  pageTitle: string;
  /** Body markdown della pagina, reso in un blocco delimitato. */
  body: string;
  /** I fatti riservati del brief, resi PER INTERO (l'auditor deve conoscerne il valore). */
  confidentialFacts: BriefConfidentialFact[];
}

/** Esito del parse dell'audit. `clean` solo con match esplicito; ogni ambiguità → `violation`. */
export type SecretsAuditResult =
  | { verdict: "clean" }
  | { verdict: "violation"; detail: string };

/** Input del prompt di riscrittura mirata (dopo una VIOLATION). */
export interface SecretsRewriteInput {
  /** Titolo della pagina. */
  pageTitle: string;
  /** Body markdown corrente (con il passaggio incriminato). */
  body: string;
  /** Il dettaglio della violazione dall'audit: cosa neutralizzare. */
  detail: string;
}

// ── Prompt: audit (red-teamer) ─────────────────────────────────────────────────────────

/** Rende un fatto riservato COMPLETO (value+reason+avoid) come voce di lista per l'auditor. */
function renderFact(f: BriefConfidentialFact, i: number): string[] {
  const lines = [`${i + 1}. FACT: ${f.fact.trim()}`];
  const reason = f.reason.trim();
  const avoid = f.avoid.trim();
  if (reason !== "") lines.push(`   WHY CONFIDENTIAL: ${reason}`);
  if (avoid !== "") lines.push(`   MUST NOT APPEAR AS: ${avoid}`);
  return lines;
}

/**
 * Costruisce il prompt del VERIFICATORE (red-teamer). L'audit è testuale: i fatti riservati
 * entrano PER INTERO (l'auditor deve conoscere il valore per riconoscerlo nel testo, a
 * differenza dei prompt di generazione), il body della pagina è reso in un blocco delimitato.
 * L'istruzione centrale: è VIOLAZIONE se la pagina AFFERMA, IMPLICA o permette di DEDURRE un
 * fatto — anche per omissioni conspicue o dando abbastanza numeri per derivarlo. Nessun
 * accesso al filesystem: il prompt contiene tutto.
 */
export function buildSecretsAuditPrompt(input: SecretsAuditInput): string {
  const facts =
    input.confidentialFacts.length > 0
      ? input.confidentialFacts.flatMap(renderFact).join("\n")
      : "(no confidential facts were provided)";

  return [
    "You are a RED-TEAMER auditing a documentation page for leaks of confidential business",
    "facts. This page WILL BE PUBLISHED on a PUBLIC website, readable by anyone — including",
    "competitors and suppliers. Your only job is to decide whether it must be blocked.",
    "",
    "Audit the page below against the CONFIDENTIAL FACTS. It is a VIOLATION if the page",
    "STATES, IMPLIES, or ALLOWS A READER TO INFER any of these facts — including:",
    "- by giving enough concrete numbers to DERIVE a confidential figure (e.g. a margin,",
    "  markup, wholesale cost or rate);",
    "- by CONSPICUOUS OMISSION patterns that reveal the fact by what is carefully left out;",
    "- by naming a confidential supplier, competitor or internal term.",
    "When in doubt, treat it as a VIOLATION. Do NOT be charitable: assume a motivated reader.",
    "",
    "CONFIDENTIAL FACTS (each with the real value — recognize it in any form):",
    facts,
    "",
    `PAGE TITLE: ${input.pageTitle.trim()}`,
    "PAGE BODY (audit everything between the delimiters):",
    AUDIT_PAGE_START,
    input.body,
    AUDIT_PAGE_END,
    "",
    "OUTPUT CONTRACT — obey this EXACTLY. Emit the verdict on the line after the VERDICT",
    "marker (the single word CLEAN or VIOLATION), then the DETAIL marker. On VIOLATION, after",
    "the DETAIL marker name WHICH fact is leaked and QUOTE the offending passage from the",
    "page. On CLEAN, leave the detail empty. Write NOTHING that matters outside these markers.",
    SECRETS_VERDICT_MARKER,
    "CLEAN | VIOLATION",
    SECRETS_DETAIL_MARKER,
    "<only on VIOLATION: which fact + the quoted offending passage>",
  ].join("\n");
}

// ── Parser: audit (fail-closed) ────────────────────────────────────────────────────────

/**
 * Estrae il testo tra `startMarker` (esclusa la sua riga) e `endMarker`/fine. I marcatori
 * sono riconosciuti SOLO come riga intera (dopo trim), come nel resto del motore. Ritorna
 * `null` se `startMarker` non compare come riga intera.
 */
function sliceAfterMarker(
  lines: string[],
  startMarker: string,
  endMarker: string,
): string | null {
  const start = lines.findIndex((l) => l.trim() === startMarker);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() === endMarker);
  const inner = end === -1 ? rest : rest.slice(0, end);
  return inner.join("\n");
}

/** Il risultato fail-closed: ogni ambiguità collassa qui. */
const UNPARSEABLE: SecretsAuditResult = {
  verdict: "violation",
  detail: "unparseable audit output",
};

/**
 * Parsa l'output dell'audit, FAIL-CLOSED. `CLEAN` è accettato SOLO con un match esplicito
 * (case-insensitive) della prima riga non vuota dopo il marcatore VERDICT. Qualsiasi altra
 * cosa — marcatore VERDICT assente, verdetto diverso da CLEAN/VIOLATION, output vuoto, prosa
 * senza marcatori — diventa una VIOLATION con detail `"unparseable audit output"`. Il detail
 * di una violazione riconosciuta è troncato a `DETAIL_MAX` (500) char. Non lancia MAI.
 */
export function parseSecretsAuditOutput(output: string): SecretsAuditResult {
  const lines = output.split("\n");

  const verdictBlock = sliceAfterMarker(
    lines,
    SECRETS_VERDICT_MARKER,
    SECRETS_DETAIL_MARKER,
  );
  if (verdictBlock === null) return UNPARSEABLE;

  const verdictLine = verdictBlock
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  const verdict = (verdictLine ?? "").toLowerCase();

  if (verdict === "clean") return { verdict: "clean" };
  if (verdict !== "violation") return UNPARSEABLE;

  // VIOLATION riconosciuta: il detail è tutto ciò che segue il marcatore DETAIL (può
  // legittimamente essere vuoto), troncato al cap.
  const detailBlock = sliceAfterMarker(lines, SECRETS_DETAIL_MARKER, SECRETS_VERDICT_MARKER);
  const detail = (detailBlock ?? "").trim().slice(0, DETAIL_MAX);
  return { verdict: "violation", detail };
}

// ── Prompt: riscrittura mirata ─────────────────────────────────────────────────────────

/**
 * Costruisce il prompt della RISCRITTURA MIRATA dopo una VIOLATION: rimuovi o neutralizza
 * SOLO il passaggio segnalato in `detail`, tieni INTATTO tutto il resto della pagina. Riusa
 * i marcatori product `===PAGE===`/`===END PAGE===`, così l'output si parsa con
 * `parseProductPageOutput` (già esistente) come qualsiasi altra pagina product.
 */
export function buildSecretsRewritePrompt(input: SecretsRewriteInput): string {
  return [
    "A confidentiality audit flagged a leak in the PUBLIC documentation page below. Rewrite",
    "the page to REMOVE or NEUTRALIZE the flagged passage so it no longer states, implies or",
    "lets a reader infer the confidential fact. Keep EVERYTHING ELSE intact: same structure,",
    "same helpful content, same register (second person, no internals). Change as little as",
    "possible beyond the flagged passage — do not rewrite the whole page.",
    "",
    "AUDIT FINDING (the passage to fix):",
    input.detail.trim(),
    "",
    `PAGE TITLE: ${input.pageTitle.trim()}`,
    "CURRENT PAGE BODY:",
    AUDIT_PAGE_START,
    input.body,
    AUDIT_PAGE_END,
    "",
    "OUTPUT CONTRACT — obey this EXACTLY. Emit the FULL corrected page body between the two",
    "markers below, each marker ALONE on its own line, and NOTHING that matters outside them.",
    "Start the body directly with `###` sub-sections; do not wrap it in a code fence. Do NOT",
    "save anything to any file and add NO meta-commentary.",
    PRODUCT_PAGE_START_MARKER,
    "<the full corrected markdown body of the page>",
    PRODUCT_PAGE_END_MARKER,
  ].join("\n");
}
