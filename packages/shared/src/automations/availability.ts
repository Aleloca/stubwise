import type { AutomationTrigger, Step } from "./types.js";

// Quali passi e inizi offre una build (area 7, piano della fetta 1): un flusso
// che usa un pezzo di una fetta dopo è un errore di configurazione
// `not_available` (in `validateFlow`) e non si pubblica. La regola sta qui,
// nel motore condiviso, perché server e app non divergano.

/** Un inizio, per tipo: `stubwise:<evento>` per gli eventi di Stubwise. */
export type TriggerKey =
  | "manual"
  | "schedule"
  | "source"
  | `stubwise:${Extract<AutomationTrigger, { kind: "stubwise" }>["event"] | "request_converted"}`;

export interface AutomationAvailability {
  steps: readonly Step["kind"][];
  triggers: readonly TriggerKey[];
}

/**
 * La fetta 1: automazioni di progetto, inizi di Stubwise (task creata e
 * chiusa, richiesta creata e convertita, traguardo raggiunto) e a mano; passi
 * crea task, traguardo, richiesta, avvisa, condizione, «per ogni».
 */
export const AUTOMATION_F1_AVAILABILITY: AutomationAvailability = {
  steps: ["createTask", "createMilestone", "createRequest", "notify", "condition", "forEach"],
  triggers: [
    "manual",
    "stubwise:task_created",
    "stubwise:task_closed",
    "stubwise:request_created",
    "stubwise:request_converted",
    "stubwise:milestone_reached",
  ],
};

/** La chiave di disponibilità di un inizio. */
export const triggerKey = (t: AutomationTrigger): TriggerKey =>
  t.kind === "stubwise" ? `stubwise:${t.event}` : t.kind;

/**
 * Una catena di avvii al più di 3 esecuzioni (`CHAIN_MAX`, del prototipo):
 * un evento prodotto da un'esecuzione non riavvia un'automazione già fra i
 * suoi antenati, e la catena si ferma a 3. È una PROFONDITÀ, non una quantità.
 */
export const CHAIN_MAX = 3;

/**
 * `ancestors`: l'esecuzione d'origine dell'evento e le sue madri (per
 * `parentRunId`), vuoto se l'evento non viene da un'esecuzione.
 */
export function chainAllows(
  ancestors: readonly { automationId: string }[],
  automationId: string,
): boolean {
  return !ancestors.some((r) => r.automationId === automationId) && ancestors.length < CHAIN_MAX;
}
