/**
 * SYNTHESIZE — sintesi di un nodo-ramo quando i suoi figli sono completi.
 *
 * L'agente riceve il proprio intro + i titoli/riassunti dei figli e scrive l'OVERVIEW
 * dell'area che LINKA i figli (un indice/sommario), coerente col registro dell'albero
 * (tecnico = per sviluppatori; funzionale = linguaggio non tecnico). Le foglie non
 * sintetizzano. Niente codice da leggere: la sintesi lavora sui riassunti dei figli.
 *
 * Output (contratto):
 *
 *     ===SYNTHESIS BODY===
 *     <markdown dell'overview che linka i figli>
 *     ===END SYNTHESIS BODY===
 */

import {
  SYNTH_BODY_END_MARKER,
  SYNTH_BODY_START_MARKER,
  briefContextSection,
  validateBody,
  type BodyRejection,
} from "./contract.js";
import type { DocTree } from "./explore.js";

/** Un figlio del nodo da sintetizzare: titolo + riassunto breve (per l'indice). */
export interface ChildSummary {
  title: string;
  summary: string;
}

/** Input del prompt di sintesi. */
export interface SynthesizeInput {
  tree: DocTree;
  /** Titolo del nodo da sintetizzare. */
  title: string;
  /** Intro/contesto del nodo (es. il piano del padre o l'orientamento). */
  intro: string;
  /** I figli `done`, con titolo e riassunto, da linkare nell'indice. */
  children: ChildSummary[];
}

/** Lunghezza massima del riassunto di un figlio incluso nel prompt (prompt bounded). */
const MAX_CHILD_SUMMARY_CHARS = 600;

/**
 * Costruisce il prompt di sintesi: scrivi l'OVERVIEW dell'area che presenta e LINKA i
 * figli (un indice ragionato), nel registro coerente con l'albero. Stesso contratto a
 * marcatori + anti-meta degli altri output.
 *
 * `briefContext` (opzionale, prodotto da `briefPromptContext`) è anteposto come sezione
 * PROJECT CONTEXT PRIMA delle istruzioni dell'overview, per la coerenza di glossario e
 * nomi canonici. Assente/vuoto → prompt byte-identico a prima.
 */
export function buildSynthesizePrompt(
  input: SynthesizeInput,
  briefContext?: string,
): string {
  const register =
    input.tree === "technical"
      ? [
          "REGISTER: technical, for developers. You may use precise technical terms.",
        ]
      : [
          "REGISTER: plain, NON-TECHNICAL, for a business/product reader. Do NOT expose",
          "file paths, code identifiers, framework or library names, or programming jargon.",
        ];

  const childLines = input.children.map((c) => {
    const summary = c.summary.trim().slice(0, MAX_CHILD_SUMMARY_CHARS);
    return `- ${c.title}: ${summary || "(no summary)"}`;
  });

  return [
    ...briefContextSection(briefContext),
    "You are writing the OVERVIEW page of a documentation area: an INDEX that introduces",
    "the area and presents its sub-pages (its children) as a coherent table of contents,",
    "so a reader understands what the area covers and where to go next.",
    "",
    `Area title: ${input.title}`,
    ...register,
    "",
    "Context/intro for this area (for orientation, do not copy verbatim):",
    input.intro.trim() || "(none)",
    "",
    "The children (sub-pages) to introduce and link, with their summaries:",
    ...(childLines.length > 0 ? childLines : ["- (no children)"]),
    "",
    "WRITE the overview: a short introduction to the area, then a clear, linked index of",
    "the children — for EACH child, name it (as a heading or list item matching its title)",
    "and say in a sentence or two what it covers and why a reader would open it. Make the",
    "children easy to navigate to. Be coherent with the register above. Use `###`",
    "sub-sections; do NOT begin with a top-level `#`/`##` title (the page title is rendered",
    "separately by the UI and would be duplicated).",
    "",
    "OUTPUT CONTRACT — obey this EXACTLY. Your ENTIRE response must contain the page body",
    "BETWEEN these two markers, each ALONE on its own line; anything outside is ignored:",
    SYNTH_BODY_START_MARKER,
    "<the full markdown body of the overview>",
    SYNTH_BODY_END_MARKER,
    "Write ONLY the documentation. Do NOT save anything to any file and do NOT mention",
    "files or plans (no \"the plan file\"). Do NOT add meta-commentary, preamble or closing",
    "remarks such as \"the documentation page is…\", \"I now have…\", \"here is the markdown\"",
    "or \"let me know if…\". Do not wrap the body in a code fence.",
  ].join("\n");
}

/**
 * Parsa e VALIDA l'output di sintesi. Ritorna `{ body }` se valido oppure `{ reason }`
 * (uno di `BodyRejection`: marcatori mancanti / corpo vuoto / troppo corto / meta).
 */
export function parseSynthesisOutput(
  output: string,
): { body: string } | { reason: BodyRejection } {
  const res = validateBody(output, SYNTH_BODY_START_MARKER, SYNTH_BODY_END_MARKER);
  if (res.body === undefined) return { reason: res.reason };
  return { body: res.body };
}
