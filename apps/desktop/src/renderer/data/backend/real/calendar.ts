import { ApiError } from "@stubwise/api-client";
import {
  addDays,
  CALENDAR_LOOKBACK_DAYS,
  CALENDAR_WINDOW_DAYS,
  startOfLocalDay,
  type CalendarEventItem,
  type CalendarSeriesItem,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import { spanOf } from "../../calendar/span";
import type {
  CalendarAttendee,
  CalendarEventView,
  CalendarSeries,
  CalendarSeriesView,
  CalendarSyncView,
} from "../../types";
import { appClient, session } from "./client";
import { daysFromToday } from "./clock";
import { myAccounts, requestSync, syncable, syncStateOf, whenSynced } from "./google";
import { partialNamespace } from "./notIntegrated";

// Il Calendario nella build app (area 6, fetta 1): gli appuntamenti che il
// poller ha VISTO (`/api/me/calendar/range`, solo dentro la finestra letta) e
// le serie riconosciute (`/series`). Nessuna scrittura verso Google (F4: gli
// eventi, la risposta, il progetto a mano); la configurazione delle serie è
// di Stubwise e c'è. La scheda di preparazione è della F5 (`hasPrep` falso).

type Calendar = typeof Fake.calendar;

/** Un calendario non allineato da più di 5 minuti è «vecchio», come nel prototipo. */
const CALENDAR_STALE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/**
 * La finestra letta, a giorni interi UTC, come nel prototipo: dall'inizio
 * del giorno di 30 giorni fa alla fine di quello fra 60 (`to` esclusa). Il
 * poller legge `now − 30gg → now + 60gg`: i bordi a giorni interi sono quelli
 * che il Calendario mostra e promette.
 */
const calendarWindow: Calendar["calendarWindow"] = () => ({
  from: `${daysFromToday(-CALENDAR_LOOKBACK_DAYS)}T00:00:00Z`,
  to: `${daysFromToday(CALENDAR_WINDOW_DAYS + 1)}T00:00:00Z`,
});

/**
 * L'id di una serie nell'app: casella + id della serie su Google, uniti da
 * `_` (passa per l'indirizzo, `?series=`). L'id di Google da solo non basta:
 * la stessa serie su due caselle mie ha lo stesso.
 */
const seriesIdOf = (accountId: string, recurringEventId: string) => `${accountId}_${recurringEventId}`;

/** Le azioni di una serie: il vocabolario del prototipo e quello del server. */
const ACTION_OF_SERVER = {
  milestone: "milestone",
  backlog_item: "request",
  reminder: "remind",
} as const satisfies Record<CalendarSeriesItem["action"], CalendarSeries["action"]>;
const ACTION_TO_SERVER = {
  milestone: "milestone",
  request: "backlog_item",
  remind: "reminder",
} as const satisfies Record<CalendarSeries["action"], CalendarSeriesItem["action"]>;

const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * Un appuntamento visto, come lo legge chi guarda. Il server non sa i nomi né
 * le persone degli invitati: il nome è l'indirizzo, la persona sono io solo
 * sul mio indirizzo. Senza fine (righe vecchie): un «tutto il giorno» dura il
 * suo giorno, uno con orario resta un istante — nessuna durata inventata.
 */
function eventView(e: CalendarEventItem): CalendarEventView {
  const me = session.personId ?? "";
  const endsAt =
    e.endsAt ?? (e.allDay ? new Date(Date.parse(e.startsAt) + DAY_MS).toISOString() : e.startsAt);
  const isOrganizer = e.organizer === null || same(e.organizer, e.accountEmail);
  const attendees = e.attendees.map<CalendarAttendee>((a) => ({
    email: a.email,
    name: a.email,
    personId: same(a.email, e.accountEmail) ? me : null,
    response: a.responseStatus ?? "needsAction",
    organizer: same(e.organizer, a.email),
  }));
  return {
    id: e.id,
    calendarPersonIds: [me],
    title: e.title ?? "",
    description: e.descriptionText,
    startsAt: e.startsAt,
    endsAt,
    allDay: e.allDay,
    location: e.location,
    meetUrl: e.hangoutLink,
    attendees,
    reminders: e.remindersUseDefault
      ? "default"
      : e.reminders.map((r) => ({ minutes: r.minutes, method: r.method === "email" ? "email" : "popup" })),
    seriesId: e.recurringEventId === null ? null : seriesIdOf(e.accountId, e.recurringEventId),
    projectId: e.projectId,
    projectBy: e.projectId === null ? null : "model",
    googleUrl: e.eventUrl ?? e.url,
    myResponse: attendees.find((a) => a.personId === me && me !== "")?.response ?? null,
    isOrganizer,
    calendarEmail: e.accountEmail,
    hasPrep: false,
  };
}

function seriesView(s: CalendarSeriesItem): CalendarSeriesView {
  return {
    id: seriesIdOf(s.accountId, s.recurringEventId),
    title: s.title ?? "",
    // La regola sta sulle occorrenze, non sulla serie: senza, «a parole» non si dice.
    rule: "",
    projectId: s.projectId,
    enabled: s.enabled,
    action: ACTION_OF_SERVER[s.action],
    leadDays: s.leadDays,
    auto: s.auto,
    occurrencesInWindow: s.occurrenceCount,
    nextAt: s.nextOccurrenceAt,
  };
}

const byStart = (a: CalendarEventView, b: CalendarEventView) =>
  a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id);

