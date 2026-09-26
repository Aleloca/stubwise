import type { InboxGoogle } from "./schemas/notification.js";

/**
 * Le azioni che il MODELLO propone da una mail: le sole che si possono
 * sommare. «Sposta su un altro progetto» (`reassign_project`) e «Non fare
 * nulla» (`ignore`) sono esclusive per natura; lo smistamento
 * (`choose_project`) e il promemoria di una serie non sono proposte di posta.
 */
const MODEL_ACTIONS: ReadonlySet<string> = new Set([
  "create_backlog_item",
  "create_milestone",
  "update_ticket",
  "comment_ticket",
  "record_decision",
]);

/**
 * QUALI OPZIONI DI UNA CARD SI SOMMANO («una mail, più azioni e più
 * progetti», 26 set 2026, design §2): gli indici delle azioni proposte dal
 * modello, solo per le card di POSTA e solo se sono almeno due. Altrimenti
 * `[]`, cioè la card resta a scelta singola, come prima.
 *
 * ⚠️ UNA regola per due domande: il server la chiama per MOSTRARE le caselle
 * (`readGoogle`, che la DERIVA A LETTURA e non la scrive mai nell'evento, così
 * vale anche per le card già in inbox) e per ACCETTARE una risposta multipla
 * (`answerGoogleProposal`). Due copie divergerebbero, e un client che
 * mostrasse caselle che il server rifiuta darebbe `invalid_answer` al tap.
 * I client leggono `multiSelectIndices` e non la ricalcolano.
 */
export function multiSelectableIndices(
  source: InboxGoogle["source"] | string,
  actions: readonly { type: string }[],
): number[] {
  if (source !== "email") return [];
  const indices = actions.flatMap((action, index) => (MODEL_ACTIONS.has(action.type) ? [index] : []));
  return indices.length >= 2 ? indices : [];
}
