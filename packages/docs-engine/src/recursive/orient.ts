/**
 * ORIENTAMENTO — primo stadio del motore ricorsivo a DAG.
 *
 * Un agente perlustra il repo (read-only), rileva lo stack/framework, separa
 * ARCHITETTURA da RUMORE (`plans`/`docs`/`manual`/`guides` = artefatti di sessione,
 * esclusi dal tecnico) e produce un PIANO strutturato con due child-list: le unità
 * TECNICHE di 1° livello e le capability FUNZIONALI di 1° livello. Il piano è
 * machine-parsed col contratto a marcatori (`buildOrientPrompt`/`parseOrientPlan`) — mai
 * formato libero. Logica pura: il survey del repo lo fornisce il chiamante (worker).
 *
 * Output (contratto):
 *
 *     ===ORIENTATION PLAN===
 *     <classificazione/note in prosa: SOLO qui, dentro il blocco PLAN>
 *     ===TECHNICAL UNITS===
 *     - <title> :: <path> :: <why>
 *     …
 *     ===END TECHNICAL UNITS===
 *     ===FUNCTIONAL CAPABILITIES===
 *     - <title> :: <path1, path2, …> :: <why>
 *     …
 *     ===END FUNCTIONAL CAPABILITIES===
 *     ===END ORIENTATION PLAN===
 */

import {
  ORIENT_END_MARKER,
  ORIENT_FUNCTIONAL_END_MARKER,
  ORIENT_FUNCTIONAL_START_MARKER,
  ORIENT_START_MARKER,
  ORIENT_TECHNICAL_END_MARKER,
  ORIENT_TECHNICAL_START_MARKER,
  parseChildBlock,
  type ChildSpec,
} from "./contract.js";

/**
 * Costruisce il prompt di orientamento. `survey` è una descrizione compatta del repo
 * (entry top-level + manifest chiave) preparata dal chiamante. `briefContext` è la
 * porzione compatta del PROJECT BRIEF (`briefPromptContext`) prodotto dal documentarista
 * nel primo step dell'orientamento — opzionale: senza brief il prompt è identico a prima
 * (retrocompatibilità). Il prompt istruisce a:
 * (1) rilevare lo stack/framework e ragionare sulle sue convenzioni;
 * (2) classificare le cartelle top-level ARCHITETTURA vs RUMORE-DI-PROCESSO, SPIEGANDO
 *     (la documentazione scritta dagli sviluppatori — README, ADR, docs/ — NON è rumore:
 *     è una FONTE da considerare; solo gli artefatti di processo tipo plans/ vanno esclusi);
 * (3) produrre il piano con le due child-list nel formato del contratto, niente prosa
 *     fuori dai marcatori.
 */
