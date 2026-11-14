import { supportState as deriveSupportState, type SupportStateInput } from "@stubwise/shared";
import type { SupportConversation } from "../../data/model";

// Lo stato di una conversazione di Support (shape support.md §5 [A 2]): la
// regola è UNA, in `@stubwise/shared` (area 8, F3), con l'ingresso neutro del
// server (esito, giudizio dopo il silenzio, messaggi). Qui il prototipo la
// legge da una sua conversazione: l'esito è la richiesta legata o la task.
// Con un esito la conversazione è CHIUSA (`request_open`): un messaggio nuovo
// del cliente apre la successiva.

export {
  SUPPORT_STATE_ORDER,
  SUPPORT_TRIAGE_IDLE_MINUTES,
  wishTitle,
  type SupportState,
  type SupportStateInput,
} from "@stubwise/shared";
export { deriveSupportState };

/**
 * Lo slot di una bozza della Posta per una conversazione (`support-ACQ-S2`,
 * R-K14). Era di «Scrivigli per email», uscita con l'area 8, F3: la Posta lo
 * accetta ancora finché la sua macchina degli slot non si toglie (registro).
 */
export const SUPPORT_MAIL_SLOT = /^support-[A-Z0-9]{2,10}-S\d+$/;

const inputOf = (c: SupportConversation): SupportStateInput => ({
  // L'esito: una richiesta legata o la task aperta dal widget (F3-1).
  hasOutcome: c.requestId !== null || c.taskId !== null,
  judgment: c.triage,
  messages: c.messages,
});

export const supportState = (c: SupportConversation) => deriveSupportState(inputOf(c));
