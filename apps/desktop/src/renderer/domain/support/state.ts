import type { SupportConversation } from "../../data/model";

// Lo stato di una conversazione di Support (shape support.md §5 [A 2]): si
// DERIVA, non si salva. Con una richiesta decide l'ultimo messaggio: del
// cliente → aspetta noi; nostro (team) → risposta inviata; altrimenti
// richiesta aperta. Senza richiesta: cliente andato → non conclusa,
// altrimenti in triage. Chi riporta in triage una «non conclusa» (un
// messaggio nuovo del cliente) lo fa togliendo `leftAt`, non qui.

export type SupportState =
  | "triage"
  | "request_open"
  | "waiting_us"
  | "reply_sent"
  | "not_concluded";

export function supportState(c: SupportConversation): SupportState {
  if (c.requestId === null) return c.leftAt !== null ? "not_concluded" : "triage";
  const last = c.messages.at(-1);
  if (last?.from === "customer") return "waiting_us";
  if (last?.from === "team") return "reply_sent";
  return "request_open";
}

/**
 * Da quando il cliente aspetta noi: il primo dei suoi messaggi in fondo alla
 * conversazione, ancora senza risposta. `null` se non aspetta noi.
 */
export function waitingSince(c: SupportConversation): string | null {
  if (supportState(c) !== "waiting_us") return null;
  let i = c.messages.length - 1;
  while (i > 0 && c.messages[i - 1]!.from === "customer") i--;
  return c.messages[i]!.at;
}