export function buildOrientPrompt(survey: string, briefContext?: string): string {
  const briefBlock =
    briefContext && briefContext.trim() !== ""
      ? [briefContext.trim(), ""]
      : [];
  return [
    "You are ORIENTING yourself in a software repository to plan its documentation.",
    "You are running READ-ONLY in the repository working directory: inspect files as",
    "needed (manifests, config, entry points, folder structure) to ground your plan in",
    "what the repository ACTUALLY is. Do not invent structure that is not there.",
    "",
    ...briefBlock,
    "Below is a compact survey of the repository (top-level entries + key manifests).",
    "Use it as a starting point, then read further as needed.",
    "",
    "REPOSITORY SURVEY:",
    survey.trim() || "(no survey provided)",
    "",
    "DO THREE THINGS:",
    "",
    "1. DETECT THE STACK / FRAMEWORK and reason about its conventions. State what stack",
    "   and framework(s) this is, and how that shapes where the real architecture lives",
    "   (e.g. a Next.js app-router app keeps user-facing code under its routes folder; a",
    "   monorepo keeps deployable units under apps/ and shared code under packages/).",
    "",
    "2. CLASSIFY the top-level folders as ARCHITECTURE vs PROCESS-NOISE, and EXPLAIN each",
    "   classification briefly (this is auditable). PROCESS-NOISE = session/process",
    "   scratch artifacts that are NOT product architecture and MUST be excluded from the",
    "   technical documentation: planning notes and scratch dirs (e.g. folders like",
    "   plans/, scratch/). Documentation WRITTEN BY DEVELOPERS about the product — README",
    "   files, ADRs, hand-written docs/ pages — is NOT noise: it is a SOURCE to consider",
    "   when planning the pages. ARCHITECTURE = the code that is the actual product/system.",
    "   Only ARCHITECTURE folders may appear as technical units.",
    "",
    "3. PRODUCE THE PLAN as TWO child-lists:",
    "   - TECHNICAL UNITS: the first-level units of the codebase that each deserve their",
    "     own page (the natural top-level decomposition of the ARCHITECTURE — NOT the",
    "     context-noise). One per line.",
    "   - FUNCTIONAL CAPABILITIES: the first-level product capabilities (what the product",
    "     lets users do), described from the user's point of view. One per line.",
    "",
    "OUTPUT CONTRACT — obey this EXACTLY. Put EVERYTHING between the PLAN markers.",
    "Write no free prose outside the markers. Inside the PLAN block, your classification/",
    "reasoning prose goes BEFORE the first child-list. Each child-list is delimited by its",
    "own markers, each marker ALONE on its own line.",
    "",
    "Each child line uses this EXACT format (fields separated by ' :: ', a leading '- '):",
    "  - <title> :: <paths> :: <why>",
    "where <title> is a short human label, <paths> is the source path(s) covered (a single",
    "path for a technical unit; one or more comma-separated paths that IMPLEMENT a",
    "capability for a functional one), and <why> is a brief reason. Title is required;",
    "why may be brief but include it.",
    "",
    ORIENT_START_MARKER,
    "<your stack detection + folder classification/reasoning prose here>",
    ORIENT_TECHNICAL_START_MARKER,
    "- <technical unit title> :: <path> :: <why this is a first-level unit>",
    ORIENT_TECHNICAL_END_MARKER,
    ORIENT_FUNCTIONAL_START_MARKER,
    "- <capability title> :: <path(s) implementing it> :: <why this is a capability>",
    ORIENT_FUNCTIONAL_END_MARKER,
    ORIENT_END_MARKER,
    "",
    "Do NOT save anything to any file, do NOT mention plan files, and write NOTHING",
    "outside the PLAN markers.",
  ].join("\n");
}

/** Il piano di orientamento parsato: le due child-list + le note (prosa del blocco PLAN). */
export interface OrientPlan {
  technical: ChildSpec[];
  functional: ChildSpec[];
  /** La prosa di classificazione/reasoning prima della prima child-list (auditabile). */
  notes?: string;
}

/**
 * Parsa e VALIDA il piano di orientamento. Richiede ENTRAMBE le child-list (i marcatori
 * tecnici E funzionali presenti); ritorna `null` se mancano (output non parsabile, no
 * formato libero). Le `notes` sono la prosa nel blocco PLAN prima della prima child-list.
 * Una child-list presente ma vuota è accettata (lista vuota), ma in pratica l'orientamento
 * dovrebbe popolarle entrambe; la validazione "entrambe presenti" sta sui MARCATORI.
 */
export function parseOrientPlan(output: string): OrientPlan | null {
  const technical = parseChildBlock(
    output,
    ORIENT_TECHNICAL_START_MARKER,
    ORIENT_TECHNICAL_END_MARKER,
  );
  const functional = parseChildBlock(
    output,
    ORIENT_FUNCTIONAL_START_MARKER,
    ORIENT_FUNCTIONAL_END_MARKER,
  );
  // Entrambe le child-list sono OBBLIGATORIE: marcatori mancanti → output invalido.
  if (technical === null || functional === null) return null;

  const notes = extractNotes(output);
  const plan: OrientPlan = {
    technical: technical.children,
    functional: functional.children,
  };
  if (notes !== "") plan.notes = notes;
  return plan;
}

/**
 * Estrae la prosa di classificazione: il testo tra `ORIENT_START_MARKER` e la prima
 * child-list (`ORIENT_TECHNICAL_START_MARKER`). Ritorna "" se non c'è.
 */
function extractNotes(output: string): string {
  const lines = output.split("\n");
  const start = lines.findIndex((l) => l.trim() === ORIENT_START_MARKER);
  if (start === -1) return "";
  const firstList = lines.findIndex(
    (l, i) => i > start && l.trim() === ORIENT_TECHNICAL_START_MARKER,
  );
  const end = firstList === -1 ? lines.length : firstList;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}
