import { eventDayKey, localDayKey, type CalendarView } from "@stubwise/shared";
import type { CalendarEvent } from "../../data/types";

// Date e ore del Calendario (shape calendar.md §5, §7, [A 10]): un evento con
// orario nel fuso LOCALE di chi guarda, uno «tutto il giorno» come DATA (in
// UTC, la doppia regola di `calendar-grid`). Il formato dell'ora segue la
// lingua dell'app, non il sistema: 24 ore in italiano, 12 in inglese.

/** 12 ore in inglese, 24 in italiano. */
export const uses12h = (language: string): boolean => !language.startsWith("it");

const fmt = (language: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(language, options);

/** L'ora di un istante, nel fuso locale: «9:30 AM» / «09:30». */
export function timeLabel(at: string | Date, language: string): string {
  return fmt(language, {
    hour: uses12h(language) ? "numeric" : "2-digit",
    minute: "2-digit",
    hour12: uses12h(language),
  }).format(typeof at === "string" ? new Date(at) : at);
}

/** L'etichetta di un'ora nel gutter: «9 AM» / «09». */
export function hourLabel(hour: number, language: string): string {
  const d = new Date(2026, 0, 1, hour);
  return uses12h(language)
    ? fmt(language, { hour: "numeric", hour12: true }).format(d)
    : String(hour).padStart(2, "0");
}

/** Il giorno nella testata di colonna: «Mon 19» / «lun 19». */
export function dayHeader(day: Date, language: string): { weekday: string; day: string } {
  return {
    weekday: fmt(language, { weekday: "short" }).format(day),
    day: String(day.getDate()),
  };
}

/** Il giorno della settimana per esteso o breve, per gli annunci e i nomi accessibili. */
export const weekdayShort = (day: Date, language: string) =>
  fmt(language, { weekday: "short" }).format(day);

/** L'intervallo della vista: «Oct 19 – 25, 2026», «Friday, Oct 23», «October 2026». */
export function rangeLabel(view: CalendarView, first: Date, last: Date, language: string): string {
  if (view === "day") {
    return fmt(language, { weekday: "long", month: "short", day: "numeric" }).format(first);
  }
  if (view === "month") return fmt(language, { month: "long", year: "numeric" }).format(first);
  return fmt(language, { month: "short", day: "numeric", year: "numeric" }).formatRange(
    first,
    last,
  );
}

/** Una data come «Sep 23» (la finestra, le scadenze). */
export function shortDate(dayKey: string, language: string): string {
  return fmt(language, { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${dayKey}T00:00:00Z`),
  );
}

/** Il fuso nell'angolo della griglia: «GMT+1». */
export function zoneLabel(at: Date): string {
  const part = new Intl.DateTimeFormat("en", { timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

/** L'ultimo giorno (compreso) di un «tutto il giorno»: `endsAt` è esclusa. */
export function lastAllDayKey(e: Pick<CalendarEvent, "endsAt">): string {
  return new Date(Date.parse(e.endsAt) - 1).toISOString().slice(0, 10);
}

/** «Fri, Oct 30» di una data `YYYY-MM-DD`. */
const dateWithWeekday = (dayKey: string, language: string) =>
  fmt(language, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${dayKey}T00:00:00Z`),
  );

/**
 * L'orario di un evento per intero, per il dettaglio e i nomi accessibili:
 * «10:00 – 11:00», «Thu 22:30 – Fri 01:00» a cavallo di due giorni; per un
 * «tutto il giorno» la data («Fri, Oct 30», «Oct 30 – Nov 1»).
 */
export function spanLabel(
  e: Pick<CalendarEvent, "startsAt" | "endsAt" | "allDay">,
  language: string,
): string {
  if (e.allDay) {
    const first = eventDayKey(e);
    const last = lastAllDayKey(e);
    if (first === last) return dateWithWeekday(first, language);
    return `${shortDate(first, language)} – ${shortDate(last, language)}`;
  }
  const start = new Date(e.startsAt);
  const end = new Date(e.endsAt);
  if (localDayKey(start) === localDayKey(end) || end.getTime() - start.getTime() <= 0) {
    return `${timeLabel(start, language)} – ${timeLabel(end, language)}`;
  }
  return `${weekdayShort(start, language)} ${timeLabel(start, language)} – ${weekdayShort(end, language)} ${timeLabel(end, language)}`;
}

/** Il giorno di un evento con orario, per il dettaglio: «Today», «Tomorrow» o «Fri, Oct 30». */
export function eventDayLabel(
  e: Pick<CalendarEvent, "startsAt" | "allDay">,
  today: string,
  language: string,
  words: { today: string; tomorrow: string; yesterday: string },
): string {
  const key = eventDayKey(e);
  const t = new Date(`${today}T00:00:00Z`).getTime();
  const k = new Date(`${key}T00:00:00Z`).getTime();
  if (k === t) return words.today;
  if (k - t === 86_400_000) return words.tomorrow;
  if (t - k === 86_400_000) return words.yesterday;
  return dateWithWeekday(key, language);
}

/**
 * La data di un'occorrenza per il dialogo della serie («Thursday, Oct 29»):
 * in UTC per un «tutto il giorno», che è una DATA.
 */
export function occurrenceLabel(
  e: Pick<CalendarEvent, "startsAt" | "allDay">,
  language: string,
): string {
  return new Intl.DateTimeFormat(language, {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(e.allDay ? { timeZone: "UTC" } : {}),
  }).format(new Date(e.startsAt));
}

/** «HH:MM» locale per un campo `<input type="time">`. */
export function timeInputValue(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
