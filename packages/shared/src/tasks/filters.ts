import { isoWeekToMonday } from "./weeks.js";

/**
 * Le regole PURE dei filtri salvati (integrazione area 2, fetta 3), spostate
 * da `apps/desktop/src/renderer/domain/filters.ts`: un posto solo per il
 * finto (`matches`), il server (`taskFilterConditions`) e l'app. I criteri
 * come schema stanno in `schemas/task-filter.ts`.
 */

export type PeriodField = "created" | "closed" | "plannedWeek" | "due";
export type RelativePeriod = "last7" | "last30" | "thisWeek" | "nextWeek" | "thisMonth" | "lastMonth";
export type Period = { kind: "relative"; preset: RelativePeriod } | { kind: "absolute"; from: string; to: string };
export type FieldPeriod = { field: PeriodField } & Period;

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (date: string, days: number) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS));

function mondayOfDate(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return shift(date, -(dow - 1));
}

function monthRange(date: string, offset: number): { from: string; to: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return { from: iso(first), to: iso(last) };
}

/** Intervallo (estremi inclusi, date ISO) di un periodo, rispetto a `today`. */
export function periodRange(p: Period, today: string): { from: string; to: string } {
  if (p.kind === "absolute") return { from: p.from, to: p.to };
  switch (p.preset) {
    case "last7":
      return { from: shift(today, -6), to: today };
    case "last30":
      return { from: shift(today, -29), to: today };
    case "thisWeek": {
      const monday = mondayOfDate(today);
      return { from: monday, to: shift(monday, 6) };
    }
    case "nextWeek": {
      const monday = shift(mondayOfDate(today), 7);
      return { from: monday, to: shift(monday, 6) };
    }
    case "thisMonth":
      return monthRange(today, 0);
    case "lastMonth":
      return monthRange(today, -1);
  }
}

/** Le date di una task che un periodo guarda: `createdAt`/`closedAt` istanti ISO, `dueDate` data, `plannedWeek` `YYYY-Www`. */
export interface TaskPeriodDates {
  createdAt: string;
  closedAt: string | null;
  dueDate: string | null;
  plannedWeek: string | null;
}

/** Le date della task per un campo di periodo (una settimana pianificata è un intervallo, lunedì–domenica). */
function fieldRange(task: TaskPeriodDates, field: PeriodField): { from: string; to: string } | null {
  switch (field) {
    case "created":
      return { from: task.createdAt.slice(0, 10), to: task.createdAt.slice(0, 10) };
    case "closed":
      return task.closedAt ? { from: task.closedAt.slice(0, 10), to: task.closedAt.slice(0, 10) } : null;
    case "due":
      return task.dueDate ? { from: task.dueDate, to: task.dueDate } : null;
    case "plannedWeek": {
      if (!task.plannedWeek) return null;
      const monday = isoWeekToMonday(task.plannedWeek);
      return { from: monday, to: shift(monday, 6) };
    }
  }
}

/** La task cade nel periodo: il suo intervallo per quel campo si sovrappone a quello del periodo. */
export function taskInPeriod(task: TaskPeriodDates, period: FieldPeriod, today: string): boolean {
  const want = periodRange(period, today);
  const got = fieldRange(task, period.field);
  return got !== null && got.to >= want.from && got.from <= want.to;
}

/** Gli stati sono per progetto: filtrarli ha senso solo con un progetto scelto. */
export function canUseStatusIds(c: { projectIds?: string[] }): boolean {
  return c.projectIds?.length === 1;
}
