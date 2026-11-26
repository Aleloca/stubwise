import { whatCanResponseSchema, whoCanResponseSchema } from "@stubwise/shared";
import type { Reader, WhatCanResponse, WhoCanResponse } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { toQuery } from "../query.js";

/**
 * Area 9, F1 (design 1.7): «Chi può farlo?» e «Cosa può fare?». Il server
 * calcola, il client mostra: la mappa azione → permesso è del client, il
 * resto no. `projectId` solo per un permesso di progetto (422 `wrong_scope`
 * altrimenti). Claude non ha una riga: `agent.actsFor` dice che agisce coi
 * permessi di chi assegna o conferma.
 */
export function createAccessEndpoints(request: ApiRequest) {
  return {
    whoCan(params: { permission: string; projectId?: string }): Promise<Reader<WhoCanResponse>> {
      return request("GET", `/api/access/who-can${toQuery(params)}`, undefined, whoCanResponseSchema);
    },
    whatCan(params: { userId: string; projectId?: string }): Promise<Reader<WhatCanResponse>> {
      return request("GET", `/api/access/what-can${toQuery(params)}`, undefined, whatCanResponseSchema);
    },
  };
}
