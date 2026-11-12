import {
  calendarEventItemSchema,
  calendarEventPageSchema,
  calendarSeriesListSchema,
  calendarSeriesWriteResultSchema,
  calendarWriteResultSchema,
} from "@stubwise/shared";
import type {
  CalendarEventItem,
  CalendarEventPage,
  CalendarSeriesList,
  CalendarSeriesPatch,
  CalendarSeriesWriteResult,
  CalendarEventCreateInput,
  CalendarEventEditInput,
  CalendarEventMoveInput,
  CalendarEventRespondInput,
  CalendarWriteResult,
  CalendarWriteScope,
  MailItemStatus,
  Reader,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/** Filtri di `GET /api/me/calendar` (la lista keyset della fase 7b). */
export interface CalendarFilters {
  account?: string;
  status?: MailItemStatus;
  project?: string;
}

/**
 * Intervallo di `GET /api/me/calendar/range`, estremi ISO — `to` ESCLUSO.
 *
 * ⚠️ L'ampiezza ha un tetto lato server (`MAX_RANGE_DAYS = 100`,
 * `apps/server/src/routes/me-calendar.ts`): oltre, 400 `range_too_wide`. Una
 * vista mese con i giorni di contorno è al più ~6 settimane, quindi il tetto
 * non si tocca chiedendo quello che una griglia mostra davvero — ma chi
 * pre-carica "qualche mese" in un colpo solo ci sbatte, ed è voluto.
 */
export interface CalendarRange {
  from: string;
  to: string;
  account?: string;
  /** F3b: `summary` = la lista leggera (i campi pesanti in `event(id)`), senza le cancellate. */
  fields?: "summary";
}

/**
 * Calendario (fasi 7b, 9): gli appuntamenti che il poller ha VISTO e le serie
 * ricorrenti riconosciute, per l'utente autenticato — `user_id` sempre nel
 * WHERE lato server via il JOIN su `google_accounts`, nessun ruolo scavalca,
 * nemmeno un admin (`apps/server/src/routes/me-calendar.ts`). Il calendario di
 * una persona non è un dato amministrabile: un id che non è suo produce una
 * pagina vuota o un 404, mai un 403.
 *
 * **Non è un calendario**: mostra il lavoro RICONOSCIUTO, cioè solo gli
 * appuntamenti che combaciano con le regole di smistamento di un progetto, e
 * solo dentro la finestra di ingestione del poller (`now − 30gg → now + 60gg`,
 * `CALENDAR_LOOKBACK_DAYS`/`CALENDAR_WINDOW_DAYS` in
 * `apps/worker/src/google/calendar.ts`). Un intervallo fuori da quella
 * finestra risponde 200 con zero eventi — non perché non ci siano impegni, ma
 * perché lì Stubwise non guarda: chi disegna una griglia su questi dati lo
 * deve dire a chi la guarda, o sembra un guasto.
 */
export function createCalendarEndpoints(request: ApiRequest) {
  return {
    /** La lista keyset (fase 7b), ordinata per `startsAt` decrescente. */
    list(
      filters: CalendarFilters = {},
      cursor?: string,
      limit?: number,
    ): Promise<Reader<CalendarEventPage>> {
      const query = toQuery({
        account: filters.account,
        status: filters.status,
        project: filters.project,
        cursor,
        limit,
      });
      return request("GET", `/api/me/calendar${query}`, undefined, calendarEventPageSchema);
    },

    /**
     * Gli eventi che SI SOVRAPPONGONO a `[from, to)` — non solo quelli che ci
     * iniziano dentro: un evento a cavallo di mezzanotte deve comparire su
     * ogni cella di griglia che tocca. Nessuna paginazione (`nextCursor` è
     * sempre `null`): il tetto sull'ampiezza fa già da limite.
     *
     * 400 `invalid_range` se `to` non è dopo `from`; 400 `range_too_wide`
     * oltre i 100 giorni.
     */
    range(input: CalendarRange): Promise<Reader<CalendarEventPage>> {
      const query = toQuery({ from: input.from, to: input.to, account: input.account, fields: input.fields });
      return request("GET", `/api/me/calendar/range${query}`, undefined, calendarEventPageSchema);
    },

    /**
     * Un evento per id (area 6, F1.4): la stessa forma di una riga di
     * {@link range}. 404 `not_found` per un evento non tuo come per uno che non
     * esiste.
     */
    event(id: string): Promise<Reader<CalendarEventItem>> {
      return request("GET", `/api/me/calendar/events/${seg(id)}`, undefined, calendarEventItemSchema);
    },

    /**
     * Le serie ricorrenti riconosciute, con la loro configurazione — o i
     * default se non ne hanno mai avuta una: **una serie non configurata è una
     * serie SPENTA**, non un errore (design fase 7b §4).
     *
     * ⚠️ Non filtra per finestra temporale, di proposito: una serie le cui
     * occorrenze cadono tutte fuori dalla griglia visibile deve restare
     * raggiungibile — altrimenti, se fosse accesa con `auto: true`, non
     * sarebbe nemmeno SPEGNIBILE (è la lezione dell'incidente del 9 settembre
     * 2026, vedi `CalendarSeriesSidebar` sul web).
     */
    series(account?: string): Promise<Reader<CalendarSeriesList>> {
      return request(
        "GET",
        `/api/me/calendar/series${toQuery({ account })}`,
        undefined,
        calendarSeriesListSchema,
      );
    },

    /**
     * Configura una serie. **Sostituzione INTEGRALE**, non una patch: il corpo
     * che parte è la configurazione che resta, e i campi omessi tornano al
     * loro default (`action: "milestone"`, `leadDays: 2`, `auto: false`) —
     * vedi il docblock di `calendarSeriesPatchSchema`.
     *
     * ⚠️ Il server rifiuta `enabled: true` senza `projectId` con un 400
     * `project_required` ("il progetto si fissa, non si ri-deduce", design
     * fase 7b §4). **Una UI non deve poter comporre quel corpo**: quel 400 è
     * la rete, non il controllo.
     */
    putSeries(
      recurringEventId: string,
      patch: CalendarSeriesPatch,
    ): Promise<Reader<CalendarSeriesWriteResult>> {
      return request(
        "PUT",
        `/api/me/calendar/series/${seg(recurringEventId)}`,
        patch,
        calendarSeriesWriteResultSchema,
      );
    },

    /**
     * Spegne una serie eliminandone la configurazione: non un flag a `false`,
     * la rimozione stessa — una serie mai configurata e una serie spenta di
     * nuovo sono la STESSA cosa per `isReadyForProposal`
     * (`apps/worker/src/google/calendar.ts`). `account` è obbligatorio:
     * `recurringEventId` da solo non è unico fra due caselle dello stesso
     * utente.
     */
    deleteSeries(
      recurringEventId: string,
      account: string,
    ): Promise<Reader<CalendarSeriesWriteResult>> {
      return request(
        "DELETE",
        `/api/me/calendar/series/${seg(recurringEventId)}${toQuery({ account })}`,
        undefined,
        calendarSeriesWriteResultSchema,
      );
    },

    // --- Area 6, F4: scrivere sul calendario ---------------------------
    // Ogni scrittura è un GESTO della persona e risponde DOPO il sì di Google
    // (Q2): `{ items }`, le righe toccate nella forma di `range` — una per
    // «solo questo», le date della serie nella finestra per «tutta la serie»
    // (spostarla ne cambia gli id: rileggi `range`). Gli errori, nelle parole
    // del piano F4: 400 `invalid_range`/`outside_window`/`all_day_series`/
    // `organizer`/`not_invited`, 403 `not_organizer`, 404 `not_found`, 409
    // `changed_on_google` (rileggi e rifai il gesto, Q4)/
    // `google_scope_missing` (+`missing`)/`account_disabled`/`token_expired`,
    // 422 `google_rejected` (+`reason`), 502 `google_unavailable`.

    /** Nuova riunione: gli inviti li manda Google, anche agli esterni (Q6). */
    createEvent(body: CalendarEventCreateInput): Promise<Reader<CalendarWriteResult>> {
      return request("POST", "/api/me/calendar/events", body, calendarWriteResultSchema);
    },

    /** Modifica (solo l'organizzatore), sull'`etag` letto. */
    editEvent(id: string, body: CalendarEventEditInput): Promise<Reader<CalendarWriteResult>> {
      return request("PATCH", `/api/me/calendar/events/${seg(id)}`, body, calendarWriteResultSchema);
    },

    /** Sposta o ridimensiona (solo l'organizzatore); una serie con lo stesso scarto su ogni data. */
    moveEvent(id: string, body: CalendarEventMoveInput): Promise<Reader<CalendarWriteResult>> {
      return request("POST", `/api/me/calendar/events/${seg(id)}/move`, body, calendarWriteResultSchema);
    },

    /** Sì / Forse / No con una nota (un invitato, non l'organizzatore). */
    respondEvent(id: string, body: CalendarEventRespondInput): Promise<Reader<CalendarWriteResult>> {
      return request("POST", `/api/me/calendar/events/${seg(id)}/respond`, body, calendarWriteResultSchema);
    },

    /** Elimina (solo l'organizzatore): 204. Le proposte aperte nate da lui se ne vanno con lui (Q5). */
    deleteEvent(id: string, options: { scope?: CalendarWriteScope; etag?: string | null } = {}): Promise<void> {
      return request("DELETE", `/api/me/calendar/events/${seg(id)}${toQuery({ scope: options.scope, etag: options.etag ?? undefined })}`);
    },

    /** Il progetto dell'evento, a mano (`projectBy: "manual"`), per tutti quelli che lo vedono (Q1). */
    setEventProject(id: string, projectId: string | null): Promise<Reader<CalendarWriteResult>> {
      return request("PUT", `/api/me/calendar/events/${seg(id)}/project`, { projectId }, calendarWriteResultSchema);
    },
  };
}
