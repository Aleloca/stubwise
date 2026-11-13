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
  | `stubwise:${Extract<AutomationTrigger, { kind: "stubwise" }>["event"]}`;

export interface AutomationAvailability {
  steps: readonly Step["kind"][];
  triggers: readonly TriggerKey[];
  /** Gli allegati di un'email (da campi file); assente = ammessi. */
  emailAttachments?: boolean;
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

/**
 * La fetta 2: in più l'email (dalla casella del proprietario, senza allegati:
 * F2-5 = a), le attese, il «ripeti finché», gli inizi a orario e «email in
 * arrivo». Claude (F3), «avvia un'automazione» e le sorgenti (F4) restano fuori.
 */
export const AUTOMATION_F2_AVAILABILITY: AutomationAvailability = {
  steps: [...AUTOMATION_F1_AVAILABILITY.steps, "sendEmail", "wait", "repeatUntil"],
  triggers: [...AUTOMATION_F1_AVAILABILITY.triggers, "schedule", "stubwise:mail_received"],
  emailAttachments: false,
};

/**
 * La fetta 3: in più il passo di Claude (istruzione, input, uscite e campi
 * dichiarati). Le email restano senza allegati; «avvia un'automazione» e le
 * sorgenti sono della F4.
 */
export const AUTOMATION_F3_AVAILABILITY: AutomationAvailability = {
  ...AUTOMATION_F2_AVAILABILITY,
  steps: [...AUTOMATION_F2_AVAILABILITY.steps, "claude"],
};

/**
 * La fetta 4: in più l'inizio da una sorgente (solo il webhook in arrivo: le
 * sorgenti Audin e HubSpot non esistono nel server, quindi un flusso che le
 * nomina ha una sorgente sconosciuta) e «avvia un'altra automazione». Le
 * generali non sono un passo: le decide il permesso d'istanza.
 */
export const AUTOMATION_F4_AVAILABILITY: AutomationAvailability = {
  ...AUTOMATION_F3_AVAILABILITY,
  steps: [...AUTOMATION_F3_AVAILABILITY.steps, "startAutomation"],
  triggers: [...AUTOMATION_F3_AVAILABILITY.triggers, "source"],
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
