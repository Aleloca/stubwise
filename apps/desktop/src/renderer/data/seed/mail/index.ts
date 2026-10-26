// Il seme della Posta (area 6): le caselle, i messaggi (posta di progetto,
// rumore, riunioni registrate, contenuti estremi), le note delle riunioni e
// le proposte. Nessuna bozza: le scrive chi usa il prototipo.
import type { MailDraft, MailMessage } from "../../types";
import { EXTREME_MESSAGES, EXTREME_MESSAGE_IDS } from "./extremes";
import { MEETING_MESSAGES, MEETING_MESSAGE_IDS } from "./meetings";
import { MESSAGE_IDS, PROJECT_MESSAGES } from "./messages";

export { INCOMING_MESSAGE_ID, MAIL_INCOMING } from "./incoming";
export { MAILBOXES } from "./mailboxes";
export { EV_AUD_REVIEW_LAST_WEEK, EV_AUD_REVIEW_YESTERDAY, MEETING_TRANSCRIPTS } from "./meetings";
export { MAIL_PROPOSALS } from "./proposals";

/** In ordine di tempo. */
export const MAIL_MESSAGES: MailMessage[] = [
  ...PROJECT_MESSAGES,
  ...MEETING_MESSAGES,
  ...EXTREME_MESSAGES,
].sort((a, b) => a.at.localeCompare(b.at));

/** L'id della riga di ogni caso del seme, per i test e le aree successive. */
export const MAIL_CASES = { ...MESSAGE_IDS, ...MEETING_MESSAGE_IDS, ...EXTREME_MESSAGE_IDS };

export const MAIL_DRAFTS: MailDraft[] = [];

/**
 * Il dominio che rifiuta sempre: un invio con un destinatario
 * `…@bounce.example` (per esempio `luca@bounce.example`) fallisce con
 * «indirizzo non trovato», per provare «Non inviata · Riprova».
 */
export const BOUNCE_DOMAIN = "bounce.example";
