import { addDays, startOfLocalDay } from "@stubwise/shared";
import { copy, gate, now, state, visibleProjectIds } from "../store";
import type {
  CalendarEvent,
  CalendarEventDetail,
  CalendarEventView,
  CalendarSeries,
  CalendarSeriesView,
  CalendarSyncView,
  FreeBusy,
} from "../types";
import {
  calendarWindow,
  canReadEvent,
  canSeeSeries,
  inWindow,
  isOrganizer,
  readableEvents,
} from "./visibility";

// Le letture del Calendario (area 6). Chi vede che cosa lo decide
// `visibility.ts`: solo gli eventi del mio calendario o a cui sono invitato,
// dentro la finestra letta. I fusi seguono `calendar-grid` di
// `@stubwise/shared`: un evento con orario è un intervallo di istanti (letto
// nel fuso locale), uno «tutto il giorno» è una DATA — copre i giorni locali
// con la stessa data, ovunque sia chi guarda.

/** Oltre questa distanza dall'ultimo allineamento un calendario è «vecchio». */
export const CALENDAR_STALE_MS = 5 * 60_000;

/** «Trova un orario» cerca fra queste ore (locali) della giornata. */
export const FREE_SLOT_HOURS = { from: 8, to: 20 } as const;

const STEP_MS = 15 * 60_000;

/** Un istante nel formato del seme (`…T09:15:00Z`, senza millisecondi). */
export const isoAt = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const notFound = () => new Error("not_found");
const invalid = (what: string) => new Error(`invalid: ${what}`);

/** La mezzanotte LOCALE della data UTC di un istante: il giorno di un «tutto il giorno». */
function localDateOf(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** L'intervallo (in ms) che l'evento occupa per chi guarda. */
export function spanOf(e: Pick<CalendarEvent, "startsAt" | "endsAt" | "allDay">): {
  from: number;
  to: number;
} {
  if (!e.allDay) return { from: Date.parse(e.startsAt), to: Date.parse(e.endsAt) };
  return { from: localDateOf(e.startsAt).getTime(), to: localDateOf(e.endsAt).getTime() };
}

const touches = (e: CalendarEvent, from: number, to: number) => {
  const s = spanOf(e);
  return s.from < to && s.to > from;
};

const byStart = (a: CalendarEvent, b: CalendarEvent) =>
  a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id);

/** L'evento come lo vede chi guarda: la sua risposta, il suo calendario, il progetto se lo vede. */
export function eventView(me: string, e: CalendarEvent): CalendarEventView {
  const view: CalendarEventView = {
    ...copy(e),
    myResponse: e.attendees.find((a) => a.personId === me)?.response ?? null,
    isOrganizer: isOrganizer(me, e),
    calendarEmail: e.calendarPersonIds.includes(me)
      ? (state.calendarSync.find((c) => c.personId === me)?.email ?? null)
      : null,
  };
  if (view.projectId !== null && !visibleProjectIds(me).has(view.projectId)) {
    view.projectId = null;
    view.projectBy = null;
  }
  return view;
}

/** Un evento che chi guarda legge, o `not_found`. */
export function readableEvent(me: string, id: string): CalendarEvent {
  const e = state.calendarEvents.find((x) => x.id === id);
  if (!e || !canReadEvent(me, e)) throw notFound();
  return e;
}

/** La serie come la vede chi guarda: le date nella finestra e la prossima da adesso. */
export function seriesView(me: string, s: CalendarSeries): CalendarSeriesView {
  const dates = state.calendarEvents
    .filter((e) => e.seriesId === s.id && inWindow(e))
    .sort(byStart);
  const next = dates.find((e) => Date.parse(e.endsAt) > Date.parse(now()));
  const view: CalendarSeriesView = {
    ...copy(s),
    occurrencesInWindow: dates.length,
    nextAt: next?.startsAt ?? null,
  };
  if (view.projectId !== null && !visibleProjectIds(me).has(view.projectId)) view.projectId = null;
  return view;
}

/** Un intervallo richiesto, in ms, tagliato alla finestra letta; non valido → `invalid: range`. */
function rangeOf(fromIso: string, toIso: string): { from: number; to: number } {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) throw invalid("range");
  const w = calendarWindow();
  return { from: Math.max(from, Date.parse(w.from)), to: Math.min(to, Date.parse(w.to)) };
}

/**
 * Gli eventi che chi guarda legge e che toccano `[from, to)`, tagliati alla
 * finestra: oltre, Stubwise non legge.
 */
export async function listEvents(range: {
  from: string;
  to: string;
}): Promise<CalendarEventView[]> {
  const me = await gate("calendar.listEvents");
  const { from, to } = rangeOf(range.from, range.to);
  return readableEvents(me)
    .filter((e) => touches(e, from, to))
    .sort(byStart)
    .map((e) => eventView(me, e));
}

