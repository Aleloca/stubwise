import {
  mailDetailSchema,
  mailOriginalSchema,
  mailPageSchema,
  mailReproposeResultSchema,
  mailSummarySchema,
} from "@stubwise/shared";
import type {
  Reader,
  MailDetail,
  MailItemStatus,
  MailOriginal,
  MailPage,
  MailReproposeResult,
  MailSummary,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/** Filtri di `GET /api/me/mail`. */
export interface MailFilters {
  account?: string;
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
export function createMailEndpoints(request: ApiRequest) {
  return {
    list(filters: MailFilters = {}, cursor?: string, limit?: number): Promise<Reader<MailPage>> {
      const query = toQuery({
        account: filters.account,
        status: filters.status,
        project: filters.project,
        cursor,
        limit,
      });
      return request("GET", `/api/me/mail${query}`, undefined, mailPageSchema);
    },

    /** Contatori per il badge di nav e l'intestazione della pagina. */
    summary(): Promise<Reader<MailSummary>> {
      return request("GET", "/api/me/mail/summary", undefined, mailSummarySchema);
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
