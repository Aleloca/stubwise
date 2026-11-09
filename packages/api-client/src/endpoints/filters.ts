import { savedFilterViewSchema } from "@stubwise/shared";
import type { FilterPatchBody, NewFilterBody, Reader, SavedFilterView } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";

/**
 * I filtri salvati dell'app nuova (integrazione area 2, fetta 3): i miei e i
 * pubblici, e i fissati nella colonna. Un privato d'altri risponde 404 come
 * uno che non esiste. Le task di un filtro si leggono con `tasks.list(criteria)`:
 * un filtro pubblico mostra a ciascuno solo le task che vede già.
 */
export function createFiltersEndpoints(request: ApiRequest) {
  const enc = encodeURIComponent;
  return {
    /** I miei filtri e i pubblici (compresi quelli di esempio, `ownerId` null). */
    list(): Promise<Reader<SavedFilterView>[]> {
      return request("GET", "/api/filters", undefined, z.array(savedFilterViewSchema));
    },

    get(id: string): Promise<Reader<SavedFilterView>> {
      return request("GET", `/api/filters/${enc(id)}`, undefined, savedFilterViewSchema);
    },

    create(body: NewFilterBody): Promise<Reader<SavedFilterView>> {
      return request("POST", "/api/filters", body, savedFilterViewSchema);
    },

    /** Una patch: gli assenti restano invariati. L'autore o un full admin. */
    update(id: string, patch: FilterPatchBody): Promise<Reader<SavedFilterView>> {
      return request("PATCH", `/api/filters/${enc(id)}`, patch, savedFilterViewSchema);
    },

    /** L'autore o un full admin; il filtro sparisce dai fissati di tutti. 204. */
    remove(id: string): Promise<void> {
      return request("DELETE", `/api/filters/${enc(id)}`);
    },

    /** Gli id dei filtri che ho fissato e vedo ancora, nell'ordine in cui li ho fissati. */
    pinned(): Promise<string[]> {
      return request("GET", "/api/me/pinned-filters", undefined, z.array(z.string()));
    },

    /** In coda ai miei fissati; già fissato resta dov'è. 204. */
    pin(id: string): Promise<void> {
      return request("PUT", `/api/me/pinned-filters/${enc(id)}`);
    },

    unpin(id: string): Promise<void> {
      return request("DELETE", `/api/me/pinned-filters/${enc(id)}`);
    },
  };
}
