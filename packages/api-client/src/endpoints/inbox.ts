import {
  inboxActionResultSchema,
  inboxPageSchema,
  snoozeResultSchema,
  unreadCountSchema,
} from "@stubwise/shared";
import type {
  AnswerBody,
  InboxActionResult,
  InboxDecisionAction,
  InboxPage,
  InboxStatus,
  SnoozeResult,
  SnoozeUntil,
  UnreadCount,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/** Filtri di `GET /api/inbox`. Senza `status` il server torna l'inbox APERTA. */
export interface InboxFilters {
  status?: InboxStatus;
  projectId?: string;
}

/**
 * Corpo di un'azione decisionale: le istruzioni del rifiuto OPPURE la risposta a
 * una domanda dell'agente ({@link AnswerBody}: esattamente uno fra opzione e
 * testo). La rotta è una sola per quattro azioni, e ognuna guarda solo i campi
 * che la riguardano.
 */
export type InboxActionBody = { instructions?: string } | AnswerBody;

/**
 * Inbox personale: la superficie principale dell'app mobile.
 *
 * Le rotte sono di due famiglie e non vanno confuse: `read`/`snooze`/`handled`
 * sono igiene PERSONALE (toccano solo la riga di chi chiama), mentre
 * `actions/:action` è una DECISIONE, che chiude in blocco le copie della stessa
 * notifica anche degli altri destinatari — per questo torna
 * `changedNotificationIds`.
 */
export function createInboxEndpoints(request: ApiRequest) {
  /**
   * Azione DECISIONALE (approva/rifiuta il piano, rilancia, rispondi).
   *
   * Errori attesi (tutti `ApiError`): 409 `already_handled` — qualcun altro ha
   * deciso prima, con `handledBy` nel body (vedi `handledByFromError`); 409
   * `job_in_flight`, `plan_not_pending`, `question_not_pending`,
   * `proposal_stale`; 403 `forbidden`; 400 `invalid_action`/`invalid_answer`.
   */
  function act(
    id: string,
    action: InboxDecisionAction,
    body?: InboxActionBody,
  ): Promise<InboxActionResult> {
    return request("POST", `/api/inbox/${seg(id)}/actions/${action}`, body, inboxActionResultSchema);
  }

  return {
    list(filters: InboxFilters = {}, cursor?: string, limit?: number): Promise<InboxPage> {
      const query = toQuery({
        status: filters.status,
        projectId: filters.projectId,
        cursor,
        limit,
      });
      return request("GET", `/api/inbox${query}`, undefined, inboxPageSchema);
    },

    /** Contatore della campanella: lettura pura, interrogata in polling. */
    unreadCount(): Promise<UnreadCount> {
      return request("GET", "/api/inbox/unread-count", undefined, unreadCountSchema);
    },

    /** Segna la notifica come letta. Idempotente (204 anche se lo era già). */
    read(id: string): Promise<void> {
      return request("POST", `/api/inbox/${seg(id)}/read`);
    },

    /** Rinvia la notifica; la scadenza torna indietro per dirlo senza ricaricare. */
    snooze(id: string, until: SnoozeUntil): Promise<SnoozeResult> {
      return request("POST", `/api/inbox/${seg(id)}/snooze`, { until }, snoozeResultSchema);
    },

    /** Archivia la notifica: chiude solo la propria riga, mai quelle altrui. */
    handled(id: string): Promise<void> {
      return request("POST", `/api/inbox/${seg(id)}/handled`);
    },

    act,

    /**
     * Risposta a una domanda dell'agente DALL'INBOX. È l'azione più usata
     * dell'app e merita un nome suo, ma DELEGA ad `act`: il path della rotta
     * azione è costruito in un posto solo.
     */
    answer(id: string, answer: AnswerBody): Promise<InboxActionResult> {
      return act(id, "answer", answer);
    },
  };
}
