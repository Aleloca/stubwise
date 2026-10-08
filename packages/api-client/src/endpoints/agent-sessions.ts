import {
  agentSessionDetailSchema,
  agentSessionEventPageSchema,
  agentSessionListSchema,
  sendAgentMessageResultSchema,
  type AgentSessionListQuery,
  type SendAgentMessageInput,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { ApiError } from "../errors.js";
import { seg, toQuery } from "../query.js";

/**
 * Sessioni degli agenti (design 2026-10-08). Lettura per tutti; `send` è da
 * maintainer (il server risponde 403 a un member: il client non lo deduce,
 * legge `canWrite` dal dettaglio).
 */
export function createAgentSessionsEndpoints(request: ApiRequest) {
  return {
    /** Al lavoro ora + concluse; filtri facoltativi in AND. */
    list(filters: AgentSessionListQuery = {}) {
      return request(
        "GET",
        `/api/agent-sessions${toQuery({ projectId: filters.projectId, ticketId: filters.ticketId, aiJobId: filters.aiJobId })}`,
        undefined,
        agentSessionListSchema,
      );
    },
    get(id: string) {
      return request("GET", `/api/agent-sessions/${seg(id)}`, undefined, agentSessionDetailSchema);
    },
    /** `before`: eventi più vecchi (pagina all'indietro); `after`: più nuovi, in ordine crescente. */
    events(id: string, page: { before?: string; after?: string; limit?: number } = {}) {
      return request(
        "GET",
        `/api/agent-sessions/${seg(id)}/events${toQuery({ before: page.before, after: page.after, limit: page.limit })}`,
        undefined,
        agentSessionEventPageSchema,
      );
    },
    send(id: string, body: SendAgentMessageInput) {
      return request("POST", `/api/agent-sessions/${seg(id)}/messages`, body, sendAgentMessageResultSchema);
    },
    /** Path dello stream SSE: il trasporto lo sceglie il client (EventSource sul web, polyfill sull'app). */
    streamPath(id: string, after?: string) {
      return `/api/agent-sessions/${seg(id)}/stream${toQuery({ after })}`;
    },
  };
}

/**
 * L'istanza non ha le sessioni degli agenti (server più vecchio): l'app è UNA
 * per tutte le istanze, e lì la sezione deve dire «non disponibile su questa
 * istanza», né vuota né rotta (design §9).
 *
 * Il segnale è il 404 di una rotta NON registrata, che Fastify manda senza
 * `code`. Il 404 delle rotte vere (`not_found`: sessione inesistente o posta
 * di un altro utente) ha sempre il suo `code`, e non vuol dire che la
 * funzione manchi.
 */
export function isAgentSessionsUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === undefined;
}
