import { serverDetailSchema, serverViewSchema } from "@stubwise/shared";
import type { Reader, ServerDetail, ServerView } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

const serverListSchema = z.array(serverViewSchema);

/**
 * I server di monitoraggio, in SOLA LETTURA (23 set 2026, hub di progetto,
 * tappa 3).
 *
 * Entrambe le rotte sono `requireAuth` e non `requireAdmin`: un operatore
 * vede lo stato delle macchine esattamente come un maintainer.
 *
 * ⚠️ **Nessun metodo di scrittura, ed è una scelta di prodotto**: registrare
 * un server, rigenerarne la chiave, cambiarne soglie e controlli si fa da un
 * computer. La chiave dell'agente in particolare non deve mai passare di qui
 * — `serverViewSchema` non la porta, e la variante con la chiave resta
 * dichiarata solo dentro la rotta.
 */
export function createServersEndpoints(request: ApiRequest) {
  return {
    /** I server, facoltativamente solo quelli associati a un progetto. */
    list(projectId?: string): Promise<Reader<ServerView>[]> {
      return request("GET", `/api/servers${toQuery({ projectId })}`, undefined, serverListSchema);
    },

    /**
     * Un server con lo snapshot dell'ultimo campione (servizi, dischi, memoria
     * e l'istante del campione). Liste vuote e `null` se non ne ha mai
     * mandati.
     */
    get(serverId: string): Promise<Reader<ServerDetail>> {
      return request("GET", `/api/servers/${seg(serverId)}`, undefined, serverDetailSchema);
    },
  };
}
