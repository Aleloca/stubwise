import { TODAY, isoWeek } from "../data/seed/dates";

const DAY_MS = 86_400_000;

/** Lunedì (UTC) di una settimana ISO "2026-W43". */
function mondayOf(week: string): Date {
  const [y, w] = week.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(y, 0, 4)); // il 4 gennaio è sempre nella W01
  const dow = jan4.getUTCDay() || 7;
  return new Date(jan4.getTime() - (dow - 1) * DAY_MS + (w - 1) * 7 * DAY_MS);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function currentWeek(): string {
  return isoWeek(TODAY);
}

export function addWeeks(week: string, n: number): string {
  return isoWeek(iso(new Date(mondayOf(week).getTime() + n * 7 * DAY_MS)));
}

/** Il formato fisso "AAAA-Wnn" si ordina per anno e poi per numero. */
export function compareWeeks(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lunedì–venerdì della settimana, come date ISO. */
export function weekDays(week: string): string[] {
  const monday = mondayOf(week).getTime();
  return [0, 1, 2, 3, 4].map((i) => iso(new Date(monday + i * DAY_MS)));
}

/** «27 ott – 31 ott» (lunedì – venerdì), nella lingua richiesta. */
export function weekLabel(week: string, locale: string): string {
  const days = weekDays(week);
  const fmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const label = (d: string) => fmt.format(new Date(`${d}T00:00:00Z`));
  return `${label(days[0]!)} – ${label(days[4]!)}`;
}
