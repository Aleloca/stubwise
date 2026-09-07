import { t, type Language } from "@stubwise/i18n";
import type { AgentRunner } from "../agent/runner.js";
import { capText, runAgentText } from "../agent/text.js";
import type { ResolvedProvider } from "../providers/chain.js";

/**
 * Riassunto "in breve" del PIANO di fix (fase 5): due o tre frasi che spiegano a
 * chi non legge codice cosa il piano cambia, cosa tocca e cosa resta fuori.
 *
 * BEST-EFFORT, come ogni colonna AI di questo repo: qualunque cosa vada storta
 * (riassunti spenti, piano vuoto, run crashato, agente in timeout o al limite di
 * rate) produce `null`, MAI un'eccezione verso il chiamante. Il motivo è
 * strutturale: chi chiama è `pipeline/fix.ts` subito prima di
 * `parkForPlanApproval`, e un piano che non si parcheggia perché il riassunto è
 * fallito sarebbe un job perso per un abbellimento.
 *
 * LINGUA: arriva dal chiamante, che l'ha risolta UNA VOLTA per job con
 * `getContentLanguage(db)` — non la si rilegge qui, altrimenti un cambio
 * dell'impostazione a metà job spezzerebbe l'invariante "un job parla una lingua
 * sola". Il testo delle istruzioni è già scritto NELLA lingua di destinazione
 * (catalogo `summary.plan.instructions`): nessuna lingua è cablata nel prompt,
 * che è l'errore del report giornaliero ("Scrivi in ITALIANO" sempre).
 *
 * PROMPT INJECTION: titolo del ticket e testo del piano sono input non fidato
 * (il piano lo scrive l'agente, il titolo un utente). Contenuto per costruzione:
 * il run è `permissionMode "plan"` su una dir temporanea vuota, senza tool. Il
 * caso peggiore è un riassunto fuorviante salvato in colonna, non un'azione.
 */

/** Tetto dell'input (il testo del piano) nel prompt del riassunto. Un piano è
 * di norma qualche KB; il tetto è una salvaguardia contro output patologici
 * dell'agente di pianificazione, non una potatura attesa. */
export const PLAN_SUMMARY_INPUT_MAX_CHARS = 40_000;

export interface SummaryRunDeps {
  runner: AgentRunner;
  /** Timeout complessivo del run in ms. */
  timeoutMs: number;
  /** Modello del riassunto; omesso = default del CLI. */
  model?: string;
  /** Credenziale del provider AI del job; omessa = auth del container. */
  provider?: ResolvedProvider;
  /** Interruttore `SUMMARIES_ENABLED`: false = nessun run, riassunto `null`.
   * Assente = acceso (default di prodotto). */
  enabled?: boolean;
}

export interface PlanSummaryInput {
  lang: Language;
  ticketTitle: string;
  planText: string;
}

/**
 * Prompt del riassunto del piano. Struttura neutra (etichette e recinto del
 * testo) più le istruzioni dal catalogo, che portano con sé la lingua.
 */
export function buildPlanSummaryPrompt(
  lang: Language,
  input: Pick<PlanSummaryInput, "ticketTitle" | "planText">,
): string {
  const plan = capText(
    input.planText,
    PLAN_SUMMARY_INPUT_MAX_CHARS,
    t(lang, "summary.truncated"),
  );
  return [
    `Ticket: ${input.ticketTitle}`,
    ``,
    `Plan:`,
    "```",
    plan,
    "```",
    ``,
    t(lang, "summary.plan.instructions"),
  ].join("\n");
}

/**
 * Genera il riassunto del piano. `null` quando non c'è nulla da riassumere,
 * quando i riassunti sono spenti o quando il run non ha prodotto testo utile.
 */
export async function generatePlanSummary(
  deps: SummaryRunDeps,
  input: PlanSummaryInput,
): Promise<string | null> {
  if (deps.enabled === false) return null;
  if (input.planText.trim().length === 0) return null;

  try {
    return await runAgentText(deps.runner, {
      prompt: buildPlanSummaryPrompt(input.lang, input),
      timeoutMs: deps.timeoutMs,
      ...(deps.model !== undefined ? { model: deps.model } : {}),
      ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
    });
  } catch {
    // Timeout, spawn fallito, provider al limite: il riassunto è un extra, il
    // piano va parcheggiato comunque. Nessuna eccezione esce di qui.
    return null;
  }
}