/** Gli eventi che toccano `[from, to)` (ms), già tagliati alla finestra; dalla più vecchia. */
async function eventsIn(from: number, to: number): Promise<CalendarEventView[]> {
  const page = await appClient().calendar.range({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  });
  return page.items.map((e) => eventView(e as CalendarEventItem)).sort(byStart);
}

/** Un intervallo richiesto, in ms, tagliato alla finestra letta; non valido → `invalid: range`. */
function rangeOf(fromIso: string, toIso: string): { from: number; to: number } {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error("invalid: range");
  const w = calendarWindow();
  return { from: Math.max(from, Date.parse(w.from)), to: Math.min(to, Date.parse(w.to)) };
}

const isoOfMs = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

const listEvents: Calendar["listEvents"] = async (range) => {
  const { from, to } = rangeOf(range.from, range.to);
  if (to <= from) return [];
  // Gli estremi nel formato della finestra (`…T00:00:00Z`), come li chiede la griglia.
  const page = await appClient().calendar.range({ from: isoOfMs(from), to: isoOfMs(to) });
  return page.items.map((e) => eventView(e as CalendarEventItem)).sort(byStart);
};

const listSeries: Calendar["listSeries"] = async () => {
  const { items } = await appClient().calendar.series();
  return items
    .map((s) => seriesView(s as CalendarSeriesItem))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
};

/**
 * Un evento, con la sua serie (`GET /api/me/calendar/events/:id`, F1.4). Uno
 * altrui o inesistente è `not_found` (404); anche uno fuori dalla finestra
 * letta, come nel prototipo: qui Stubwise non lo legge.
 */
const getEvent: Calendar["getEvent"] = async (id) => {
  let item: CalendarEventItem;
  try {
    item = (await appClient().calendar.event(id)) as CalendarEventItem;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new Error("not_found");
    throw error;
  }
  const e = eventView(item);
  const w = calendarWindow();
  if (!(Date.parse(e.startsAt) < Date.parse(w.to) && Date.parse(e.endsAt) > Date.parse(w.from))) {
    throw new Error("not_found");
  }
  const series = e.seriesId === null ? null : ((await listSeries()).find((s) => s.id === e.seriesId) ?? null);
  return { ...e, series };
};

/** I miei calendari, uno per casella, con l'allineamento e se vanno ricollegati. */
const listCalendars: Calendar["listCalendars"] = async () => {
  const at = Date.now();
  return (await myAccounts()).map<CalendarSyncView>((a) => {
    const syncedAt = a.lastSyncAt ?? a.connectedAt;
    return {
      personId: session.personId ?? "",
      email: a.email,
      syncedAt,
      sync: syncStateOf(a),
      stale: at - Date.parse(syncedAt) > CALENDAR_STALE_MS,
      // Scaduta è la casella disattivata (token revocato): una a cui mancano solo
      // gli scope nuovi legge ancora, e il cassetto chiede di ricollegarla.
      expired: a.disabledAt !== null,
    };
  });
};

/**
 * «Prossimi appuntamenti» della Home, come nel prototipo: da adesso (anche
 * in corso) a fine di domani nei giorni di chi guarda, tranne quelli che ho
 * rifiutato.
 */
const listUpcomingEvents: Calendar["listUpcomingEvents"] = async () => {
  const from = Date.now();
  const to = addDays(startOfLocalDay(new Date(from)), 2).getTime();
  return (await eventsIn(from, to)).filter((e) => {
    const s = spanOf(e);
    return s.from < to && s.to > from && e.myResponse !== "declined";
  });
};

/**
 * Configura una serie: il server vuole la configurazione INTERA, quindi la
 * modifica si fonde con quella attuale. Accesa senza progetto è
 * `choose_project_first` (il server la rifiuterebbe: `project_required`).
 */
const configureSeries: Calendar["configureSeries"] = async (id, patch) => {
  const current = (await appClient().calendar.series()).items.find(
    (s) => seriesIdOf(s.accountId, s.recurringEventId) === id,
  ) as CalendarSeriesItem | undefined;
  if (!current) throw new Error("not_found");
  const next = { ...seriesView(current), ...patch };
  if (next.enabled && next.projectId === null) throw new Error("choose_project_first");
  try {
    await appClient().calendar.putSeries(current.recurringEventId, {
      accountId: current.accountId,
      enabled: next.enabled,
      projectId: next.projectId,
      action: ACTION_TO_SERVER[next.action],
      leadDays: next.leadDays,
      auto: next.auto,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "project_required") throw new Error("choose_project_first");
    throw error;
  }
  return { ...next, projectId: next.projectId };
};

/**
 * «Aggiorna ora» del Calendario: il giro di tutte le mie caselle che il
 * server allinea (il calendario si legge da ogni casella). Nessuna →
 * `google_not_connected`.
 */
const syncCalendar: Calendar["syncCalendar"] = async () => {
  const accounts = (await myAccounts()).filter(syncable);
  if (accounts.length === 0) throw new Error("google_not_connected");
  await Promise.all(accounts.map(requestSync));
};

export const calendarFunctions: Partial<Calendar> = {
  calendarWindow,
  spanOf,
  listEvents,
  getEvent,
  listSeries,
  listCalendars,
  listUpcomingEvents,
  configureSeries,
  syncCalendar,
  // Nessuna scrittura verso Google in questa fetta: si aspettano solo i giri chiesti.
  whenCalendarIdle: whenSynced,
};

export const calendar: Calendar = partialNamespace<Calendar>("calendar", calendarFunctions);
