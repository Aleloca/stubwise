// Lo stato di una conversazione di Support (area 8, F3; era
// `domain/support/state.ts` del prototipo, shape support.md §5 [A 2]): si
// DERIVA, non si salva. L'ingresso è NEUTRO (accordo con 94): lo riempiono il
// server (l'esito, il giudizio del controllo, i messaggi) e il prototipo.
//
// - Con un ESITO (una richiesta legata o un ticket aperto dal widget, F3-1):
//   ultimo messaggio del cliente → aspetta noi; nostro (team) → risposta
//   inviata; altrimenti richiesta aperta.
// - Senza esito, il GIUDIZIO sul triage (il controllo del worker dopo il
//   silenzio, o «Non conclusa» di una persona) vale se non è più vecchio
//   dell'ultimo messaggio del cliente: `not_concluded` → non conclusa;
//   `concluded` → `answered` (la risposta del widget è bastata). Senza un
//   giudizio valido → in triage: un messaggio nuovo del cliente riapre il
//   triage da sé.

export type SupportState =
  | "triage"
  | "request_open"
  | "waiting_us"
  | "reply_sent"
  | "not_concluded"
  | "answered";

/** L'ordine dei gruppi dell'elenco: chi aspetta noi in cima, le risolte dal widget in fondo. */
export const SUPPORT_STATE_ORDER: readonly SupportState[] = [
  "waiting_us",
  "triage",
  "not_concluded",
  "request_open",
  "reply_sent",
  "answered",
];

/**
 * Dopo quanti minuti di silenzio il controllo del worker giudica una
 * conversazione senza esito (decisione di 46, 14 nov 2026). Le parole della UI
 * la leggono da qui.
 */
export const SUPPORT_TRIAGE_IDLE_MINUTES = 15;

export type SupportMessageFrom = "customer" | "triage" | "team";
export type SupportTriageOutcome = "concluded" | "not_concluded";

export interface SupportStateInput {
  /** Una richiesta legata o un ticket aperto dal widget. */
  hasOutcome: boolean;
  /** Il giudizio sul triage; `at` in ISO. */
  judgment: { outcome: SupportTriageOutcome; at: string } | null;
  /** I messaggi in ordine; `at` in ISO. */
  messages: readonly { from: SupportMessageFrom; at: string }[];
}

function lastCustomerAt(c: SupportStateInput): string | null {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    if (c.messages[i]!.from === "customer") return c.messages[i]!.at;
  }
  return null;
}

export function supportState(c: SupportStateInput): SupportState {
  if (c.hasOutcome) {
    const last = c.messages.at(-1);
    if (last?.from === "customer") return "waiting_us";
    if (last?.from === "team") return "reply_sent";
    return "request_open";
  }
  const customerAt = lastCustomerAt(c);
  if (c.judgment && (customerAt === null || c.judgment.at >= customerAt)) {
    return c.judgment.outcome === "not_concluded" ? "not_concluded" : "answered";
  }
  return "triage";
}

/**
 * Da quando il cliente aspetta noi: il primo dei suoi messaggi in fondo alla
 * conversazione, ancora senza risposta. `null` se non aspetta noi.
 */
export function waitingSince(c: SupportStateInput): string | null {
  if (supportState(c) !== "waiting_us") return null;
  let i = c.messages.length - 1;
  while (i > 0 && c.messages[i - 1]!.from === "customer") i--;
  return c.messages[i]!.at;
}

/**
 * Lo slot della Posta per la bozza di «Scrivigli anche per email» (R-K14): un
 * posto suo accanto alla «nuova email», che così non si sovrascrive.
 */
export const supportMailSlot = (code: string): string => `support-${code}`;
export const SUPPORT_MAIL_SLOT = /^support-[A-Z0-9]{2,10}-S\d+$/;

/** Il titolo di una richiesta dal desiderio: la prima frase, senza il punto finale, al più 80 caratteri. */
export function wishTitle(wish: string): string {
  const first = wish.split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]$/, "");
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}
