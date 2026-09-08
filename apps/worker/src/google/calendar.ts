/**
 * PARTE PURA della FASE 3 del tick delle caselle Google (fase 6, Task 9): dal
 * calendario `primary` alle **proposte di milestone**.
 *
 * ## Qui NON c'è nessuna AI, ed è la differenza con la fase 2
 *
 * La posta passa da un run del modello perché "che cosa chiede questa email"
 * non si decide con una regola. Un appuntamento no: se è in perimetro e il
 * progetto è certo, la proposta è sempre la stessa — «<titolo> entro <data>» —
 * e si compone con un template. Non c'è niente che un modello aggiungerebbe se
 * non variabilità, e la variabilità qui si paga due volte: in soldi e in
 * proposte che cambiano forma da un giorno all'altro per lo stesso
 * appuntamento ricorrente.
 *
 * ## Il pre-filtro riusa `matchRoutes`, e la scelta ha un prezzo dichiarato
 *
 * Le regole di routing sono le stesse della posta ({@link eventToRouting} le
 * applica a partecipanti/organizzatore invece che a mittente/destinatari), con
 * UNA conseguenza voluta: una regola `gmail_label` non combacia MAI con un
 * evento, perché un evento non ha etichette Gmail. Non è un caso da gestire, è
 * il comportamento giusto — chi vuole agganciare il calendario a un progetto
 * usa un dominio, un indirizzo o una parola chiave — ed è ciò che si ottiene
 * gratis passando `labels: []`, invece di reimplementare un secondo motore di
 * regole che poi diverge dal primo.
 *
 * L'altra conseguenza: la `keyword` si confronta con il solo TITOLO (il
 * `subject` di {@link EmailForRouting}), perché la descrizione di un evento non
 * la leggiamo — è il posto dove finiscono i link della videochiamata e le note
 * di chiunque, non una firma del progetto.
 *
 * @see poller.ts per la fase 3 vera e propria (chiamate, cursore, scritture).
 */
import type { GoogleCalendarEvent } from "@stubwise/google";
import { GoogleApiError } from "@stubwise/google";
import { t, type Language } from "@stubwise/i18n";
import {
  matchRoutes,
  type EmailForRouting,
  type EmailRoute,
  type EmailRoutingResult,
} from "@stubwise/notifications";

/**
 * Ampiezza della finestra del PRIMO giro (e di ogni resync): 60 giorni avanti,
 * come il design. Non si guarda indietro di proposito — un appuntamento già
 * passato non produce una scadenza da proporre.
 */
export const CALENDAR_WINDOW_DAYS = 60;

/** Eventi chiesti per pagina a `events.list`. */
export const CALENDAR_PAGE_SIZE = 250;

/**
 * Tetto di pagine che una sincronizzazione scorre in un tick.
 *
 * Non è una politica di prodotto: è la difesa contro un `nextPageToken` che
 * non avanza mai (un errore lato Google, o un proxy che ripete una risposta).
 * Con {@link CALENDAR_PAGE_SIZE} sono 5.000 eventi in 60 giorni: chi lo
 * supera davvero ha un calendario che non è un calendario.
 */
export const CALENDAR_MAX_PAGES = 20;

/**
 * L'esito di una riga CHIUSA perché l'appuntamento è stato cancellato.
 *
 * `outcome` valorizzato è ciò che toglie la riga dalle candidate a una
 * proposta (vedi {@link isReadyForProposal}): cancellare un evento non muta
 * niente altrove — nessuna milestone, nessuna decisione — e chiudere la riga è
 * l'intera reazione.
 */
export const CALENDAR_CANCELLED_OUTCOME = { type: "cancelled" } as const;

/** Il tipo di `outcome` scritto su una riga duplicata (vedi {@link duplicateOutcome}). */
export const CALENDAR_DUPLICATE_OUTCOME_TYPE = "duplicate";

