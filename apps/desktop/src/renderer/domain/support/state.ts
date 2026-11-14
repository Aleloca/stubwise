import type { SupportConversation } from "../../data/model";

// Lo stato di una conversazione di Support (shape support.md §5 [A 2]): si
// DERIVA, non si salva. Con un esito (una richiesta legata, o un ticket
// aperto dal widget) decide l'ultimo messaggio: del cliente → aspetta noi;
// nostro (team) → risposta inviata; altrimenti richiesta aperta. Senza esito
// decide il giudizio dopo il silenzio (area 8, F3: il controllo del worker),
// se non è più vecchio dell'ultimo messaggio del cliente: non conclusa, o
// risposta bastata (`answered`); altrimenti in triage. Un messaggio nuovo del
// cliente rende vecchio il giudizio da sé.
// `deriveSupportState` ha l'ingresso neutro del server (passerà in
// `@stubwise/shared`); `supportState` lo legge da una conversazione del prototipo.

export type SupportState =
  | "triage"
  | "request_open"
  | "waiting_us"
  | "reply_sent"
  | "not_concluded"
  | "answered";

/** Il giudizio dopo il silenzio: la risposta è bastata, o resta un bisogno. */
export interface TriageJudgment {
  outcome: "concluded" | "not_concluded";
  at: string;
}

export interface SupportStateInput {
  hasOutcome: boolean;
  judgment: TriageJudgment | null;
  messages: readonly Pick<SupportConversation["messages"][number], "from" | "at">[];
}

export function deriveSupportState(c: SupportStateInput): SupportState {
  if (!c.hasOutcome) {
    const lastCustomer = [...c.messages].reverse().find((m) => m.from === "customer")?.at;
    const valid = c.judgment && (!lastCustomer || c.judgment.at >= lastCustomer);
    if (!valid) return "triage";
    return c.judgment!.outcome === "concluded" ? "answered" : "not_concluded";
  }
  const last = c.messages.at(-1);
  if (last?.from === "customer") return "waiting_us";
  if (last?.from === "team") return "reply_sent";
  return "request_open";
}

/**
 * Da quando il cliente aspetta noi: il primo dei suoi messaggi in fondo alla
 * conversazione, ancora senza risposta. `null` se non aspetta noi.
 */
export function deriveWaitingSince(c: SupportStateInput): string | null {
  if (deriveSupportState(c) !== "waiting_us") return null;
  let i = c.messages.length - 1;
  while (i > 0 && c.messages[i - 1]!.from === "customer") i--;
  return c.messages[i]!.at;
}

const inputOf = (c: SupportConversation): SupportStateInput => ({
  hasOutcome: c.requestId !== null,
  judgment: c.triage,
  messages: c.messages,
});

export const supportState = (c: SupportConversation): SupportState =>
  deriveSupportState(inputOf(c));

export const waitingSince = (c: SupportConversation): string | null =>
  deriveWaitingSince(inputOf(c));

/**
 * Lo slot della Posta per la bozza di «Scrivigli anche per email» di una
 * conversazione (R-K14): un posto suo accanto alla «nuova email», che così
 * non si sovrascrive. Lo usano il livello dati della Posta e l'indirizzo
 * `#/mail?compose=<slot>`.
 */
export const supportMailSlot = (code: string): string => `support-${code}`;
export const SUPPORT_MAIL_SLOT = /^support-[A-Z]{2,4}-S\d+$/;

/**
 * Il titolo di una richiesta dal desiderio del cliente: la prima frase, senza
 * il punto finale, al più 80 caratteri. Lo usano il triage concluso e
 * «Apri la richiesta» (precompilato, shape support §5).
 */
export function wishTitle(wish: string): string {
  const first = wish.split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]$/, "");
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}
