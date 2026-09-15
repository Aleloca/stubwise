import type { CalendarAttendeeResponseStatus } from "./schemas/google.js";

/**
 * «Qual è la TUA risposta a questo invito?» — la funzione pura che il
 * calendario usa per riconoscere il proprietario della casella fra i
 * partecipanti (design 15 set 2026 §1).
 *
 * ## Perché non c'è una colonna
 *
 * Lo si ricava in lettura da `attendees` più l'indirizzo della casella
 * (`google_accounts.email`), che chi legge una riga di `calendar_events` ha
 * sempre in mano: una riga appartiene a UNA casella, e «la tua risposta» è
 * una domanda che ha senso solo rispetto a quella. Una colonna derivata
 * sarebbe un secondo posto da tenere allineato il giorno in cui l'indirizzo
 * di una casella cambia — e nessun backfill è più affidabile di un confronto
 * fatto sul momento.
 *
 * ## Perché sta in `@stubwise/shared` e non in `packages/google`
 *
 * La usano tre superfici: il worker (per il cancello), il web e l'app (per
 * dirlo dove si guarda). `packages/google` è visibile solo a server e
 * worker. Stesso ragionamento di `calendarAttendeeSchema` e di
 * `CALENDAR_WINDOW_DAYS`: una sola dichiarazione, non tre d'accordo per caso.
 */

/**
 * La risposta del proprietario della casella, o `null` se non c'è una
 * risposta LEGGIBILE.
 *
 * `null` copre tre casi che per chi legge sono lo stesso — «di te non
 * sappiamo niente» — e che nessuna UI deve travestire da una risposta:
 *  - la tua casella non è fra i partecipanti (l'appuntamento è tuo e basta,
 *    oppure è un calendario che segui): **non è un rifiuto**;
 *  - Google non ha mandato lo stato, o la riga è anteriore alla fase 9, dove
 *    non veniva conservato;
 *  - lo stato è un valore che questo vocabolario non conosce — compreso il
 *    segnaposto `UNKNOWN` di {@link Reader} su un client mobile vecchio.
 *
 * `needsAction` invece NON è `null`: «non hai ancora risposto» è
 * un'informazione vera, diversa da «non lo sappiamo».
 *
 * Il confronto è case-insensitive: gli indirizzi sono già normalizzati in
 * minuscolo dall'ingestione (`packages/google/src/calendar.ts`) e dalla
 * registrazione della casella, ma non fidarsene qui non costa niente e toglie
 * di mezzo un'intera classe di silenzi.
 *
 * Il parametro è volutamente più largo di `CalendarAttendee[]`: l'app mobile
 * legge `Reader<CalendarEventItem>`, dove `responseStatus` può essere anche
 * il segnaposto degli enum aperti. Accettarlo qui evita un cast al chiamante
 * e fa cadere quel valore nel ramo `null`, che è dove deve stare.
 */
export function attendeeResponseOf(
  attendees: readonly { email: string; responseStatus: string | null }[],
  mailboxEmail: string,
): CalendarAttendeeResponseStatus | null {
  const mine = mailboxEmail.trim().toLowerCase();
  if (mine === "") return null;
  const me = attendees.find((attendee) => attendee.email.trim().toLowerCase() === mine);
  if (me === undefined || me.responseStatus === null) return null;
  return KNOWN_RESPONSES.has(me.responseStatus)
    ? (me.responseStatus as CalendarAttendeeResponseStatus)
    : null;
}

/** I soli valori che `calendarAttendeeResponseStatusSchema` accetta. */
const KNOWN_RESPONSES = new Set<string>(["needsAction", "declined", "tentative", "accepted"]);

/**
 * Hai RIFIUTATO questo invito?
 *
 * ⚠️ **Solo `declined`, ed è una decisione presa guardando i dati veri del
 * maintainer, non un default prudente** (design 15 set 2026 §1): alle
 * riunioni di lavoro ricorrenti quasi nessuno risponde formalmente, quindi
 * far bloccare anche `tentative` o `needsAction` toglierebbe di mezzo la
 * maggior parte degli appuntamenti veri — e un falso negativo qui non lascia
 * traccia, perché una proposta che non nasce non la vede nessuno.
 *
 * È l'UNICO posto in cui «quali risposte bloccano» è scritto: il cancello del
 * worker, la griglia del web e quella dell'app chiamano tutti questa
 * funzione, così allargarla o restringerla resta una modifica in un punto
 * solo.
 */
export function hasDeclinedInvitation(
  attendees: readonly { email: string; responseStatus: string | null }[],
  mailboxEmail: string,
): boolean {
  return attendeeResponseOf(attendees, mailboxEmail) === "declined";
}
