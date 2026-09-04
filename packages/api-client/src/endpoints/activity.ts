import { activityForDateSchema } from "@stubwise/shared";
import type { ActivityForDate, Reader } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";

/**
 * Daily Activity Report (feature pre-esistente, non di questa fase): SOLO la
 * lettura per data, e SOLO il sottoinsieme che `activityForDateSchema`
 * dichiara (il riassunto narrativo per progetto). Serve a "Report di ieri"
 * nel dettaglio progetto dell'app mobile (Fase 4, Task 15) — v1 mostra il
 * riassunto, non la lista commit né la vista per-sviluppatore, quindi non è
 * mappata qui: chi la vorrà un domani allarga lo schema condiviso, non
 * aggiunge un secondo metodo.
 */
export function createActivityEndpoints(request: ApiRequest) {
  return {
    forDate(date: string): Promise<Reader<ActivityForDate>> {
      return request("GET", `/api/activity?date=${encodeURIComponent(date)}`, undefined, activityForDateSchema);
    },
  };
}
