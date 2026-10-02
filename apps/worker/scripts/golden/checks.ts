/**
 * Pezzi PURI degli scenari golden: l'elenco degli scenari e il check su
 * `ask_user`. Stanno fuori da `run.ts` per una ragione sola: `run.ts` lancia
 * `main()` all'import, quindi un test non potrebbe importarlo. Qui non c'è
 * niente che parli col CLI, col modello o con git — `checks.test.ts` li prova
 * senza spendere una chiamata.
 */

// Solo il TIPO: `import type` è cancellato a compilazione (vedi run.ts, loadRuntime).
import type { AskUserFileResult } from "../../src/pipeline/ask-user.js";

/** Gli scenari, nell'ordine in cui girano quando non se ne sceglie nessuno. */
export const SCENARIO_NAMES = ["plan-only", "ask-user", "no-ask", "execute", "correction"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(value);
}

export interface Check {
  name: string;
  passed: boolean;
  /** Cosa si è osservato: è la riga che un umano legge quando un check è rosso. */
  detail: string;
}

/** Cosa ci si aspetta dall'agente davanti a `ask_user` cablato. */
export type AskUserExpectation = "asks" | "does-not-ask";

/** Cosa dice il file-bridge di `ask_user`, in una riga. */
function describeQuestion(question: AskUserFileResult): string {
  switch (question.kind) {
    case "question":
      return `domanda registrata: "${question.payload.question}" (${question.payload.options.length} opzioni)`;
    case "absent":
      return "nessun file-bridge: l'agente non ha chiesto nulla";
    case "malformed":
      return `file-bridge inservibile: ${question.reason}`;
  }
}

/**
 * Il check su `ask_user`, nei due versi.
 *
 * - `asks` (scenario `ask-user`): passa solo con una domanda VALIDA. Un
 *   file-bridge inservibile è rosso: la pipeline non saprebbe parcheggiare il
 *   job, e la domanda andrebbe persa.
 * - `does-not-ask` (scenario `no-ask`): passa solo se il file-bridge è
 *   ASSENTE. Anche un file malformato è rosso: vuol dire che l'agente il tool
 *   l'ha chiamato, ed è proprio la domanda inutile che questo verso misura.
 */
export function askUserCheck(question: AskUserFileResult, expectation: AskUserExpectation): Check {
  if (expectation === "asks") {
    return {
      name: "ask_user chiamato",
      passed: question.kind === "question",
      detail: describeQuestion(question),
    };
  }
  return {
    name: "ask_user NON chiamato",
    passed: question.kind === "absent",
    detail:
      question.kind === "absent"
        ? "nessun file-bridge: l'agente non ha chiesto nulla"
        : `l'agente ha chiesto, ma la risposta si ricava dal repo — ${describeQuestion(question)}`,
  };
}
