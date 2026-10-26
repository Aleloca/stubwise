import type { AutomationTrigger, DataField } from "../../data/types";

// I dati che portano gli inizi interni (eventi di Stubwise, data, a mano) e
// quelli che un'attesa di risposta scrive: li usa `availableFields` (Task 2).
// Gli inizi da sorgente portano i `fields` della loro `AutomationSource`.

type StubwiseEvent = Extract<AutomationTrigger, { kind: "stubwise" }>["event"];

const TASK_FIELDS: DataField[] = [
  { key: "task.codice", label: "Codice della task", type: "text" },
  { key: "task.titolo", label: "Titolo della task", type: "text" },
  { key: "task.progetto", label: "Progetto", type: "text" },
  { key: "task.incaricato", label: "Incaricato", type: "person" },
  { key: "task.stato", label: "Stato", type: "text" },
];

export const STUBWISE_TRIGGER_FIELDS: Record<StubwiseEvent, DataField[]> = {
  task_created: TASK_FIELDS,
  task_closed: TASK_FIELDS,
  request_created: [
    { key: "richiesta.codice", label: "Codice della richiesta", type: "text" },
    { key: "richiesta.titolo", label: "Titolo della richiesta", type: "text" },
    { key: "richiesta.descrizione", label: "Descrizione", type: "text" },
    { key: "richiesta.progetto", label: "Progetto", type: "text" },
    { key: "richiesta.richiedente", label: "Richiedente", type: "person" },
  ],
  milestone_reached: [
    { key: "traguardo.nome", label: "Traguardo", type: "text" },
    { key: "traguardo.progetto", label: "Progetto", type: "text" },
  ],
  mail_received: [
    { key: "email.mittente", label: "Mittente", type: "email" },
    { key: "email.oggetto", label: "Oggetto", type: "text" },
    { key: "email.testo", label: "Testo", type: "text" },
  ],
};

/** Gli inizi `schedule` e `manual`: solo la data dell'avvio. */
export const START_FIELDS: DataField[] = [
  { key: "avvio.data", label: "Data dell'avvio", type: "date" },
];

/**
 * Cosa scrive un `wait` con `replyTo` (R-J2), a ogni attesa, così una
 * verifica successiva non rilegge mai una risposta vecchia: con la risposta
 * `risposta.arrivata = true` e il suo testo; scaduto `maxDays`
 * `risposta.arrivata = false` e `risposta.testo = ""`. `risposta.arrivata` è
 * un booleano (R-J6): nelle condizioni si confronta con `is`/`is_not` e
 * `true`/`false`.
 */
export const WAIT_REPLY_FIELDS: DataField[] = [
  { key: "risposta.arrivata", label: "Risposta arrivata", type: "boolean" },
  { key: "risposta.testo", label: "Testo della risposta", type: "text" },
];
