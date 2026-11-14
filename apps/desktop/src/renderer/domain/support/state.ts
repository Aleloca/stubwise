import {
  supportState as deriveSupportState,
  waitingSince as deriveWaitingSince,
  type SupportStateInput,
} from "@stubwise/shared";
import type { SupportConversation } from "../../data/model";

// Lo stato di una conversazione di Support (shape support.md §5 [A 2]): la
// regola è UNA, in `@stubwise/shared` (area 8, F3), con l'ingresso neutro del
// server (esito, giudizio dopo il silenzio, messaggi). Qui il prototipo la
// legge da una sua conversazione: l'esito è la richiesta legata.

export {
  SUPPORT_MAIL_SLOT,
  SUPPORT_STATE_ORDER,
  SUPPORT_TRIAGE_IDLE_MINUTES,
  supportMailSlot,
  wishTitle,
  type SupportState,
  type SupportStateInput,
} from "@stubwise/shared";
export { deriveSupportState, deriveWaitingSince };

const inputOf = (c: SupportConversation): SupportStateInput => ({
  hasOutcome: c.requestId !== null,
  judgment: c.triage,
  messages: c.messages,
});

export const supportState = (c: SupportConversation) => deriveSupportState(inputOf(c));

export const waitingSince = (c: SupportConversation) => deriveWaitingSince(inputOf(c));
