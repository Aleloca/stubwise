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
 * Ampiezza della finestra del PRIMO giro (e di ogni resync) IN AVANTI: 60
 * giorni, come il design. Il tetto in avanti resta — un appuntamento troppo
 * lontano nel futuro non è ancora una scadenza utile da proporre.
 */
export const CALENDAR_WINDOW_DAYS = 60;

/**
 * Quanto indietro guarda la stessa finestra (fase 9, Task 1). Fino alla fase
 * 9 `timeMin` era `now` — nessuno sguardo all'indietro — perché la finestra
 * serviva SOLO a decidere cosa proporre, e un appuntamento passato non
 * produce più una scadenza. La griglia del calendario (fase 9) le dà un
 * secondo uso — mostrare cosa è successo — e con `timeMin = now` una griglia
 * con le frecce avanti/indietro premerebbe "indietro" e non troverebbe mai
 * niente, per sempre. 30 giorni: non tocca i filtri di ammissione né cosa è
 * proposto (quella logica guarda solo eventi futuri), cambia solo quanto
 * passato resta interrogabile. Il filtro in SCRITTURA del poller
 * (`poller.ts`, `startsAt < timeMin || startsAt > timeMax`) usa la STESSA
 * finestra: si allarga insieme, per costruzione — vedi il test dedicato.
 */
export const CALENDAR_LOOKBACK_DAYS = 30;

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

/**
 * La finestra del primo giro / del resync: da {@link CALENDAR_LOOKBACK_DAYS}
 * indietro a {@link CALENDAR_WINDOW_DAYS} avanti.
 */
