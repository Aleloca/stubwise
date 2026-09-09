import { t, type Language } from "@stubwise/i18n";
import type { AgentRunner } from "../agent/runner.js";
import { capText, runAgentText } from "../agent/text.js";
import type { ResolvedProvider } from "../providers/chain.js";

/**
 * Riassunto "in breve" di un job AI FALLITO (fase 7, Task 9): tre frasi che
 * spiegano a chi non legge codice cosa si stava provando a fare, cosa non ha
 * funzionato e cosa fare adesso.
 *
 * BEST-EFFORT, come `plan-summary.ts`/`pr-summary.ts` — ma DECOUPLED dalla
 * transazione di fallimento in un modo che loro due non sono: `plan_summary`
 * vive e muore con `plan_text` nello STESSO UPDATE guardato che parcheggia il
 * job (vedi il docblock di `parkForPlanApproval`), perché il gate di
 * approvazione ha bisogno del riassunto atomico con lo stato. Un job
 * `failed` non gate-a niente: non c'è nessuna finestra di correttezza da
 * proteggere, e la notifica `job.failed` — quella che davvero conta arrivi
 * in fretta a chi aspetta — è già stata pubblicata PRIMA che questo modulo
 * venga chiamato (vedi i chiamanti in `pipeline/fix.ts`/`pipeline/triage.ts`:
 * `notifyFailed` prima, `generateFailureSummary` dopo). Un run da decine di
 * secondi qui non ritarda mai la notifica del fallimento — che il worker ha
 * già scritto in inbox/outbox — solo l'aggiunta successiva del riassunto,
 * che la card mostra quando arriva.
 *
 * LINGUA e PROMPT INJECTION: stessa forma di `plan-summary.ts` — lingua nel
 * testo delle istruzioni (mai cablata), run `permissionMode` di default
 * "plan" su una dir temporanea vuota, senza tool: il log dell'agente che ha
 * fallito è testo non fidato quanto un piano.
 */

/** Tetto dell'input (log + errore) nel prompt del riassunto. Il log di un
 * fix può arrivare a diversi KB; il tetto è una salvaguardia, non una
 * potatura attesa. */
export const FAILURE_SUMMARY_INPUT_MAX_CHARS = 20_000;

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

export interface FailureSummaryInput {
  lang: Language;
  ticketTitle: string;
  /** Messaggio d'errore registrato da `failJob` (`ai_jobs.error`). */
  error: string;
  /** Log del job (`ai_jobs.log`): dà all'agente il contesto di COSA si stava
   * facendo, non solo il messaggio d'errore finale. */
  log: string;
}

/**
 * Prompt del riassunto del fallimento. Struttura neutra (etichette e recinto
 * del testo) più le istruzioni dal catalogo, che portano con sé la lingua.
 */
export function buildFailureSummaryPrompt(
  lang: Language,
  input: Pick<FailureSummaryInput, "ticketTitle" | "error" | "log">,
): string {
  const log = capText(input.log, FAILURE_SUMMARY_INPUT_MAX_CHARS, t(lang, "summary.truncated"));
  return [
    `Ticket: ${input.ticketTitle}`,
    ``,
    `Error: ${input.error}`,
    ``,
    `Log:`,
    "```",
    log,
    "```",
    ``,
    t(lang, "summary.failure.instructions"),
  ].join("\n");
}

/**
 * Genera il riassunto del fallimento. `null` quando i riassunti sono spenti
 * o quando il run non ha prodotto testo utile — MAI un'eccezione: un
 * riassunto fallito non deve mai far fallire la registrazione del
 * fallimento stesso (che è già committata quando questa funzione gira).
 */
export async function generateFailureSummary(
  deps: SummaryRunDeps,
  input: FailureSummaryInput,
): Promise<string | null> {
  if (deps.enabled === false) return null;

  try {
    return await runAgentText(deps.runner, {
      prompt: buildFailureSummaryPrompt(input.lang, input),
      timeoutMs: deps.timeoutMs,
      ...(deps.model !== undefined ? { model: deps.model } : {}),
      ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
    });
  } catch {
    // Timeout, spawn fallito, provider al limite: il riassunto è un extra,
    // il fallimento è già registrato e notificato. Nessuna eccezione esce
    // di qui.
    return null;
  }
}
