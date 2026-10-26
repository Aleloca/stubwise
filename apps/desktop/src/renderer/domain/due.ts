import { TODAY } from "../data/dates";
import type { Milestone, StatusFamily } from "../data/model";

// Scadenze e traguardi letti allo stesso modo da ogni superficie: le righe di
// task e l'Overview li mostrano, la scheda di preparazione del Calendario li
// conta. Stavano nei componenti (`TaskRow`, `ProgressSection`): sono qui
// perché il livello dati li riusi senza importare da `pages/`.

/** In ritardo («Overdue»): aperta e con la scadenza prima di oggi. */
export const isOverdue = (dueDate: string | null, family: StatusFamily | undefined): boolean =>
  !!dueDate && dueDate < TODAY && family !== "closed";

/** I traguardi aperti dal più vicino; quelli senza data in fondo, per nome. */
export function openMilestones(list: Milestone[]): Milestone[] {
  return list
    .filter((m) => !m.closed)
    .sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate || b.dueDate) return a.dueDate ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
