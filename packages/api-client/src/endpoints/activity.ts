import { activityForDateSchema, chronologyPageSchema } from "@stubwise/shared";
import type { ActivityForDate, ChronologyPage, Reader } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { toQuery } from "../query.js";

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
    /**
     * L'attività di tutti i progetti visibili (fetta 4), dalla più recente, a
     * pagine di 28 giorni come la cronologia di progetto; ogni voce col suo
     * progetto. Solo ciò che è già successo.
     */
    portfolio(before?: string): Promise<Reader<ChronologyPage>> {
      return request("GET", `/api/activity/portfolio${toQuery({ before })}`, undefined, chronologyPageSchema);
    },

    forDate(date: string): Promise<Reader<ActivityForDate>> {
      return request("GET", `/api/activity${toQuery({ date })}`, undefined, activityForDateSchema);
    },
  };
}