/** Un evento, con la sua serie. Invisibile, inesistente o fuori finestra → `not_found`. */
export async function getEvent(id: string): Promise<CalendarEventDetail> {
  const me = await gate("calendar.getEvent");
  const e = readableEvent(me, id);
  const series = state.calendarSeries.find((s) => s.id === e.seriesId);
  return { ...eventView(me, e), series: series ? seriesView(me, series) : null };
}

/** Le serie che vedo, anche quelle senza date nella finestra, per titolo. */
export async function listSeries(): Promise<CalendarSeriesView[]> {
  const me = await gate("calendar.listSeries");
  return state.calendarSeries
    .filter((s) => canSeeSeries(me, s))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .map((s) => seriesView(me, s));
}

/** Il mio calendario, con quanto è aggiornato e se il collegamento è scaduto. */
export async function listCalendars(): Promise<CalendarSyncView[]> {
  const me = await gate("calendar.listCalendars");
  const at = Date.parse(now());
  return state.calendarSync
    .filter((c) => c.personId === me)
    .map((c) => ({
      ...copy(c),
      stale: at - Date.parse(c.syncedAt) > CALENDAR_STALE_MS,
      expired: state.googleAccounts.find((a) => a.personId === me)?.status === "expired",
    }));
}

/** Gli intervalli occupati di una persona in `[from, to)` (già tagliato alla finestra): mai i titoli. */
function busyOf(personId: string, from: number, to: number): FreeBusy["busy"] {
  return state.calendarEvents
    .filter(
      (e) =>
        !e.allDay &&
        e.calendarPersonIds.includes(personId) &&
        e.attendees.find((a) => a.personId === personId)?.response !== "declined" &&
        touches(e, from, to),
    )
    .sort(byStart)
    .map((e) => ({ startsAt: e.startsAt, endsAt: e.endsAt }));
}

function freeBusyOf(personId: string, from: number, to: number): FreeBusy {
  const account = state.googleAccounts.find((a) => a.personId === personId);
  if (!account) return { personId, availability: "not_connected", busy: [] };
  if (account.status === "expired") return { personId, availability: "expired", busy: [] };
  return { personId, availability: "connected", busy: busyOf(personId, from, to) };
}

/**
 * Libero/occupato delle persone del team in `[from, to)`, letto dai loro
 * calendari collegati: solo gli intervalli, mai titolo, luogo o invitati
 * (un evento rifiutato o «tutto il giorno» non occupa). Senza account →
 * `not_connected`, scaduto → `expired`. Come `listEvents`, solo dentro la
 * finestra letta.
 */
export async function freeBusy(personIds: string[], from: string, to: string): Promise<FreeBusy[]> {
  await gate("calendar.freeBusy");
  const range = rangeOf(from, to);
  return personIds.map((id) => freeBusyOf(id, range.from, range.to));
}

/**
 * «Trova un orario»: il primo spazio di `durationMin` minuti libero per
 * tutti (fra chi ha il calendario collegato) nella giornata locale di
 * `from`, a passi di 15′, non prima di `from`, fra le 8 e le 20. `null` se
 * non ce n'è.
 */
export async function findFirstFreeSlot(
  personIds: string[],
  durationMin: number,
  from: string,
): Promise<{ startsAt: string; endsAt: string } | null> {
  await gate("calendar.findFirstFreeSlot");
  if (!Number.isInteger(durationMin) || durationMin <= 0) throw invalid("duration");
  const start = new Date(from);
  if (Number.isNaN(start.getTime())) throw invalid("range");
  const dayStart = startOfLocalDay(start);
  const open = new Date(dayStart);
  open.setHours(FREE_SLOT_HOURS.from);
  const close = new Date(dayStart);
  close.setHours(FREE_SLOT_HOURS.to);
  const busy = personIds.flatMap(
    (id) => freeBusyOf(id, dayStart.getTime(), addDays(dayStart, 1).getTime()).busy,
  );
  const duration = durationMin * 60_000;
  let at = Math.ceil(Math.max(start.getTime(), open.getTime()) / STEP_MS) * STEP_MS;
  for (; at + duration <= close.getTime(); at += STEP_MS) {
    const end = at + duration;
    if (busy.every((b) => Date.parse(b.endsAt) <= at || Date.parse(b.startsAt) >= end)) {
      return { startsAt: isoAt(at), endsAt: isoAt(end) };
    }
  }
  return null;
}

/**
 * «Prossimi appuntamenti» della Home: gli eventi da adesso (anche in corso)
 * a fine di domani, nel fuso di chi guarda, tranne quelli che ho rifiutato.
 */
export async function listUpcomingEvents(): Promise<CalendarEventView[]> {
  const me = await gate("calendar.listUpcomingEvents");
  const from = Date.parse(now());
  const to = addDays(startOfLocalDay(new Date(from)), 2).getTime();
  return readableEvents(me)
    .filter(
      (e) =>
        touches(e, from, to) && e.attendees.find((a) => a.personId === me)?.response !== "declined",
    )
    .sort(byStart)
    .map((e) => eventView(me, e));
}
