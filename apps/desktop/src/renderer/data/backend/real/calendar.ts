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
import type { CalendarEventView, CalendarSeriesView, CalendarSyncView } from "../../types";
import { onSaving, pendingSave, withPendingSaves } from "./calendarSave";
import { ACTION_TO_SERVER, bySeries, eventView, seriesIdOf, seriesView } from "./calendarView";
import { calendarWriteFunctions, rememberEtags } from "./calendarWrites";
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

// Le viste di evento e serie stanno in `calendarView.ts`; si riesportano da qui.
export { bySeries, eventView, seriesView };

/** Un calendario non allineato da più di 5 minuti è «vecchio», come nel prototipo. */
const CALENDAR_STALE_MS = 5 * 60_000;

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

const byStart = (a: CalendarEventView, b: CalendarEventView) =>
  a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id);

/** Gli eventi che toccano `[from, to)` (ms), già tagliati alla finestra; dalla più vecchia. */
async function eventsIn(from: number, to: number): Promise<CalendarEventView[]> {
  // La lista LEGGERA (F3b): i campi pesanti li rilegge il dettaglio (`event(id)`).
  const page = await appClient().calendar.range({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    fields: "summary",
  });
  return fresh(page.items)
    .map((e) => eventView(e as CalendarEventItem))
    .sort(byStart);
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

/** Le righe lette portano l'etag fresco per le scritture (F4, review). */
const fresh = <T extends { id: string; etag?: string | null }>(
  items: readonly T[],
): readonly T[] => {
  rememberEtags(items);
  return items;
};

const listEvents: Calendar["listEvents"] = async (range) => {
  const { from, to } = rangeOf(range.from, range.to);
  if (to <= from) return [];
  // Gli estremi nel formato della finestra (`…T00:00:00Z`), come li chiede la griglia.
  const page = await appClient().calendar.range({
    from: isoOfMs(from),
    to: isoOfMs(to),
    fields: "summary",
  });
  // Gli eventi in salvataggio o non salvati (F4) si vedono al loro posto nuovo.
  return withPendingSaves(fresh(page.items).map((e) => eventView(e as CalendarEventItem))).sort(
    byStart,
  );
};

/**
 * Le serie lette da poco, per client (review F3b, 6): aprire un evento
 * ricorrente non rilegge tutte le serie ogni volta (con la F3b ci sono
 * anche quelle personali). `listSeries` le rilegge sempre e riempie la
 * memoria; una configurazione la svuota.
 */
const SERIES_FRESH_MS = 30_000;
const seriesMemo = new WeakMap<object, { at: number; list: Promise<CalendarSeriesView[]> }>();

const listSeries: Calendar["listSeries"] = async () => {
  const client = appClient();
  const list = client.calendar
    .series()
    .then(({ items }) => items.map((s) => seriesView(s as CalendarSeriesItem)).sort(bySeries));
  seriesMemo.set(client, { at: Date.now(), list });
  list.catch(() => seriesMemo.delete(client));
  return list;
};

/** Le serie per il dettaglio di un evento: quelle lette da poco, se ci sono. */
function recentSeries(): Promise<CalendarSeriesView[]> {
  const hit = seriesMemo.get(appClient());
  return hit && Date.now() - hit.at < SERIES_FRESH_MS ? hit.list : listSeries();
}

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
    // Un id malformato (400 di validazione) è un evento che non c'è.
    if (error instanceof ApiError && (error.status === 404 || error.status === 400))
      throw new Error("not_found");
    throw error;
  }
  rememberEtags([item]);
  const e = pendingSave(item.id) ?? eventView(item);
  const w = calendarWindow();
  if (!(Date.parse(e.startsAt) < Date.parse(w.to) && Date.parse(e.endsAt) > Date.parse(w.from))) {
    throw new Error("not_found");
  }
  const series =
    e.seriesId === null ? null : ((await recentSeries()).find((s) => s.id === e.seriesId) ?? null);
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
  const today = startOfLocalDay(new Date(from));
  const to = addDays(today, 2).getTime();
  // Il server filtra per ISTANTI: un «tutto il giorno» di oggi finisce alla
  // mezzanotte UTC, che in un fuso negativo è già passata la sera. Si chiede
  // da ieri (giorno locale) e si taglia qui coi giorni di chi guarda.
  return (await eventsIn(addDays(today, -1).getTime(), to)).filter((e) => {
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
  seriesMemo.delete(appClient());
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
    if (error instanceof ApiError && error.code === "project_required")
      throw new Error("choose_project_first");
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
  // F4: le scritture (crea, modifica, sposta, elimina, rispondi, progetto a
  // mano, Riprova/Annulla, libero/occupato, «Trova un orario»).
  ...calendarWriteFunctions,
  onSaving,
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
