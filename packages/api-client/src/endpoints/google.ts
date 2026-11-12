import { z } from "zod";
import {
  googleAccountSchema,
  googleConnectResponseSchema,
  googleSyncResponseSchema,
  googleWorkspaceOptionSchema,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * Il cassetto Google comune a Drive, Posta e Calendario (area 6, fetta 1):
 * `/api/me/google`. Collegare apre `authorizeUrl` nel browser di sistema; il
 * callback resta quello del web, che dice l'esito, e chi chiama rilegge
 * `accounts()` al ritorno. Ricollegare = `connect` con lo stesso Workspace:
 * la casella esistente prende gli scope nuovi. `missingScopes` di una casella
 * dice cosa le manca dal riconsenso dell'area 6 (una casella di prima legge
 * ancora).
 */
export function createGoogleEndpoints(request: ApiRequest) {
  return {
    /** I Workspace da cui collegarsi (`clientSecretSet` falso = inutilizzabile). */
    workspaces() {
      return request("GET", "/api/me/google/workspaces", undefined, z.array(googleWorkspaceOptionSchema));
    },
    /** L'URL di consenso di Google per il Workspace scelto. */
    connect(workspaceId: string) {
      return request("POST", "/api/me/google/connect", { workspaceId }, googleConnectResponseSchema);
    },
    /** Le MIE caselle, con l'allineamento e `missingScopes`. */
    accounts() {
      return request("GET", "/api/me/google/accounts", undefined, z.array(googleAccountSchema));
    },
    /** «Proposte attive per questa casella». */
    setProposals(id: string, proposalsEnabled: boolean) {
      return request("PATCH", `/api/me/google/accounts/${seg(id)}`, { proposalsEnabled }, googleAccountSchema);
    },
    /**
     * «Aggiorna ora»: il giro di questa casella adesso. 202 `queued` o
     * `already_queued`; 429 `sync_too_soon` (meno di 60 s dall'ultima, con
     * `retryAfterSeconds` nei `details` dell'errore); 409 `account_disabled`
     * («Ricollega») o `proposals_disabled` (la casella non si sincronizza);
     * 404 una casella non tua. La fine si legge su `accounts()`:
     * `syncRequestedAt` torna null, e `lastSyncAt` avanza se il giro è riuscito.
     */
    sync(id: string) {
      return request("POST", `/api/me/google/accounts/${seg(id)}/sync`, undefined, googleSyncResponseSchema);
    },
    /** Scollega: revoca su Google e toglie la posta ingerita della casella. */
    disconnect(id: string): Promise<void> {
      return request("DELETE", `/api/me/google/accounts/${seg(id)}`);
    },
  };
}
