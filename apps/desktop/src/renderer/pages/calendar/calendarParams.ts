import {
  addDays,
  localDayKey,
  rangeForView,
  stepAnchor,
  type CalendarView,
  type DayKey,
} from "@stubwise/shared";

// I parametri del Calendario nell'indirizzo (shape calendar.md §7):
// `#/calendar?view=day|week|month&date=YYYY-MM-DD&event=<id>&series=<id>`, e
// i bordi della finestra letta (§5, [A 3]). Fonte unica della forma: la usano
// il router e `data/routes.ts`. `view` e `date` sono già chiavi dell'app
// (Home, All projects): qui se ne dice il valore valido sul Calendario.

export const CALENDAR_VIEWS = ["day", "week", "month"] as const satisfies readonly CalendarView[];

/** La vista di default (senza `?view=`). */
export const DEFAULT_VIEW: CalendarView = "week";

/** Le chiavi proprie del Calendario (`view` e `date` sono già dell'app). */
export const CALENDAR_SEARCH_KEYS = ["event", "series"] as const;

export interface CalendarSearch {
  view?: string;
  date?: string;
  event?: string;
  series?: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Un giorno vero (`2026-02-30` no). */
function isDay(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Un parametro del Calendario ha una forma valida (il router scarta il resto). */
export function isCalendarSearchValue(key: string, value: string): boolean {
  switch (key) {
    case "view":
      return (CALENDAR_VIEWS as readonly string[]).includes(value);
    case "date":
      return isDay(value);
    case "event":
    case "series":
      return /^[\w-]+$/.test(value) && value.length <= 120;
    default:
      return false;
  }
}

/** I giorni (date, `YYYY-MM-DD`) della finestra letta, compresi. */
export interface WindowDays {
  first: DayKey;
  last: DayKey;
}

/**
 * La finestra a giorni: i bordi sono mezzanotti UTC (`calendarWindow()`),
 * quindi le date si leggono in UTC — in un fuso negativo la finestra resta
 * «23 settembre – 22 dicembre», come lo shape la promette.
 */
export function windowDays(w: { from: string; to: string }): WindowDays {
  return {
    first: w.from.slice(0, 10),
    last: new Date(Date.parse(w.to) - 1).toISOString().slice(0, 10),
  };
}

/** La mezzanotte LOCALE di un giorno `YYYY-MM-DD` (le celle della griglia sono locali). */
export function parseDayKey(key: DayKey): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Un giorno fuori finestra torna al giorno di bordo più vicino. */
export function clampDay(key: DayKey, w: WindowDays): DayKey {
  if (key < w.first) return w.first;
  if (key > w.last) return w.last;
  return key;
}

/** Il giorno non è letto da Google (fuori finestra). */
export const outsideWindow = (day: Date, w: WindowDays): boolean => {
  const key = localDayKey(day);
  return key < w.first || key > w.last;
};

/**
 * Il primo e l'ultimo giorno che la vista DICE (non quelli che chiede ai
 * dati): per il mese, i giorni del mese — le settimane di riempimento ai
 * margini appartengono ai mesi accanto.
 */
export function viewSpan(view: CalendarView, anchor: Date): { first: Date; last: Date } {
  if (view === "month") {
    return {
      first: new Date(anchor.getFullYear(), anchor.getMonth(), 1),
      last: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0),
    };
  }
  const { from, to } = rangeForView(view, anchor);
  return { first: from, last: addDays(to, -1) };
}

/**
 * ‹ (‑1) o › (+1) si può: l'intervallo accanto tocca la finestra. È spento
 * solo quando cadrebbe TUTTO fuori ([A 3]).
 */
export function canStep(view: CalendarView, anchor: Date, dir: 1 | -1, w: WindowDays): boolean {
  const span = viewSpan(view, stepAnchor(view, anchor, dir));
  return dir === -1 ? localDayKey(span.last) >= w.first : localDayKey(span.first) <= w.last;
}

/** La vista tocca il bordo: alcuni dei suoi giorni sono fuori finestra. */
export function touchesEdge(
  view: CalendarView,
  anchor: Date,
  w: WindowDays,
): "start" | "end" | null {
  const span = viewSpan(view, anchor);
  if (localDayKey(span.first) < w.first) return "start";
  if (localDayKey(span.last) > w.last) return "end";
  return null;
}

/** Vista e giorno dalla ricerca: default Week di oggi, la data dentro la finestra. */
export function resolveCalendar(
  search: CalendarSearch,
  today: DayKey,
  w: WindowDays,
): { view: CalendarView; date: DayKey; anchor: Date } {
  const view =
    search.view && (CALENDAR_VIEWS as readonly string[]).includes(search.view)
      ? (search.view as CalendarView)
      : DEFAULT_VIEW;
  const date = clampDay(search.date && isDay(search.date) ? search.date : today, w);
  return { view, date, anchor: parseDayKey(date) };
}

/** La ricerca per una vista e un giorno: i valori di default non si scrivono. */
export function calendarSearch(
  next: { view: CalendarView; date: DayKey },
  today: DayKey,
): { view: string | undefined; date: string | undefined } {
  return {
    view: next.view === DEFAULT_VIEW ? undefined : next.view,
    date: next.date === today ? undefined : next.date,
  };
}
