import { isoWeekDays } from "@stubwise/shared";
import { TODAY, isoWeek } from "@backend/clock";

// Le funzioni pure della settimana ISO stanno in `@stubwise/shared`
// (integrazione area 2, fetta 2): una regola, un posto, la usa anche il
// server. Qui restano quelle che leggono «oggi» o la lingua.
export { addWeeks, compareWeeks, isoWeekDays as weekDays } from "@stubwise/shared";

export function currentWeek(): string {
  return isoWeek(TODAY);
}

/** «27 ott – 31 ott» (lunedì – venerdì), nella lingua richiesta. */
export function weekLabel(week: string, locale: string): string {
  const days = isoWeekDays(week);
  const fmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const label = (d: string) => fmt.format(new Date(`${d}T00:00:00Z`));
  return `${label(days[0]!)} – ${label(days[4]!)}`;
}

/** Il numero di una settimana stabile («2026-W46» → 46); `null` se non lo è. */
export function weekNumberOf(week: unknown): number | null {
  return typeof week === "string" && /-W\d+$/.test(week)
    ? Number(week.slice(week.lastIndexOf("W") + 1))
    : null;
}

/**
 * La settimana corta nella lingua di `t`: «W46» in inglese, «S46» in
 * italiano. Una convenzione sola in tutta l'app (M2 della revisione finale
 * dell'area 10a, bloccante 3 di Impeccable): pagine, schede e risposte di
 * Claude, righe eseguite, notifiche e attività passano da qui.
 */
export function shortWeekIn(
  t: (key: string, options?: Record<string, unknown>) => string,
  week: string,
): string {
  const n = weekNumberOf(week);
  return n === null ? week : t("week.short", { n });
}
