import { startRefineSessionResultSchema, type StartRefineSessionInput } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * Sessioni di refinement del backlog (design 2026-10-14). Chiunque possa
 * lavorare sul backlog. Contro un server che non ha la funzione la rotta è un
 * 404 SENZA `code`: `isAgentSessionsUnavailable` lo riconosce, e il bottone
 * non si mostra.
 */
export function createBacklogRefineEndpoints(request: ApiRequest) {
  return {
    /**
     * Apre (o riapre) la sessione della voce; col messaggio, accoda anche il
     * primo turno. Il corpo è SEMPRE un JSON (`{}` senza messaggio): la rotta
     * valida il body, e un POST senza corpo non è la forma che il server prova.
     */
    start(itemId: string, body: StartRefineSessionInput = {}) {
      return request("POST", `/api/backlog/${seg(itemId)}/refine-session`, body, startRefineSessionResultSchema);
    },
    /** Chiude la sessione della voce (idempotente: 204 anche se non ce n'è una aperta). */
    close(itemId: string): Promise<void> {
      return request("DELETE", `/api/backlog/${seg(itemId)}/refine-session`);
    },
  };
}
