import { visitSteps } from "@stubwise/shared";
import type { AutomationFlow } from "../../data/types";

/**
 * Il flusso da salvare senza segnaposto (registro, A11 r.1414, revisione del
 * lotto 2-3): un posto persona (incaricato, chi avvisare, chi approva) con
 * `hidden-<n>` torna vuoto (`{}`), e il livello dati ci rimette la persona
 * della versione di prima. Un segnaposto mandato è `invalid: flow`.
 */
export function withoutPlaceholders(flow: AutomationFlow): AutomationFlow {
  const out = structuredClone(flow);
  visitSteps(out.steps, (step) => {
    const s = step as { assignee?: unknown; who?: unknown; approval?: { who?: unknown } };
    for (const slot of [s.assignee, s.who, s.approval?.who]) {
      if (!slot || typeof slot !== "object") continue;
      const target = slot as { personId?: unknown };
      if (typeof target.personId === "string" && target.personId.startsWith("hidden-"))
        delete target.personId;
    }
  });
  return out;
}