/**
 * L'esito di una riga che NON va riproposta perché lo stesso appuntamento —
 * stesso giorno, stesso titolo — è già tracciato sotto un altro
 * `google_event_id`.
 *
 * Succede più di quanto sembri: cancellare e ricreare un invito, spostarlo da
 * un calendario all'altro, o accettare due volte la stessa convocazione
 * produce un id nuovo per una cosa che per il team è la stessa. Si scrive
 * comunque la riga (la tracciabilità vale) ma con un esito che dice perché non
 * diventerà una proposta.
 */
export function duplicateOutcome(ofGoogleEventId: string): Record<string, unknown> {
  return { type: CALENDAR_DUPLICATE_OUTCOME_TYPE, ofGoogleEventId };
}

/** Gli `status` che `calendar_events.status` accetta (stesso CHECK dello schema). */
const KNOWN_STATUSES = new Set(["confirmed", "tentative", "cancelled"]);

/** Lo status di Google normalizzato sul CHECK della tabella (ignoto → `null`). */
export function normalizeStatus(status: string): "confirmed" | "tentative" | "cancelled" | null {
  return KNOWN_STATUSES.has(status)
    ? (status as "confirmed" | "tentative" | "cancelled")
    : null;
}

/** L'evento è stato cancellato su Google? */
export function isCancelled(event: GoogleCalendarEvent): boolean {
  return event.status === "cancelled";
}

/**
 * L'errore dice «il tuo `syncToken` è troppo vecchio»?
 *
 * È il 410 di `events.list`, che `@stubwise/google` normalizza in
 * `sync_token_expired`. Come `history_expired` per Gmail: non è fatale, si
 * riparte con un giro pieno sulla finestra.
 */
export function isSyncTokenExpired(error: unknown): boolean {
  return error instanceof GoogleApiError && error.code === "sync_token_expired";
}

/** La finestra del primo giro / del resync: da adesso a {@link CALENDAR_WINDOW_DAYS}. */
export function calendarWindow(now: Date): { timeMin: Date; timeMax: Date } {
  return {
    timeMin: now,
    timeMax: new Date(now.getTime() + CALENDAR_WINDOW_DAYS * 24 * 60 * 60 * 1000),
  };
}

/**
 * Il GIORNO di un istante, in UTC (`YYYY-MM-DD`).
 *
 * ⚠️ UTC e non il fuso dell'evento, ed è una scelta: la forma normalizzata di
 * `@stubwise/google` non porta il fuso di origine (un evento "tutto il giorno"
 * è già fissato a mezzanotte UTC lì), e prendere il fuso della macchina che
 * esegue il worker renderebbe il fingerprint dipendente da dove gira il
 * container. La conseguenza è nota e piccola: un appuntamento a tarda sera in
 * Europa cade nel giorno UTC precedente per lo scarto d'ora legale — la data
 * proposta è quella, ed è la stessa a ogni tick, che è ciò che conta per non
 * riproporre.
 */
