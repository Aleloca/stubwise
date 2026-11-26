import type { TicketStatus } from "../schemas/ticket.js";

/**
 * Perché una task è ferma (integrazione area 2). UNA regola, in un posto: la
 * usa il server (`GET /api/tasks/stalled`) e il seed finto del prototipo
 * (`apps/desktop/src/renderer/domain/stalled.ts` è un adattatore sottile).
 * Precedenza e soglie identiche al prototipo: manuale, decisione aperta,
 * domanda di Claude, bloccante aperta, senza assegnatario, inattività. Una
 * task chiusa non è mai ferma.
 */

export const STATUS_FAMILIES = ["todo", "active", "closed"] as const;
export type StatusFamily = (typeof STATUS_FAMILIES)[number];

/** La famiglia di un valore dell'enum `tickets.status` (stessa tabella di `stubwise_legacy_family`). */
export function legacyFamilyOf(status: TicketStatus): StatusFamily {
  switch (status) {
    case "open":
    case "triaged":
      return "todo";
    case "in_progress":
    case "in_review":
      return "active";
    case "done":
    case "closed":
      return "closed";
  }
}

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
  /** Giorni interi da `since` a `today`. */
  days: number;
}

export interface StallTaskInput {
  id: string;
  assigneeId: string | null;
  manualStall: { reason: string; note: string; since: string } | null;
  links: { kind: string; taskId: string }[];
  lastActivityAt: string;
  /** Settimana ISO «AAAA-Wnn»; null finché la fetta 2 non porta la pianificazione. */
  plannedWeek: string | null;
  /** Quante volte è slittata; 0 finché la fetta 2 non porta la pianificazione. */
  slipCount: number;
}

export interface StallInputContext {
  family: StatusFamily;
  /** Le richieste di decisione APERTE di questa task. */
  openDecisions: { askedOfId: string; createdAt: string }[];
  /** Da quando Claude aspetta una risposta su questa task; null se non aspetta. */
  claudeQuestionSince: string | null;
  /** Le task che bloccano questa (righe «blocks» verso di lei), con la loro famiglia. */
  blockers: { id: string; family: StatusFamily; since: string }[];
  thresholds: { activeDays: number; todoDays: number };
}

const DAY_MS = 86_400_000;

function daysBetween(since: string, today: string): number {
  const from = Date.parse(`${since.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  return Math.round((to - from) / DAY_MS);
}

/** Settimana ISO «AAAA-Wnn» di una data ISO. */
export function isoWeekOf(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // giovedì della settimana
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** `today`: data ISO (YYYY-MM-DD) del giorno da cui si contano i giorni. */
export function stallOf(task: StallTaskInput, ctx: StallInputContext, today: string): Stall | null {
  if (ctx.family === "closed") return null;
  const stall = (reason: StallReason, since: string): Stall => ({
    reason,
    since,
    days: daysBetween(since, today),
  });

  if (task.manualStall) {
    const { reason, note, since } = task.manualStall;
    return stall({ kind: "manual", reason, note }, since);
  }

  const oldestOpen = [...ctx.openDecisions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (oldestOpen) return stall({ kind: "decision", personId: oldestOpen.askedOfId }, oldestOpen.createdAt);

  if (ctx.claudeQuestionSince !== null) return stall({ kind: "claude_question" }, ctx.claudeQuestionSince);

  const openBlocker = ctx.blockers.find((b) => b.family !== "closed");
  if (openBlocker) return stall({ kind: "blocked_by", taskId: openBlocker.id }, task.lastActivityAt);

  if (
    task.assigneeId === null &&
    (ctx.family === "active" || (task.plannedWeek !== null && task.plannedWeek <= isoWeekOf(today)))
  ) {
    return stall({ kind: "unassigned" }, task.lastActivityAt);
  }

  const idleDays = daysBetween(task.lastActivityAt, today);
  if (ctx.family === "active" && idleDays > ctx.thresholds.activeDays) {
    return stall({ kind: "idle" }, task.lastActivityAt);
  }
  if (ctx.family === "todo" && task.slipCount >= 1 && idleDays > ctx.thresholds.todoDays) {
    return stall({ kind: "idle" }, task.lastActivityAt);
  }
  return null;
}
