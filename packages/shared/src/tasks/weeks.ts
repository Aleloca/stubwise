import { isoWeekOf } from "./stall.js";

/**
 * Le settimane ISO 8601 delle task (integrazione area 2, fetta 2), in UN
 * posto: sul filo e nel renderer la stringa `YYYY-Www` («2026-W46»), nel DB la
 * data del lunedì (`tickets.planned_week`). Pure, senza «oggi»: la settimana
 * corrente la calcola {@link currentIsoWeek} da un istante dato, nel fuso
 * {@link WEEK_TIME_ZONE} — lo stesso di `stubwise_current_monday()` nel DB.
 */

/** Il fuso della «settimana corrente»: quello del giro notturno. */
export const WEEK_TIME_ZONE = "Europe/Rome";

const DAY_MS = 86_400_000;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Il lunedì (data ISO) di una settimana `YYYY-Www`. Il 4 gennaio è sempre nella W01. */
export function isoWeekToMonday(week: string): string {
  const match = WEEK_RE.exec(week);
  if (!match) throw new Error(`settimana ISO non valida: ${week}`);
  const [, y, w] = match;
  const jan4 = new Date(Date.UTC(Number(y), 0, 4));
  const dow = jan4.getUTCDay() || 7;
  return isoDay(new Date(jan4.getTime() - (dow - 1) * DAY_MS + (Number(w) - 1) * 7 * DAY_MS));
}

/** La settimana `YYYY-Www` di una data ISO (non per forza un lunedì). */
export function mondayToIsoWeek(date: string): string {
  return isoWeekOf(date);
}

/** Una stringa `YYYY-Www` che esiste davvero (2027 non ha la W53). */
export function isIsoWeek(value: unknown): value is string {
  if (typeof value !== "string" || !WEEK_RE.test(value)) return false;
  const n = Number(value.slice(6));
  if (n < 1 || n > 53) return false;
  return mondayToIsoWeek(isoWeekToMonday(value)) === value;
}

export function addWeeks(week: string, n: number): string {
  const monday = Date.parse(`${isoWeekToMonday(week)}T00:00:00Z`);
  return mondayToIsoWeek(isoDay(new Date(monday + n * 7 * DAY_MS)));
}

/** Il formato fisso `YYYY-Www` si ordina per anno e poi per numero. */
export function compareWeeks(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Le settimane da `from` a `to` (negativo se `to` viene prima). */
export function weeksBetween(from: string, to: string): number {
  const a = Date.parse(`${isoWeekToMonday(from)}T00:00:00Z`);
  const b = Date.parse(`${isoWeekToMonday(to)}T00:00:00Z`);
  return Math.round((b - a) / (7 * DAY_MS));
}

/** Lunedì–venerdì della settimana, come date ISO. */
export function isoWeekDays(week: string): string[] {
  const monday = Date.parse(`${isoWeekToMonday(week)}T00:00:00Z`);
  return [0, 1, 2, 3, 4].map((i) => isoDay(new Date(monday + i * DAY_MS)));
}

/** La settimana corrente all'istante `now`, nel fuso {@link WEEK_TIME_ZONE}. */
export function currentIsoWeek(now: Date): string {
  // `en-CA` formatta come YYYY-MM-DD.
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: WEEK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return mondayToIsoWeek(local);
}

/**
 * Lo slittamento DERIVATO, la stessa regola di `stubwise_effective_week` e
 * `stubwise_slip_weeks` nel DB: una task scivola fino a un riferimento — la
 * settimana corrente se è aperta, quella in cui è stata chiusa se è chiusa —
 * e si legge nella più tarda fra la sua settimana e il riferimento;
 * `slipCount` aggiunge le settimane trascorse fino al riferimento a quelle già
 * consolidate. Chiusa nella sua settimana non è mai slittata; senza settimana
 * o nel futuro resta com'è. Una task riaperta riprende a scivolare dalla sua
 * settimana pianificata: il tempo in cui è stata chiusa conta.
 */
export function slipOf(
  task: { plannedWeek: string | null; slipCount: number; closedWeek: string | null },
  currentWeek: string,
): { plannedWeek: string | null; slipCount: number } {
  const reference = task.closedWeek ?? currentWeek;
  if (task.plannedWeek === null || compareWeeks(task.plannedWeek, reference) >= 0) {
    return { plannedWeek: task.plannedWeek, slipCount: task.slipCount };
  }
  return { plannedWeek: reference, slipCount: task.slipCount + weeksBetween(task.plannedWeek, reference) };
}
