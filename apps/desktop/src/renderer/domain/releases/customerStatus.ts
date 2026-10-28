import type { ProjectRequest, Task } from "../../data/model";
import type { ReleaseStatusKind } from "./releaseStatus";

// Lo stato della richiesta in parole, come lo vede il CLIENTE (spec «Cosa
// vede il cliente»): ricevuta → in valutazione → pianificata → in
// lavorazione → rilasciata, oppure «non procediamo». Ricavato dallo stato
// della richiesta, delle task che ne nascono e dei rilasci delle loro PR;
// rilasciata = un rilascio riuscito o in produzione. Mai persone, stime o
// commenti: solo il passo.

export type CustomerStatus =
  | "received"
  | "evaluating"
  | "planned"
  | "in_progress"
  | "released"
  | "not_proceeding";

/**
 * `tasks` sono le task nate dalla richiesta, `releases` gli stati dei
 * rilasci delle loro PR. Una richiesta fusa in un'altra non è «non
 * procediamo»: il desiderio vive nella destinazione (chi chiama, se la
 * vede, passa quella).
 */
export function customerStatus(
  req: ProjectRequest | null,
  tasks: Task[],
  releases: ReleaseStatusKind[],
): CustomerStatus {
  // Il triage non ha ancora aperto la richiesta.
  if (!req) return "received";
  switch (req.status) {
    case "new":
      return "received";
    case "refining":
      return "evaluating";
    case "ready":
      return "planned";
    case "archived":
      return req.mergedIntoId ? "evaluating" : "not_proceeding";
    case "converted":
      break;
  }
  if (releases.some((k) => k === "succeeded" || k === "in_production")) return "released";
  // Un merge c'è, ma non è ancora arrivato (o è fallito): si lavora ancora.
  if (releases.length > 0) return "in_progress";
  // Task tutte chiuse senza un rilascio: non è arrivato niente al cliente.
  if (tasks.length > 0 && tasks.every((t) => t.closedAt !== null)) return "not_proceeding";
  if (tasks.some((t) => t.closedAt === null && t.claude !== "none")) return "in_progress";
  return "planned";
}
