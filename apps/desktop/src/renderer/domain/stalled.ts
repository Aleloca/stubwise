import { TODAY } from "../data/seed/dates";
import type { DecisionRequest, Project, StatusFamily, Task } from "../data/model";
import { blockerIdsOf } from "./links";
import { compareWeeks, currentWeek } from "./weeks";

export type StallReason =
  | { kind: "manual"; reason: string; note: string }
  | { kind: "decision"; personId: string }
  | { kind: "claude_question" }
  | { kind: "blocked_by"; taskId: string }
  | { kind: "unassigned" }
  | { kind: "idle" };

export interface Stall {
  reason: StallReason;
  /** Quando è iniziata la causa (ISO, data o data-ora). */
  since: string;
  /** Giorni interi da `since` a `TODAY`. */
  days: number;
}

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

function daysSince(since: string): number {
  const from = Date.parse(`${since.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${TODAY}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Perché una task è ferma, in ordine di precedenza: segnalazione manuale,
 * decisione pendente, domanda di Claude, bloccante aperta, senza assegnatario,
 * inattività. Una task chiusa non è mai ferma.
 */
export function stallOf(task: Task, ctx: StallContext): Stall | null {
  if (ctx.family === "closed") return null;
  const stall = (reason: StallReason, since: string): Stall => ({
    reason,
    since,
    days: daysSince(since),
  });

  if (task.manualStall) {
    const { reason, note, since } = task.manualStall;
    return stall({ kind: "manual", reason, note }, since);
  }

  const oldestOpen = ctx.openDecisions
    .filter((d) => d.taskId === task.id && d.answer === null && d.withdrawnAt === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (oldestOpen) {
    return stall({ kind: "decision", personId: oldestOpen.askedOfId }, oldestOpen.createdAt);
  }

  if (task.claude === "awaiting_answer") {
    return stall({ kind: "claude_question" }, task.lastActivityAt);
  }

  // Le bloccanti sono le task che tengono una riga «blocks» verso questa (`domain/links.ts`).
  for (const blockerId of blockerIdsOf(task.id, ctx.tasksById.values())) {
    const blocker = ctx.tasksById.get(blockerId)!;
    if (ctx.familyOf(blocker) !== "closed") {
      return stall({ kind: "blocked_by", taskId: blockerId }, task.lastActivityAt);
    }
  }

  if (
    task.assigneeId === null &&
    (ctx.family === "active" ||
      (task.plannedWeek !== null && compareWeeks(task.plannedWeek, currentWeek()) <= 0))
  ) {
    return stall({ kind: "unassigned" }, task.lastActivityAt);
  }

  const idleDays = daysSince(task.lastActivityAt);
  if (ctx.family === "active" && idleDays > ctx.thresholds.activeDays) {
    return stall({ kind: "idle" }, task.lastActivityAt);
  }
  if (ctx.family === "todo" && task.slipCount >= 1 && idleDays > ctx.thresholds.todoDays) {
    return stall({ kind: "idle" }, task.lastActivityAt);
  }
  return null;
}
