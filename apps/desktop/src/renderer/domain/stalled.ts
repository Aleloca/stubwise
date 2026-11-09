import { TODAY } from "../data/seed/dates";
import { stallOf as sharedStallOf, type Stall } from "@stubwise/shared";
import type { DecisionRequest, Project, StallReason, StatusFamily, Task } from "../data/model";
import { blockerIdsOf } from "./links";

// Il tipo sta in `data/model.ts` (area 10b, P5): lo legge anche la risposta di Claude.
export type { StallReason };
// La regola sta in `@stubwise/shared` (integrazione area 2): la usa anche il
// server. Questo modulo costruisce l'ingresso dalla `Task` del prototipo.
export type { Stall };

export interface StallContext {
  /** Famiglia dello stato della task. */
  family: StatusFamily;
  /** Richieste di decisione: si considerano solo quelle aperte della task. */
  openDecisions: DecisionRequest[];
  /** Le task fra cui cercare chi blocca (le righe «blocks» stanno su di loro). */
  tasksById: Map<string, Task>;
  familyOf(task: Task): StatusFamily;
  thresholds: Project["stallThresholds"];
}

/**
 * Perché una task è ferma, in ordine di precedenza: segnalazione manuale,
 * decisione pendente, domanda di Claude, bloccante aperta, senza assegnatario,
 * inattività. Una task chiusa non è mai ferma. Regola: `stallOf` di
 * `@stubwise/shared`, con oggi = `TODAY` del prototipo.
 */
export function stallOf(task: Task, ctx: StallContext): Stall | null {
  const openDecisions = ctx.openDecisions
    .filter((d) => d.taskId === task.id && d.answer === null && d.withdrawnAt === null)
    .map((d) => ({ askedOfId: d.askedOfId, createdAt: d.createdAt }));
  // Le bloccanti sono le task che tengono una riga «blocks» verso questa (`domain/links.ts`).
  const blockers = [...blockerIdsOf(task.id, ctx.tasksById.values())].map((id) => {
    const blocker = ctx.tasksById.get(id)!;
    return { id, family: ctx.familyOf(blocker), since: blocker.lastActivityAt };
  });
  return sharedStallOf(
    {
      id: task.id,
      assigneeId: task.assigneeId,
      manualStall: task.manualStall,
      links: task.links,
      lastActivityAt: task.lastActivityAt,
      plannedWeek: task.plannedWeek,
      slipCount: task.slipCount,
    },
    {
      family: ctx.family,
      openDecisions,
      claudeQuestionSince: task.claude === "awaiting_answer" ? task.lastActivityAt : null,
      blockers,
      thresholds: ctx.thresholds,
    },
    TODAY,
  );
}
