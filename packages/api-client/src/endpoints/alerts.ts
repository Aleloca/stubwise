import {
  alertSubscriptionRowSchema,
  alertSubscriptionsBeforeSchema,
  alertSubscriptionsListSchema,
  type AlertSubscriptionRow,
  type ProjectSubscriptions,
  type Reader,
  type SetAlertSubscriptionInput,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * Le iscrizioni agli avvisi di chi chiede (area 8, F2, S8), sopra
 * `/api/me/alert-subscriptions`. Righe e stati li calcola il server (il
 * client legge, non deduce); copia e «Mute» rispondono con le righe di PRIMA:
 * l'«Annulla» riscrive con `set` quelle `saved` e riporta le altre al default
 * con `reset` (review F2).
 */
export function createAlertEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<{ items: ProjectSubscriptions[] }>> {
      return request("GET", "/api/me/alert-subscriptions", undefined, alertSubscriptionsListSchema);
    },
    /** Una patch della riga (`type` = il tipo della riga): scrive anche i suoi partner. */
    set(projectId: string, type: string, patch: SetAlertSubscriptionInput): Promise<Reader<AlertSubscriptionRow>> {
      return request("PUT", `/api/me/alert-subscriptions/${seg(projectId)}/${seg(type)}`, patch, alertSubscriptionRowSchema);
    },
    /** Torna al default: toglie la scelta salvata della riga e dei suoi partner (review F2). */
    reset(projectId: string, type: string): Promise<Reader<AlertSubscriptionRow>> {
      return request("DELETE", `/api/me/alert-subscriptions/${seg(projectId)}/${seg(type)}`, undefined, alertSubscriptionRowSchema);
    },
    copy(projectId: string, fromProjectId: string): Promise<Reader<{ before: AlertSubscriptionRow[] }>> {
      return request("POST", `/api/me/alert-subscriptions/${seg(projectId)}/copy`, { fromProjectId }, alertSubscriptionsBeforeSchema);
    },
    mute(projectId: string): Promise<Reader<{ before: AlertSubscriptionRow[] }>> {
      return request("POST", `/api/me/alert-subscriptions/${seg(projectId)}/mute`, undefined, alertSubscriptionsBeforeSchema);
    },
  };
}
