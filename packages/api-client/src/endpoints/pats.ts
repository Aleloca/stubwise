import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * Personal Access Token dell'utente corrente (`apps/server/src/routes/pat.ts`).
 *
 * Solo `revoke`, per ora: è il solo metodo che serve al logout dell'app
 * mobile (Task 20) — revocare il PAT che `mobile-login` ha emesso per QUESTO
 * device, così un token rubato dal Keychain di un telefono perso smette di
 * funzionare. La lista (`GET /api/pats`) e la creazione (`POST /api/pats`)
 * restano SPA-only finché l'app non avrà un motivo per gestire token diversi
 * dal proprio.
 *
 * `DELETE /api/pats/:id` — a differenza di `deleteDevice` (`me.ts`), l'id nel
 * path qui NON è un segreto: è l'id UUID della riga PAT (`patId` di
 * `StoredSession`, vedi `lib/storage.ts`), non il token in chiaro. Finire nei
 * log dell'URL è innocuo, quindi niente `POST .../delete` con corpo — lo
 * stesso verbo/path che usa già `apps/web/src/lib/api.ts`.
 */
export function createPatsEndpoints(request: ApiRequest) {
  return {
    /** Revoca il PAT indicato: 204, anche se era già stato revocato o non esiste (nessun leak d'esistenza). */
    revoke(id: string): Promise<void> {
      return request("DELETE", `/api/pats/${seg(id)}`);
    },
  };
}