export function calendarWindow(now: Date): { timeMin: Date; timeMax: Date } {
  return {
    timeMin: new Date(now.getTime() - CALENDAR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
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
    // Fase 9, Task 2: `attendees` porta anche lo stato di risposta — il
    // routing continua a leggere solo l'email, come prima.
    toAddresses: event.attendees.map((attendee) => attendee.email),
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
 *
 * ## Fase 7b (Task 4): un'occorrenza di SERIE ha un cancello in PIÙ
 *
 * Un evento SINGOLO (`recurringEventId: null`, la maggioranza) non cambia:
 * il comportamento sopra resta identico. Un'occorrenza di una SERIE, invece,
 * non è mai pronta a meno che:
 *
 *  - la serie sia CONFIGURATA e ACCESA (`seriesContext.series !== null &&
 *    series.enabled`) — il default è spenta (design fase 7b §4: "una serie
 *    non produce nulla finché non la si accende"), quindi una serie mai
 *    configurata non è mai pronta, MAI un caso limite da gestire a parte;
 *  - l'occorrenza sia nella finestra di anticipo della serie:
 *    `now <= startsAt <= now + leadDays giorni`. Un'occorrenza già passata
 *    non propone (il tap non avrebbe senso), una lontana aspetta il suo giro.
 *
 * ⚠️ **"Una proposta alla volta per serie" — la rete di sicurezza
 * dell'incidente del 9 settembre 2026 — NON è un terzo cancello qui
 * dentro.** Sono DUE strati, entrambi nel propose phase del poller
 * (`apps/worker/src/google/poller.ts`), non in questa funzione: il `NOT
 * EXISTS` nella `WHERE` della query (nessun'altra occorrenza della stessa
 * serie ha già `proposal_notification_id` valorizzato) copre FRA i tick, il
 * dedup per-tick (un `Set` di `recurringEventId` già tentati in questo
 * giro) copre DENTRO lo stesso tick — necessario perché righe lette prima
 * che la prima pubblicazione scrivesse `proposal_notification_id` il `NOT
 * EXISTS` non poteva ancora vederle. Una versione precedente di questo
 * file dichiarava un terzo strato qui (`hasOpenSeriesProposal`) che nessun
 * chiamante di produzione valorizzava mai a `true`: wirarlo per davvero
 * avrebbe richiesto ri-fare la stessa query `NOT EXISTS` una volta per
 * riga candidata (N query invece di una — l'esatto pattern che questo
 * codebase evita altrove, vedi il commento su `known`/`sameFingerprint` in
 * `syncCalendar`), quindi è stato tolto invece di far finta di difendere
 * quello che i due strati veri già difendono.
 */
export interface CalendarSeriesConfig {
  enabled: boolean;
  leadDays: number;
  /**
   * Fase 7b (Task 5): CHE azione la serie propone — `isReadyForProposal` non
   * la legge (il cancello di timing non dipende da cosa si propone), ma
   * viaggia nello stesso oggetto perché chi legge il contesto di una serie
   * (il propose phase) ne ha sempre bisogno insieme al resto, in un solo
   * LEFT JOIN.
   */
  action: "backlog_item" | "milestone" | "reminder";
  /** `false` = propone e aspetta un tap; `true` = esegue e lo rende visibile. MAI un job AI. */
  auto: boolean;
  /**
   * Il progetto FISSATO all'attivazione della serie (design §4). Fix di
   * review: prima di questo campo, il propose phase e l'esecuzione
   * automatica usavano `calendar_events.project_id` — il progetto
   * RI-DEDOTTO dal routing su QUESTA occorrenza — anche per un'occorrenza
   * di serie, contraddicendo il design alla lettera. Il caso grave non era
   * la serie che diventa inerte (routing che non risolve più → innocuo):
   * era il routing che risolve un progetto DIVERSO da quello scelto in UI,
   * con l'azione creata lì — e con `auto: true`, senza che nessuno la
   * vedesse prima. `null` qui non dovrebbe succedere per una serie
   * `enabled: true` (il PUT lo impedisce), ma `resolveCalendarProjectId`
   * lo tratta comunque come "non pronta", mai come "usa l'altro".
   */
  projectId: string | null;
}

/**
 * `series` lo consulta SOLO un'occorrenza di serie — ignorato per un evento
 * singolo. `now`, invece, dal fix di review della fase 9 (Task 1) serve a
 * ENTRAMBI: prima serviva solo al cancello di serie, ma un evento singolo ha
 * bisogno dello stesso orologio per non proporre un appuntamento già passato
 * (vedi {@link isReadyForProposal}).
 */
export interface CalendarSeriesProposalContext {
  now: Date;
  /** `null` = serie mai configurata, equivalente a "spenta" per `isReadyForProposal`. */
  series: CalendarSeriesConfig | null;
}

/** Il minimo di riga su cui {@link resolveCalendarProjectId} e {@link isReadyForProposal} operano. */
interface CalendarProjectRow {
  projectId: string | null;
  recurringEventId?: string | null;
}

/**
 * IL progetto di un'occorrenza — un solo punto per una domanda che
 * `isReadyForProposal`, `buildCalendarProposalEvent`
 * (`apps/worker/src/google/proposal.ts`) e l'esecuzione automatica del
 * poller devono rispondere ALLO STESSO MODO: fix di review, prima
 * rispondevano in tre modi leggermente diversi (o meglio, solo questa
 * funzione non esisteva e tutti e tre leggevano `row.projectId` — il bug).
 *
 * Un evento SINGOLO (nessuna serie) usa il progetto ri-dedotto dal routing
 * su quella riga — invariato, è la maggioranza degli appuntamenti.
 * Un'occorrenza di una serie CONFIGURATA e ACCESA usa il progetto FISSATO
 * sulla serie, MAI quello della riga: è la lettera del design §4, "il
 * progetto si fissa, non si ri-deduce". Una serie non configurata o spenta
 * non ha un progetto qui — `null`, mai un fallback sul routing dell'
 * occorrenza, che sarebbe esattamente il bug corretto da questa funzione.
 */
export function resolveCalendarProjectId(
  row: CalendarProjectRow,
  seriesContext?: CalendarSeriesProposalContext,
): string | null {
  const recurringEventId = row.recurringEventId ?? null;
  if (recurringEventId === null) return row.projectId;
  const series = seriesContext?.series;
  if (!series || !series.enabled) return null;
  return series.projectId;
}

export function isReadyForProposal(
  row: {
    status: string | null;
    projectId: string | null;
    proposalNotificationId: string | null;
    outcome: Record<string, unknown> | null;
    /** Assente o `null` = evento singolo: il cancello di SERIE (lead time, dedup) qui sotto non si applica — ma il cancello temporale sì, per entrambi. */
    recurringEventId?: string | null;
    /** Necessario per ENTRAMBI i rami: un evento senza data non è mai pronto. */
    startsAt?: Date | null;
  },
  seriesContext?: CalendarSeriesProposalContext,
): boolean {
  const baseReady =
    row.status !== "cancelled" && row.proposalNotificationId === null && row.outcome === null;
  if (!baseReady) return false;

  // Il progetto CERTO — mai `row.projectId` da solo: per un'occorrenza di
  // serie è `resolveCalendarProjectId` a decidere fra il routing e il
  // fissato, mai un OR fra i due (vedi il docblock della funzione).
  if (resolveCalendarProjectId(row, seriesContext) === null) return false;

  // `now` non è più un dettaglio di sola serie (vedi il docblock di
  // `CalendarSeriesProposalContext`): senza `seriesContext` (il caso di un
  // evento singolo, l'unico che il poller passa così) si ricava sul colpo.
  const now = seriesContext?.now ?? new Date();
  const recurringEventId = row.recurringEventId ?? null;
  if (recurringEventId === null) {
    // Fix di review (fase 9, Task 1): fino a questa fase la finestra di
    // ingestione partiva da `now`, quindi un evento singolo passato non
    // entrava mai — questo controllo era ridondante e per questo assente.
    // Il Task 1 allarga la finestra a `now - 30gg`: senza questo controllo,
    // ogni appuntamento del mese scorso diventerebbe una proposta di
    // milestone con scadenza già passata. Un appuntamento passato non
    // diventa MAI una scadenza da rispettare.
    if (!row.startsAt) return false;
    return row.startsAt.getTime() >= now.getTime();
  }

  // `resolveCalendarProjectId` sopra è già tornato non-null, quindi la serie
  // è per costruzione configurata e accesa: `context.series` non è `null`.
  // "Una proposta alla volta per serie" NON è un cancello qui: vive nel
  // propose phase del poller (NOT EXISTS in SQL + dedup per-tick), vedi il
  // docblock sopra.
  const context = seriesContext ?? { now, series: null };
  const series = context.series!;
  if (!row.startsAt) return false;

  const leadMs = series.leadDays * 24 * 60 * 60 * 1000;
  const delta = row.startsAt.getTime() - context.now.getTime();
  return delta >= 0 && delta <= leadMs;
}
