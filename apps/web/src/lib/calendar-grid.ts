import type { CalendarEventItem } from "@stubwise/shared";

/**
 * Funzioni PURE della griglia del calendario (fase 9, Task 6). Separate dal
 * componente perché sono il punto più facile da sbagliare della fase — i
 * fusi orari — e l'unico testabile senza montare React.
 *
 * ⚠️ **La scelta sui fusi, dichiarata** (il piano lo chiede esplicitamente):
 * gli eventi CON ORARIO si leggono nel fuso LOCALE del browser (un
 * appuntamento delle 9 deve apparire alle 9 di chi guarda, non in UTC) — i
 * `Date` nativi di JS usano già il fuso locale con i getter non-UTC.
 * Gli eventi "TUTTO IL GIORNO" sono diversi: il worker li fissa a
 * MEZZANOTTE UTC (`apps/worker/src/google/calendar.ts`, commento su
 * `isoDay`) perché sono una DATA, non un istante — leggerli con i getter
 * locali farebbe scivolare l'evento sul giorno PRIMA per chiunque abbia un
 * fuso negativo (mezzanotte UTC del 12 è le 20 dell'11 a New York). Per
 * quelli si usano i getter UTC, che recuperano la data ORIGINALE
 * indipendentemente da dove sta guardando chi la legge.
 */

export type CalendarView = "day" | "week" | "month";

/** Chiave di un giorno di calendario (`YYYY-MM-DD`), locale o UTC a seconda di chi la chiama. */
export type DayKey = string;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Chiave del giorno LOCALE di una data (per le celle della griglia, sempre locali). */
export function localDayKey(date: Date): DayKey {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Chiave del giorno "vero" di un evento — vedi il docblock del modulo:
 * UTC per un evento tutto il giorno, locale per un evento con orario.
 */
export function eventDayKey(event: Pick<CalendarEventItem, "startsAt" | "allDay">): DayKey {
  const at = new Date(event.startsAt);
  return event.allDay
    ? `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
    : localDayKey(at);
}

/** Mezzanotte locale del giorno di `date` (azzera ore/minuti/secondi/ms). */
export function startOfLocalDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Lunedì della settimana di `date` (settimana lavorativa, non domenicale). */
export function startOfWeek(date: Date): Date {
  const start = startOfLocalDay(date);
  const weekday = start.getDay(); // 0 = domenica
  const diffFromMonday = weekday === 0 ? 6 : weekday - 1;
  return addDays(start, -diffFromMonday);
}

/** Primo giorno del mese di `date`, a mezzanotte locale. */
export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * L'intervallo `[from, to)` da CHIEDERE al server per una vista — con il
 * padding ai bordi delle settimane per il mese, così la griglia (che mostra
 * settimane intere) non ha buchi ai margini.
 */
export function rangeForView(view: CalendarView, anchor: Date): { from: Date; to: Date } {
  if (view === "day") {
    const from = startOfLocalDay(anchor);
    return { from, to: addDays(from, 1) };
  }
  if (view === "week") {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 7) };
  }
  // "month": dal lunedì della settimana del giorno 1, alla domenica della
  // settimana dell'ultimo giorno del mese (+1 giorno, per un `to` esclusivo).
  const monthStart = startOfMonth(anchor);
  const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const from = startOfWeek(monthStart);
  const to = addDays(startOfWeek(monthEnd), 7);
  return { from, to };
}

/** Sposta `anchor` di un passo nella direzione data, secondo la vista corrente. */
export function stepAnchor(view: CalendarView, anchor: Date, direction: 1 | -1): Date {
  if (view === "day") return addDays(anchor, direction);
  if (view === "week") return addDays(anchor, 7 * direction);
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

/** I 7 giorni (mezzanotte locale) della settimana di `anchor`, lunedì-domenica. */
export function weekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Le celle (mezzanotte locale) della griglia mese, settimane intere incluse. */
export function monthGridDays(anchor: Date): Date[] {
  const { from, to } = rangeForView("month", anchor);
  const days: Date[] = [];
  for (let d = new Date(from); d < to; d = addDays(d, 1)) days.push(d);
  return days;
}

export interface PositionedEvent {
  event: CalendarEventItem;
  /** Percentuale dall'alto della colonna del giorno (0-100). */
  topPct: number;
  /** Percentuale di altezza della colonna del giorno (0-100), minimo garantito per restare leggibile. */
  heightPct: number;
}

const MINUTES_PER_DAY = 24 * 60;
/** Altezza minima di un evento nella griglia oraria: leggibile anche se dura pochi minuti. */
const MIN_HEIGHT_PCT = (15 / MINUTES_PER_DAY) * 100;

/**
 * Gli eventi CON ORARIO che toccano il giorno locale `day`, con la
 * posizione verticale ricavata dai minuti dall'inizio giornata — CLIPPATI
 * al giorno: un evento a cavallo di mezzanotte compare in ENTRAMBI i giorni
 * che tocca, troncato ai confini di ciascuno (non un'unica barra continua
 * fra due colonne).
 */
export function timedEventsForDay(events: CalendarEventItem[], day: Date): PositionedEvent[] {
  const dayStart = startOfLocalDay(day);
  const dayEnd = addDays(dayStart, 1);
  const result: PositionedEvent[] = [];
  for (const event of events) {
    if (event.allDay) continue;
    const start = new Date(event.startsAt);
    const end = event.endsAt ? new Date(event.endsAt) : new Date(start.getTime() + 30 * 60 * 1000);
    if (end <= dayStart || start >= dayEnd) continue; // nessuna sovrapposizione con questo giorno
    const clippedStart = start < dayStart ? dayStart : start;
    const clippedEnd = end > dayEnd ? dayEnd : end;
    const startMinutes = (clippedStart.getTime() - dayStart.getTime()) / 60_000;
    const endMinutes = (clippedEnd.getTime() - dayStart.getTime()) / 60_000;
    const topPct = (startMinutes / MINUTES_PER_DAY) * 100;
    const heightPct = Math.max(((endMinutes - startMinutes) / MINUTES_PER_DAY) * 100, MIN_HEIGHT_PCT);
    result.push({ event, topPct, heightPct });
  }
  return result.sort((a, b) => a.topPct - b.topPct);
}

/** Gli eventi "tutto il giorno" del giorno locale `day` (chiave UTC, vedi il docblock del modulo). */
export function allDayEventsForDay(events: CalendarEventItem[], day: Date): CalendarEventItem[] {
  const key = localDayKey(day);
  return events.filter((event) => event.allDay && eventDayKey(event) === key);
}

/** Tutti gli eventi (con e senza orario) del giorno locale `day`, per la vista mese. */
export function eventsForDay(events: CalendarEventItem[], day: Date): CalendarEventItem[] {
  const key = localDayKey(day);
  return events.filter((event) => {
    if (event.allDay) return eventDayKey(event) === key;
    const start = new Date(event.startsAt);
    const end = event.endsAt ? new Date(event.endsAt) : start;
    const dayStart = startOfLocalDay(day);
    const dayEnd = addDays(dayStart, 1);
    return start < dayEnd && end >= dayStart;
  });
}
