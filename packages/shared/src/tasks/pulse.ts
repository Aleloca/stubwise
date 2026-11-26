import type { StatusFamily } from "./stall.js";

/**
 * Il polso di un progetto nell'app nuova (integrazione area 2, fetta 4): la
 * formula del prototipo (`pulseOf` in `apps/desktop/src/renderer/data/store.ts`),
 * pura, sui dati che il renderer ha già letto — task con famiglia e ferma
 * (`stallOf`), traguardi, decisioni rivolte a chi guarda, richieste da
 * trasformare. `/api/projects/pulse` resta per il web vecchio e il mobile,
 * invariato: risponde a un'altra domanda.
 */
export interface PulseInput<M extends { dueDate: string | null; closed: boolean }> {
  projectId: string;
  tasks: readonly { family: StatusFamily; stalled: boolean }[];
  milestones: readonly M[];
  /** Le richieste di decisione aperte rivolte a chi guarda, nel progetto. */
  decisionsForMe: number;
  /** Le richieste nuove del progetto che chi guarda può trasformare in task. */
  requestsToConvert: number;
  /** Domande e piani di Claude che aspettano chi guarda (0 finché l'area 3 non è integrata). */
  claudeWaitingForMe: number;
  claudeWorking: boolean;
}

export interface Pulse<M> {
  projectId: string;
  /** Task aperte per famiglia. */
  open: { todo: number; active: number };
  stalled: number;
  /** Il progetto aspetta chi guarda: una decisione, una richiesta da trasformare, Claude. */
  waitingOnMe: boolean;
  claudeWorking: boolean;
  /** Il traguardo aperto con la data più vicina (anche se passata). */
  nextMilestone: M | null;
}

export function pulseOf<M extends { dueDate: string | null; closed: boolean }>(input: PulseInput<M>): Pulse<M> {
  const nextMilestone =
    input.milestones
      .filter((m) => !m.closed && m.dueDate)
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
      .at(0) ?? null;
  return {
    projectId: input.projectId,
    open: {
      todo: input.tasks.filter((t) => t.family === "todo").length,
      active: input.tasks.filter((t) => t.family === "active").length,
    },
    stalled: input.tasks.filter((t) => t.stalled).length,
    waitingOnMe: input.decisionsForMe > 0 || input.requestsToConvert > 0 || input.claudeWaitingForMe > 0,
    claudeWorking: input.claudeWorking,
    nextMilestone,
  };
}
