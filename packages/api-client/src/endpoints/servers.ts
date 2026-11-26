import {
  serverCheckViewSchema,
  serverDetailSchema,
  serverMetricsResponseSchema,
  serverSearchResultSchema,
  serverViewSchema,
  serverWithKeySchema,
} from "@stubwise/shared";
import type {
  AlertThresholds,
  CreateCheckInput,
  CreateServerInput,
  Reader,
  ServerCheckView,
  ServerDetail,
  ServerMetricsResponse,
  ServerSearchResult,
  ServerView,
  ServerWithKey,
  UpdateCheckInput,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

const serverListSchema = z.array(serverViewSchema);
const checkListSchema = z.array(serverCheckViewSchema);
const searchListSchema = z.object({ items: z.array(serverSearchResultSchema) });

/**
 * I server di monitoraggio.
 *
 * Le LETTURE (23 set 2026, hub di progetto, tappa 3; area 8, F4a: per codice,
 * metriche, controlli): un server si vede con `monitor.view`/`monitor.manage`
 * o dagli ambienti dei progetti visibili; uno invisibile risponde 404.
 *
 * Le SCRITTURE (area 8, F4a, per l'app desktop; `monitor.manage`, il
 * collegamento a un ambiente anche `environments.manage`). ⚠️ L'app mobile
 * resta in sola lettura per scelta di prodotto: registrare un server o
 * rigenerarne la chiave si fa da un computer. La chiave dell'agente passa
 * SOLO dalla risposta di `create` e `regenerateKey` (`serverWithKeySchema`),
 * mai da una lettura: chi la mostra la tiene fuori dalla cache (regola I2).
 */
export function createServersEndpoints(request: ApiRequest) {
  const base = (serverId: string) => `/api/servers/${seg(serverId)}`;
  return {
    /** I server, facoltativamente solo quelli degli ambienti di un progetto. */
    /**
     * ⌘K (rimandi, lotto 5): i server per codice, nome o hostname fra quelli
     * visibili, per nome, al massimo 20; meno di 2 caratteri: nessuno.
     */
    async search(q: string): Promise<Reader<ServerSearchResult>[]> {
      return (await request("GET", `/api/servers/search${toQuery({ q })}`, undefined, searchListSchema)).items;
    },

    list(projectId?: string): Promise<Reader<ServerView>[]> {
      return request("GET", `/api/servers${toQuery({ projectId })}`, undefined, serverListSchema);
    },

    /**
     * Un server con lo snapshot dell'ultimo campione (servizi, dischi, memoria
     * e l'istante del campione), i controlli, gli episodi. Liste vuote e
     * `null` se non ne ha mai mandati.
     */
    get(serverId: string): Promise<Reader<ServerDetail>> {
      return request("GET", base(serverId), undefined, serverDetailSchema);
    },

    /** Area 8, F4a: lo stesso dettaglio per codice (`SRV-<n>`). */
    byCode(code: string): Promise<Reader<ServerDetail>> {
      return request("GET", `/api/servers/by-code/${seg(code)}`, undefined, serverDetailSchema);
    },

    /** Area 8, F4a: le metriche fra `from` e `to` (ISO); il passo lo dice `resolution`. */
    metrics(serverId: string, range: { from: string; to: string; checkId?: string }): Promise<Reader<ServerMetricsResponse>> {
      return request("GET", `${base(serverId)}/metrics${toQuery(range)}`, undefined, serverMetricsResponseSchema);
    },

    /** Area 8, F4a: i controlli (mai il DSN: `hasDsn`). */
    checks(serverId: string): Promise<Reader<ServerCheckView>[]> {
      return request("GET", `${base(serverId)}/checks`, undefined, checkListSchema);
    },

    // --- Scritture (area 8, F4a: app desktop) ---------------------------------

    /** Registra un server, facoltativamente già in un ambiente. La chiave UNA volta. */
    create(input: CreateServerInput): Promise<Reader<ServerWithKey>> {
      return request("POST", "/api/servers", input, serverWithKeySchema);
    },

    /** Nome e intervallo di campionamento (i progetti vengono dagli ambienti). */
    update(serverId: string, patch: { name?: string; sampleIntervalSeconds?: number }): Promise<Reader<ServerView>> {
      return request("PATCH", base(serverId), patch, serverViewSchema);
    },

    /** Le soglie: SOSTITUZIONE, l'oggetto va mandato intero. */
    setThresholds(serverId: string, thresholds: AlertThresholds): Promise<Reader<ServerView>> {
      return request("PATCH", base(serverId), { alertThresholds: thresholds }, serverViewSchema);
    },

    /** Una chiave nuova (la vecchia smette di valere). La chiave UNA volta. */
    regenerateKey(serverId: string): Promise<Reader<ServerWithKey>> {
      return request("POST", `${base(serverId)}/regenerate-key`, undefined, serverWithKeySchema);
    },

    delete(serverId: string): Promise<void> {
      return request("DELETE", base(serverId));
    },

    createCheck(serverId: string, input: CreateCheckInput): Promise<Reader<ServerCheckView>> {
      return request("POST", `${base(serverId)}/checks`, input, serverCheckViewSchema);
    },

    updateCheck(serverId: string, checkId: string, patch: UpdateCheckInput): Promise<Reader<ServerCheckView>> {
      return request("PUT", `${base(serverId)}/checks/${seg(checkId)}`, patch, serverCheckViewSchema);
    },

    deleteCheck(serverId: string, checkId: string): Promise<void> {
      return request("DELETE", `${base(serverId)}/checks/${seg(checkId)}`);
    },
  };
}