export function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Il titolo confrontabile: minuscolo, senza spazi ai bordi, spazi interni compattati. */
export function normalizeTitle(title: string | null | undefined): string {
  return (title ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * L'IMPRONTA di un appuntamento: giorno + titolo normalizzato.
 *
 * È ciò che rende «lo stesso appuntamento» due righe che Google considera
 * diverse. Volutamente NON contiene l'orario: spostare una riunione dalle 10
 * alle 15 dello stesso giorno non è una scadenza nuova, e riproporre una
 * milestone per quello sarebbe rumore. Volutamente non contiene nemmeno il
 * `google_event_id`, che è esattamente ciò che cambia quando un invito viene
 * cancellato e ricreato.
 */
export function computeFingerprint(title: string | null | undefined, startsAt: Date): string {
  return `${isoDay(startsAt)} ${normalizeTitle(title)}`;
}

/**
 * L'evento nella forma che il routing legge.
 *
 * La mappa è quella dichiarata nel docblock del modulo: organizzatore →
 * `fromAddress`, partecipanti → `toAddresses`, titolo → `subject`, nessuna
 * etichetta, nessun testo. `matchRoutes` senza `text` confronta le `keyword`
 * col solo `subject`, che qui è il titolo: è il comportamento voluto, non un
 * ripiego (vedi il docblock).
 */
export function eventToRouting(event: GoogleCalendarEvent): EmailForRouting {
  return {
    fromAddress: event.organizer ?? "",
    toAddresses: event.attendees,
    labels: [],
    subject: event.title,
  };
}

/** Il progetto di un evento, con le stesse regole della posta. */
export function routeEvent(
  event: GoogleCalendarEvent,
  routes: EmailRoute[],
): EmailRoutingResult {
  return matchRoutes(eventToRouting(event), routes);
}

/** La proposta deterministica che un evento genererebbe. */
export interface CalendarMilestoneProposal {
  /** Nome della milestone: «<titolo> entro <data>» nella lingua dell'istanza. */
  name: string;
  /** Scadenza in ISO (`YYYY-MM-DD`): il giorno dell'appuntamento. */
  dueDate: string;
}

/**
 * La milestone che questo evento propone, o `null` se non ne propone nessuna.
 *
 * `null` in due casi, entrambi «non c'è una proposta sensata da fare», non
 * «errore»:
 *  - **senza data d'inizio**: `calendar_events.starts_at` è NOT NULL e una
 *    scadenza senza data non è una scadenza;
 *  - **senza titolo**: «<vuoto> entro il 12 settembre» non è una milestone che
 *    qualcuno confermerebbe con un tap, e proporla vuol dire chiedere a una
 *    persona di indovinare di cosa si tratta.
 *
 * La funzione è l'UNICA definizione di «che proposta farebbe questo evento»:
 * la fase 3 la usa come cancello (se torna `null` la riga non diventa mai
 * candidata) e la fase D la richiama per comporre la card, così le due non
 * possono divergere.
 */
export function buildMilestoneProposal(
  lang: Language,
  event: { title: string | null; startsAt: Date | null },
): CalendarMilestoneProposal | null {
  if (!event.startsAt) return null;
  const title = (event.title ?? "").trim();
  if (title === "") return null;
  const dueDate = isoDay(event.startsAt);
  return { name: t(lang, "email.calendar.milestone", { title, date: dueDate }), dueDate };
}

/**
 * La riga di `calendar_events` è PRONTA per una proposta?
 *
 * ⚠️ **È il contratto fra la fase 3 e la fase D (Task 10)**, e vale la pena
 * leggerlo per intero perché la fase 3 non pubblica niente: si ferma a
 * scrivere righe, e questa combinazione di colonne è tutto ciò che dice «di
 * questa si può fare una proposta».
 *
 *  - `status <> 'cancelled'` — l'appuntamento esiste ancora;
 *  - `project_id IS NOT NULL` — il progetto è CERTO. In parità fra due
 *    progetti la colonna resta nulla e la riga non è candidata: indovinare fra
 *    due progetti è peggio che tacere, ed è la stessa regola della posta;
 *  - `proposal_notification_id IS NULL` — non è già stata proposta;
 *  - `outcome IS NULL` — non è già stata chiusa (cancellata, duplicata, o
 *    eseguita dalla fase D).
 *
 * L'equivalente SQL, per chi scriverà quella query:
 * `where status is distinct from 'cancelled' and project_id is not null
 *  and proposal_notification_id is null and outcome is null`.
 */
export function isReadyForProposal(row: {
  status: string | null;
  projectId: string | null;
  proposalNotificationId: string | null;
  outcome: Record<string, unknown> | null;
}): boolean {
  return (
    row.status !== "cancelled" &&
    row.projectId !== null &&
    row.proposalNotificationId === null &&
    row.outcome === null
  );
}
