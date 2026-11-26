import { meHomeViewSchema } from "@stubwise/shared";
import type { HomeBlock, MeHomeView, Reader } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * La Home a blocchi di chi guarda (integrazione area 2, fetta 3): già risolta
 * dal server (fissi, unione dei reparti, «è cambiata», novità). Un blocco di
 * un kind che il client non conosce si ignora.
 */
export function createHomeEndpoints(request: ApiRequest) {
  return {
    get(): Promise<Reader<MeHomeView>> {
      return request("GET", "/api/me/home", undefined, meHomeViewSchema);
    },
    /** Salva la Home personale (il server la normalizza) e risponde con la Home risolta. */
    set(blocks: HomeBlock[]): Promise<Reader<MeHomeView>> {
      return request("PUT", "/api/me/home", { blocks }, meHomeViewSchema);
    },
    /** Torna alla Home dei reparti. 204. */
    reset(): Promise<void> {
      return request("DELETE", "/api/me/home");
    },
    /**
     * «Vedi le novità»: segna vista la Home del reparto fino alla versione
     * mostrata (`updatedAt` di `departmentHomes`); una modifica arrivata dopo
     * resta «cambiata». 204, anche per un reparto di cui non si è membri.
     */
    markSeen(departmentId: string, updatedAt: string): Promise<void> {
      return request("POST", `/api/me/home/seen/${seg(departmentId)}`, { updatedAt });
    },
  };
}
