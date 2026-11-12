import {
  mailDetailSchema,
  mailOriginalSchema,
  mailPageSchema,
  mailRejectionsSchema,
  mailReproposeResultSchema,
  mailSummarySchema,
  mailThreadDetailSchema,
  mailThreadPageSchema,
} from "@stubwise/shared";
import type {
  Reader,
  MailDetail,
  MailItemStatus,
  MailOriginal,
  MailPage,
  MailRejections,
  MailReproposeResult,
  MailSource,
  MailSummary,
  MailThreadDetail,
  MailThreadPage,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/** Filtri di `GET /api/me/mail`. */
export interface MailFilters {
  account?: string;
  /**
   * Da quale sorgente leggere: `"email"` (posta e smistamenti) o
   * `"calendar"` (appuntamenti). Assente = entrambe, il comportamento
   * storico su cui la pagina `/mail` del web si appoggia. Lo usa la scheda
   * MBX dell'app, dove Posta e Calendario sono due viste distinte.
   */
  source?: MailSource;
  status?: MailItemStatus;
  project?: string;
}

/**
 * `id` di `GET /:source/:id` e `/:source/:id/original`: SOLO due dei tre
 * valori che il server accetta sulla rotta gemella di repropose
 * (`reproposeSourceSchema`, `apps/server/src/routes/me-mail.ts`) — il
 * dettaglio e la rilettura esistono solo per la posta, mai per un evento di
 * calendario, che non ha un "estratto" né un messaggio Gmail da rileggere
 * (i suoi campi sono già tutti nella riga di `MailItem`). `"email_triage"`
 * regge lo stesso spazio di id di `"email"`: il PADRE `email_messages` di
 * una proposta di smistamento, senza figli.
 */
export type MailDetailSource = "email" | "email_triage";

/** `id` di `POST /:source/:id/repropose`: le TRE sorgenti reali, vedi `MailDetailSource` sopra per il perché del terzo valore. */
export type MailReproposeSource = "email" | "calendar" | "email_triage";

/**
 * Posta (fase 6/6b/6c, 9): i messaggi Gmail e gli eventi di calendario
 * TRATTATI dal poller, per l'utente autenticato — `user_id` sempre nel WHERE
 * lato server, nessun ruolo scavalca (`apps/server/src/routes/me-mail.ts`).
 *
 * La lista è corta per costruzione (solo la posta AMMESSA entra): 33
 * messaggi su quattro caselle in produzione al momento in cui questo client
 * è stato scritto — non è una lista da client di posta.
 */
/**
 * I filtri di `threads` in forma d'oggetto (area 6, F1.4). `q`: la ricerca
 * nella pagina, da 2 a 200 caratteri dopo il trim (sotto, 400
 * `invalid_query`; vuoto = nessun filtro), in oggetto, mittente (nome e
 * indirizzo) ed estratto, mai in `to`/`cc`. Un thread passa se un suo
 * messaggio combacia.
 */
export interface MailThreadQuery {
  account?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  q?: string | undefined;
}

export function createMailEndpoints(request: ApiRequest) {
  return {
    list(filters: MailFilters = {}, cursor?: string, limit?: number): Promise<Reader<MailPage>> {
      const query = toQuery({
        account: filters.account,
        source: filters.source,
        status: filters.status,
        project: filters.project,
        cursor,
        limit,
      });
      return request("GET", `/api/me/mail${query}`, undefined, mailPageSchema);
    },

    /**
     * La posta per CONVERSAZIONE («la posta si legge per conversazione» §4):
     * una riga per thread invece che una per messaggio.
     *
     * ⚠️ Vive ACCANTO a {@link list}, non al suo posto: quella la legge
     * un'app già installata e la usa anche il calendario, che thread non ne
     * ha. Chi disegna una lista di posta usa questa; chi mostra anche gli
     * appuntamenti resta su `list`.
     */
    threads(
      accountOrOptions?: string | MailThreadQuery,
      cursor?: string,
      limit?: number,
    ): Promise<Reader<MailThreadPage>> {
      // Due firme: quella posizionale di prima (web e app la usano) e
      // l'oggetto (area 6, F1.4), che porta anche `q`.
      const options: MailThreadQuery =
        typeof accountOrOptions === "object" ? accountOrOptions : { account: accountOrOptions, cursor, limit };
      const query = toQuery({ account: options.account, cursor: options.cursor, limit: options.limit, q: options.q });
      return request("GET", `/api/me/mail/threads${query}`, undefined, mailThreadPageSchema);
    },

    /**
     * Letto / non letto su GMAIL (area 6, F1.3): scrive sulla casella (tutto
     * il thread) e lo stato locale solo dopo il sì di Google; risponde col
     * dettaglio aggiornato. 409 `google_scope_missing` (con `missing` nei
     * `details`) per una casella da ricollegare, `account_disabled`,
     * `token_expired`; 404 un thread non tuo; 502 `google_unavailable`.
     */
    setRead(threadId: string, account: string, read: boolean): Promise<Reader<MailThreadDetail>> {
      return request("POST", `/api/me/mail/threads/${seg(threadId)}/read`, { account, read }, mailThreadDetailSchema);
    },

    /**
     * Il dettaglio di una conversazione: i messaggi in ordine, ciascuno con
     * la sua provenienza — `admitted: false` è un messaggio tirato dentro
     * come CONTESTO del thread, che si legge ma non produce proposte.
     *
     * `threadId` è l'id Gmail del thread, non un uuid. `account` serve solo
     * quando lo stesso thread è su due caselle dello stesso utente.
     */
    thread(threadId: string, account?: string): Promise<Reader<MailThreadDetail>> {
      return request(
        "GET",
        `/api/me/mail/threads/${seg(threadId)}${toQuery({ account })}`,
        undefined,
        mailThreadDetailSchema,
      );
    },

    /** Contatori per il badge di nav e l'intestazione della pagina. */
    summary(): Promise<Reader<MailSummary>> {
      return request("GET", "/api/me/mail/summary", undefined, mailSummarySchema);
    },

    /**
     * Le mail tenute fuori dal cancello di ammissione, per casella, motivo e
     * dominio, negli ultimi `days` giorni (1..30; assente = default del
     * server, 7). Solo le caselle di chi chiede. Un server più vecchio
     * risponde 404: la lettura è accessoria, chi la usa la nasconde.
     */
    rejections(days?: number): Promise<Reader<MailRejections>> {
      return request("GET", `/api/me/mail/rejections${toQuery({ days })}`, undefined, mailRejectionsSchema);
    },

    /**
     * Dettaglio dall'ESTRATTO già in database — nessuna chiamata a Google,
     * funziona anche a token scaduto o con Google irraggiungibile.
     * `textExcerpt` è `null` sui messaggi anteriori alla fase 6 (il poller
     * non l'ha salvato): non è un errore, va dichiarato assente, non un
     * campo vuoto.
     */
    get(source: MailDetailSource, id: string): Promise<Reader<MailDetail>> {
      return request("GET", `/api/me/mail/${seg(source)}/${seg(id)}`, undefined, mailDetailSchema);
    },

    /**
     * Il messaggio ORIGINALE, riletto da Gmail SU RICHIESTA — non persiste
     * nulla, è una finestra su Gmail, non una copia. Errori veri: 409
     * `message_gone` (cancellato/spostato su Gmail), 409 `token_expired`
     * (la casella va ricollegata), 502 `google_unavailable`. In ogni caso
     * l'estratto di `get()` resta leggibile: questa è solo un supplemento.
     */
    original(source: MailDetailSource, id: string): Promise<Reader<MailOriginal>> {
      return request("GET", `/api/me/mail/${seg(source)}/${seg(id)}/original`, undefined, mailOriginalSchema);
    },

    /**
     * Riproponi una riga `failed`/`ignored`: NON pubblica una proposta nuova
     * da qui, resetta solo lo stato perché il prossimo tick del poller la
     * riprenda. 409 `not_reproposable` se lo stato non lo permette.
     */
    repropose(source: MailReproposeSource, id: string): Promise<Reader<MailReproposeResult>> {
      return request(
        "POST",
        `/api/me/mail/${seg(source)}/${seg(id)}/repropose`,
        undefined,
        mailReproposeResultSchema,
      );
    },
  };
}
