/**
 * Dizionario piatto delle stringhe UI del widget, in italiano e inglese. La
 * lingua è scelta da `config.language` (impostata dal progetto lato server): il
 * widget non fa detection dal browser, così l'esperienza è coerente col resto
 * del prodotto ospite.
 *
 * Volutamente minimale (nessun ICU / plurali / interpolazione): le poche
 * stringhe dinamiche (numero ticket) sono composte a mano nel punto d'uso.
 * Niente dipendenze da `@stubwise/i18n` (il widget è standalone).
 */

/** Chiavi delle stringhe UI (stesse per ogni lingua). */
export interface WidgetStrings {
  /** Messaggio di benvenuto di fallback se il server non ne fornisce uno. */
  welcomeFallback: string;
  /** Placeholder del campo di composizione. */
  composerPlaceholder: string;
  /** Label del bottone d'invio (aria-label, il bottone mostra un'icona). */
  send: string;
  /** aria-label della bolla/bottone di chiusura. */
  openLabel: string;
  closeLabel: string;
  /** aria-label del bottone "nuova conversazione" (stato iniziale). */
  newChat: string;
  /** aria-label del bottone "nuova conversazione" nello stato di conferma. */
  newChatConfirm: string;
  /** Nota sotto il titolo del pannello. */
  assistantNote: string;
  /** Messaggio di cortesia su errore generico dello stream/HTTP. */
  errorGeneric: string;
  /** Messaggio dedicato al cap giornaliero della chat (429). */
  errorCapReached: string;
  /** Nota quando la chat è disabilitata (storico leggibile, composer spento). */
  chatDisabledNote: string;
  /** Card ticket. */
  ticketBug: string;
  ticketFeedback: string;
  ticketFeature: string;
  ticketTitlePlaceholder: string;
  ticketBodyPlaceholder: string;
  ticketSubmit: string;
  ticketCancel: string;
  /** Prefisso della conferma ticket ("✓ inviata" + numero composto a mano). */
  ticketSent: string;
  ticketError: string;
  ticketRetry: string;
}

const it: WidgetStrings = {
  welcomeFallback: "Ciao! Come posso aiutarti?",
  composerPlaceholder: "Scrivi un messaggio…",
  send: "Invia",
  openLabel: "Apri la chat di assistenza",
  closeLabel: "Chiudi la chat",
  newChat: "Nuova conversazione",
  newChatConfirm: "Confermi? Ricomincia da capo",
  assistantNote: "Risponde l'assistente AI",
  errorGeneric: "Si è verificato un errore. Riprova tra poco.",
  errorCapReached:
    "L'assistente non è disponibile oggi. Puoi comunque inviare una segnalazione descrivendo il problema.",
  chatDisabledNote: "La chat non è al momento disponibile.",
  ticketBug: "bug",
  ticketFeedback: "feedback",
  ticketFeature: "richiesta",
  ticketTitlePlaceholder: "Titolo",
  ticketBodyPlaceholder: "Descrizione",
  ticketSubmit: "Invia segnalazione",
  ticketCancel: "Annulla",
  ticketSent: "Segnalazione inviata",
  ticketError: "Invio non riuscito.",
  ticketRetry: "Riprova",
};

const en: WidgetStrings = {
  welcomeFallback: "Hi! How can I help you?",
  composerPlaceholder: "Type a message…",
  send: "Send",
  openLabel: "Open support chat",
  closeLabel: "Close chat",
  newChat: "New conversation",
  newChatConfirm: "Confirm? This starts over",
  assistantNote: "You are chatting with the AI assistant",
  errorGeneric: "Something went wrong. Please try again shortly.",
  errorCapReached:
    "The assistant is unavailable today. You can still send a report describing the problem.",
  chatDisabledNote: "Chat is currently unavailable.",
  ticketBug: "bug",
  ticketFeedback: "feedback",
  ticketFeature: "request",
  ticketTitlePlaceholder: "Title",
  ticketBodyPlaceholder: "Description",
  ticketSubmit: "Send report",
  ticketCancel: "Cancel",
  ticketSent: "Report sent",
  ticketError: "Sending failed.",
  ticketRetry: "Retry",
};

const DICTIONARIES: Record<"it" | "en", WidgetStrings> = { it, en };

/** Restituisce il dizionario per la lingua data (default `it` per input ignoti). */
export function getStrings(language: "it" | "en"): WidgetStrings {
  return DICTIONARIES[language] ?? DICTIONARIES.it;
}
