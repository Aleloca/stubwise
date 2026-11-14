import type { ReleaseStatusKind } from "../releases/status.js";
import type { BacklogItemStatus } from "../schemas/backlog.js";

// Lo stato della richiesta in parole, come lo vede il CLIENTE (area 8, F3;
// era `domain/releases/customerStatus.ts` del prototipo): ricevuta → in
// valutazione → pianificata → in lavorazione → rilasciata, oppure «non
// procediamo». Ricavato dalla richiesta, dalle task che ne nascono e dai
// rilasci delle loro PR; rilasciata = un rilascio riuscito o in produzione.
// Mai persone, stime o commenti: solo il passo. Ingresso neutro (server e
// prototipo). Un esito che è un TICKET del widget (nessuna richiesta, F3-1)
// passa `request: null` e la sua task.

export type CustomerStatus = "received" | "evaluating" | "planned" | "in_progress" | "released" | "not_proceeding";

export const CUSTOMER_STATUSES: readonly CustomerStatus[] = [
  "received",
  "evaluating",
  "planned",
  "in_progress",
  "released",
  "not_proceeding",
];

export interface CustomerRequestInput {
  status: BacklogItemStatus;
  /** Fusa in un'altra: il desiderio vive nella destinazione (chi chiama, se la vede, passa quella). */
  merged: boolean;
}

export interface CustomerTaskInput {
  closed: boolean;
  /** Claude ci lavora o ci ha lavorato (un run partito). */
  claudeActive: boolean;
}

export function customerStatus(
  request: CustomerRequestInput | null,
  tasks: readonly CustomerTaskInput[],
  releases: readonly ReleaseStatusKind[],
): CustomerStatus {
  if (request) {
    switch (request.status) {
      case "new":
        return "received";
      case "refining":
        return "evaluating";
      case "ready":
        return "planned";
      case "archived":
        return request.merged ? "evaluating" : "not_proceeding";
      case "converted":
        break;
    }
  } else if (tasks.length === 0) {
    // Il triage non ha ancora aperto niente.
    return "received";
  }
  if (releases.some((k) => k === "succeeded" || k === "in_production")) return "released";
  // Un merge c'è, ma non è ancora arrivato (o è fallito, o non si sa): si
  // lavora ancora. Stubwise non fa deploy e non dice «rilasciata» per un fatto
  // che non ha visto.
  if (releases.length > 0) return "in_progress";
  if (tasks.length > 0 && tasks.every((t) => t.closed)) return "not_proceeding";
  if (tasks.some((t) => !t.closed && t.claudeActive)) return "in_progress";
  return "planned";
}
