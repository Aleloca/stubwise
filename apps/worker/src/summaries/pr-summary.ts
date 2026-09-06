import { t, type Language } from "@stubwise/i18n";
import { capText, runAgentText } from "../agent/text.js";
import type { SummaryRunDeps } from "./plan-summary.js";

/**
 * Riassunto "in breve" della PR (fase 5): due frasi che dicono a chi non legge
 * codice cosa la pull request fa per chi usa il prodotto e cosa ha concluso la
 * review automatica.
 *
 * Stesso contratto BEST-EFFORT del riassunto del piano (vedi `plan-summary.ts`):
 * qualunque fallimento è `null`, mai un'eccezione. Qui il chiamante è
 * `review/run-review.ts`, che ha appena parsato un verdetto valido: una review
 * completata è il risultato che conta, il riassunto è la sua faccia leggibile.
 *
 * PROMPT INJECTION: titolo e descrizione della PR li scrive chi apre la PR, e
 * l'analisi la scrive l'agente di review sul diff — tutto input NON fidato.
 * Contenuto per costruzione: `permissionMode "plan"` su una dir temporanea
 * vuota, senza tool. Caso peggiore, un riassunto fuorviante in colonna.
 */

/** Tetto per OGNI blocco di input libero (descrizione della PR e analisi della
 * review) nel prompt: una descrizione di PR può essere un template lunghissimo,
 * e l'analisi di una review su un diff grosso arriva a decine di KB. */
export const PR_SUMMARY_INPUT_MAX_CHARS = 20_000;

export interface PrSummaryInput {
  lang: Language;
  prTitle: string;
  prBody: string;
  verdict: "approve" | "request_changes";
  /** Il markdown dell'analisi prodotta dalla review (il campo `summary` della
   * riga `pr_reviews`): è il testo tecnico che questo run traduce. */
  analysis: string;
}

export function buildPrSummaryPrompt(
  lang: Language,
  input: Omit<PrSummaryInput, "lang">,
): string {
  const marker = t(lang, "summary.truncated");
  return [
    `Pull request: ${input.prTitle}`,
    ``,
    `Description:`,
    "```",
    capText(input.prBody, PR_SUMMARY_INPUT_MAX_CHARS, marker),
    "```",
    ``,
    `Automatic review verdict: ${input.verdict}`,
    ``,
    `Automatic review analysis:`,
    "```",
    capText(input.analysis, PR_SUMMARY_INPUT_MAX_CHARS, marker),
    "```",
    ``,
    t(lang, "summary.pr.instructions"),
  ].join("\n");
}

/**
 * Genera il riassunto della PR. `null` se i riassunti sono spenti o se il run
 * non ha prodotto testo utile.
 */
export async function generatePrSummary(
  deps: SummaryRunDeps,
  input: PrSummaryInput,
): Promise<string | null> {
  if (deps.enabled === false) return null;

  try {
    return await runAgentText(deps.runner, {
      prompt: buildPrSummaryPrompt(input.lang, input),
      timeoutMs: deps.timeoutMs,
      ...(deps.model !== undefined ? { model: deps.model } : {}),
      ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
    });
  } catch {
    return null;
  }
}
