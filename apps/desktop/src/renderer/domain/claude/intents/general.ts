import type { CapabilityId } from "../../../data/types";
import type { Answer } from "../answers";
import type { IntentContext } from "../context";

/**
 * Le cose che il prototipo sa fare, nell'ordine dell'elenco (maintainer, 2
 * nov 2026: nove voci, con email e descrizione di D1; shape
 * claude-scenarios.md §3.5).
 */
export const CAPABILITIES: readonly CapabilityId[] = [
  "automation",
  "stalled",
  "spend",
  "archive",
  "addMember",
  "supportReply",
  "releaseNotes",
  "mailBody",
  "taskDescription",
];

/**
 * Una richiesta che il motore non riconosce: la risposta onesta (S0, area
 * 10b). Non un testo plausibile, ma cosa sa fare: la frase e l'elenco come
 * dato (`capabilities`), che chi guarda legge nella sua lingua.
 */
export async function general(_text: string, ctx: IntentContext): Promise<Answer> {
  return {
    actions: [],
    text: ctx.t("claude.answers.general"),
    capabilities: [...CAPABILITIES],
  };
}
