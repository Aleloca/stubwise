import { ApiError } from "@stubwise/api-client";
import { calendarEventItemSchema, type CalendarEventItem } from "@stubwise/shared";
import type * as Fake from "../../api";
import { firstFreeSlot } from "../../../domain/calendar/freeSlot";
import { addDays, startOfLocalDay } from "@stubwise/shared";
import type { CalendarEventView, FreeBusy } from "../../types";
import { eventView } from "./calendarView";
import { appClient } from "./client";
import { dropPending, pendingSave, retryPending, saveWith, type SaveError } from "./calendarSave";
import { myAccounts } from "./google";

// Scrivere sul Calendario nella build app (area 6, F4), coi metodi di
// `client.calendar` di 72 (createEvent, editEvent, moveEvent, respondEvent,
// deleteEvent, setEventProject: tutte tranne deleteEvent rispondono
// `{ items }`). Ogni scrittura parte da un gesto della persona, risponde DOPO
// il sì di Google (Q2 = a) e restituisce le righe toccate; un evento cambiato
// su Google nel frattempo è `changed_on_google` (l'etag), e non vince
// l'ultimo (Q4 = a: «Reload»). Il libero/occupato è `client.calendar.freeBusy`
// (task 5 di 72): intervalli già uniti e tagliati, al più 50 persone e 31 giorni.

type Calendar = typeof Fake.calendar;
type Raw = CalendarEventItem & { etag?: string | null };

/** Per client: l'etag dell'ultima riga letta o scritta di ogni evento. */
const etags = new WeakMap<object, Map<string, string | null>>();
function etagMap(): Map<string, string | null> {
  const client = appClient();
  let map = etags.get(client);
  if (!map) etags.set(client, (map = new Map()));
  return map;
}

/**
 * Ogni lettura delle righe (la griglia, il dettaglio) porta l'etag FRESCO:
 * Google lo cambia anche quando un invitato risponde, e il poller riscrive la
 * riga (review F4, critico). Senza, un etag vecchio darebbe
 * `changed_on_google` per tutta la sessione.
 */
export function rememberEtags(rows: readonly { id: string; etag?: string | null }[]): void {
  const map = etagMap();
  for (const r of rows) map.set(r.id, r.etag ?? null);
}

/** L'etag da cui parte una scrittura: quello ricordato, altrimenti la riga riletta. */
async function etagOf(id: string): Promise<string | null> {
  const known = etagMap().get(id);
  if (known !== undefined) return known;
  try {
    const raw = (await appClient().calendar.event(id)) as Raw;
    etagMap().set(id, raw.etag ?? null);
    return raw.etag ?? null;
  } catch (error) {
    throw writeError(error);
  }
}

/**
 * La risposta di una scrittura (`{ items }`, `calendarWriteResultSchema` di
 * 72): «solo questo» un elemento, «tutta la serie» le sue date nella
 * finestra, rilette da Google. Si ricordano gli etag di tutte; la vista è
 * quella dell'evento toccato o, se il suo id è cambiato (una serie
 * spostata), la prima. Le altre date le porta la rilettura di `range`.
 */
function viewOfResult(raw: unknown, id?: string, startsAt?: string): CalendarEventView {
  const items = ((raw as { items?: unknown[] } | null)?.items ?? []) as Raw[];
  for (const row of items) etagMap().set(row.id, row.etag ?? null);
  // Spostata la serie, gli id possono cambiare: torna la data con l'orario
  // chiesto (review F4), non la prima dell'elenco.
  const row =
    items.find((r) => r.id === id) ??
    (startsAt === undefined
      ? undefined
      : items.find((r) => Date.parse(r.startsAt) === Date.parse(startsAt))) ??
    items[0];
  if (!row) throw new Error("not_found");
  return eventView(calendarEventItemSchema.parse(row));
}

/** I rifiuti del server nelle parole del prototipo. */
const ERRORS: Readonly<Record<string, string>> = {
  outside_window: "invalid: window",
  invalid_range: "invalid: time",
  // Il libero/occupato: al più 50 persone e 31 giorni.
  range_too_wide: "invalid: range",
  all_day_series: "invalid: all_day_series",
  organizer: "invalid: organizer",
  not_invited: "invalid: not_invited",
  not_organizer: "forbidden",
  // Il progetto attuale dell'evento è uno che non vedo: non lo cambio (F4, 72).
  project_hidden: "forbidden",
  changed_on_google: "changed_on_google",
  google_scope_missing: "google_scope_missing",
  account_disabled: "google_not_connected",
  token_expired: "google_not_connected",
  google_unavailable: "google_unavailable",
  google_rejected: "google_rejected",
};
function writeError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.code && ERRORS[error.code]) return new Error(ERRORS[error.code]);
  if (error.status === 404) return new Error("not_found");
  if (error.status === 502) return new Error("google_unavailable");
  return error;
}

/**
 * Gli orari come li vuole il server (contratto di 72, review F4 punto 12):
 * «tutto il giorno» è una DATA `YYYY-MM-DD` con la fine esclusa, mai la
 * mezzanotte come istante (a est di Greenwich prenoterebbe il giorno prima).
 * Il renderer tiene un giorno intero a mezzanotte UTC, quindi è la data UTC.
 */
const wireTime = (at: string, allDay: boolean): string =>
  allDay ? new Date(at).toISOString().slice(0, 10) : at;

/** Un id di Google per una riunione nuova: base32hex (`[a-v0-9]`), l'esadecimale di un uuid lo è. */
export const newEventId = (): string => crypto.randomUUID().replace(/-/g, "");

/**
 * Nuova riunione, dalla prima casella collegata (il prototipo ha un account
 * per persona). Come le altre scritture (review F4, 4) passa dal salvataggio:
 * la griglia la vede SUBITO con «Saving…» e l'editor si chiude; un 502 la
 * lascia «non salvata» con «Retry», che rimanda la STESSA richiesta, quindi
 * lo stesso `eventId` (se Google l'aveva creata, il server non ne fa due).
 * Finché non è salvata il suo id è quello della bozza.
 */
const createEvent: Calendar["createEvent"] = async (input) => {
  const account = (await myAccounts()).find((a) => a.disabledAt === null);
  if (!account) throw new Error("google_not_connected");
  const eventId = input.draftId ?? newEventId();
  const allDay = input.allDay === true;
  const body = {
    // Uno per bozza (l'editor), lo stesso a ogni tentativo; un esadecimale è già base32hex.
    eventId,
    accountId: account.id,
    title: input.title,
    startsAt: wireTime(input.startsAt, allDay),
    endsAt: wireTime(input.endsAt, allDay),
    allDay,
    guests: input.guests ?? [],
    addMeet: input.addMeet === true,
    description: input.description ?? null,
    location: input.location ?? null,
    projectId: input.projectId ?? null,
    reminders: input.reminders ?? "default",
  } as Parameters<ReturnType<typeof appClient>["calendar"]["createEvent"]>[0];
  const draft: CalendarEventView = {
    ...eventView({
      id: eventId,
      accountId: account.id,
      accountEmail: account.email,
      recurringEventId: null,
      projectId: input.projectId ?? null,
      projectName: null,
      title: input.title,
      organizer: account.email,
      attendees: [],
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay,
      descriptionText: input.description ?? null,
      location: input.location ?? null,
      hangoutLink: null,
      remindersUseDefault: true,
      canEdit: true,
      canRespond: false,
    } as unknown as CalendarEventItem),
    projectBy: input.projectId ? "manual" : null,
    attendeeCount: (input.guests?.length ?? 0) + 1,
  };
  const run = async () => {
    try {
      return viewOfResult(await appClient().calendar.createEvent(body));
    } catch (error) {
      throw saveErrorOf(error) === null ? writeError(error) : error;
    }
  };
  return saveWith(draft, run, saveErrorOf, true);
};

/**
 * Un errore di GOOGLE (non del gesto): il salvataggio resta «non riuscito»
 * con «Retry» e «Undo». Gli altri (fuori finestra, non organizzatore,
 * scope, …) si lanciano subito: il gesto non doveva partire.
 */
function saveErrorOf(error: unknown): SaveError | null {
  if (error instanceof TypeError) return "unreachable";
  if (!(error instanceof ApiError)) return null;
  if (error.code === "changed_on_google") return "changed";
  if (error.code === "google_rejected") return "rejected";
  if (error.code === "google_unavailable" || error.status === 502) return "unreachable";
  return null;
}

/** L'evento come lo vede la pagina adesso: quello in salvataggio, o la riga del server. */
async function currentView(id: string): Promise<CalendarEventView> {
  const pending = pendingSave(id);
  if (pending) return pending;
  try {
    const raw = (await appClient().calendar.event(id)) as Raw;
    // L'etag è quello che la persona ha VISTO (la griglia, il dettaglio): una
    // rilettura qui al momento della scrittura sovrascriverebbe in silenzio una
    // modifica fatta su Google che non ha visto. Solo se non ce n'è uno.
    if (!etagMap().has(id)) etagMap().set(id, raw.etag ?? null);
    return eventView(calendarEventItemSchema.parse(raw));
  } catch (error) {
    throw writeError(error);
  }
}

/** Una scrittura che cambia la riga: subito al posto nuovo, poi Google. */
async function saving(
  id: string,
  patch: (e: CalendarEventView) => Partial<CalendarEventView>,
  request: (etag: string | null, before: CalendarEventView) => Promise<unknown>,
): Promise<CalendarEventView> {
  const before = await currentView(id);
  const patched = { ...before, ...patch(before) };
  const etag = await etagOf(id);
  const run = async () => {
    try {
      return viewOfResult(await request(etagMap().get(id) ?? etag, before), id, patched.startsAt);
    } catch (error) {
      throw saveErrorOf(error) === null ? writeError(error) : error;
    }
  };
  return saveWith(patched, run, saveErrorOf);
}

const updateEvent: Calendar["updateEvent"] = async (id, patch, scope = "one") =>
  saving(
    id,
    () => ({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.location !== undefined ? { location: patch.location } : {}),
      ...(patch.reminders !== undefined ? { reminders: patch.reminders } : {}),
    }),
    (etag) =>
      appClient().calendar.editEvent(id, { scope, etag, patch } as Parameters<
        ReturnType<typeof appClient>["calendar"]["editEvent"]
      >[1]),
  );

const moveEvent: Calendar["moveEvent"] = async (id, startsAt, endsAt, scope = "one", allDay) =>
  saving(
    id,
    (e) => ({ startsAt, endsAt, allDay: allDay ?? e.allDay }),
    (etag, before) =>
      appClient().calendar.moveEvent(id, {
        scope,
        etag,
        // Senza `allDay` decide la riga (il server fa lo stesso).
        startsAt: wireTime(startsAt, allDay ?? before.allDay),
        endsAt: wireTime(endsAt, allDay ?? before.allDay),
        ...(allDay === undefined ? {} : { allDay }),
      }),
  );

/** «Retry» un salvataggio non riuscito: la stessa richiesta. */
const retrySave: Calendar["retrySave"] = async (id) => retryPending(id, saveErrorOf);

/** «Undo the change»: torna la riga del server (dove niente è cambiato). */
const revertEvent: Calendar["revertEvent"] = async (id) => {
  dropPending(id);
  // «Reload» (e «Undo»): l'etag ricordato può essere quello vecchio; la prossima scrittura rilegge.
  etagMap().delete(id);
};

/** Eliminare (solo l'organizzatore): le proposte aperte nate da lui se ne vanno con lui (Q5 = a). */
const deleteEvent: Calendar["deleteEvent"] = async (id, scope = "one") => {
  const etag = await etagOf(id);
  try {
    await appClient().calendar.deleteEvent(id, { scope, ...(etag ? { etag } : {}) });
    etagMap().delete(id);
  } catch (error) {
    throw writeError(error);
  }
};

const respond: Calendar["respond"] = async (id, rsvp, note, scope = "one") => {
  // «Non risposto» non è una risposta che si manda (il prototipo la rifiuta allo stesso modo).
  if (rsvp === "needsAction") throw new Error("invalid: response");
  const response = rsvp;
  return saving(
    id,
    () => ({ myResponse: rsvp }),
    () =>
      appClient().calendar.respondEvent(id, {
        scope,
        response,
        ...(note !== undefined ? { note } : {}),
      }),
  );
};

/** Il progetto a mano: vale per tutti quelli che vedono lo stesso evento (Q1 = a). */
const setEventProject: Calendar["setEventProject"] = async (id, projectId) =>
  saving(
    id,
    () => ({ projectId, projectBy: projectId === null ? null : "manual" }),
    () => appClient().calendar.setEventProject(id, projectId),
  );

/**
 * Libero/occupato (D8 = b, con la fonte di Q3 = a: le righe salvate dal
 * server): solo gli intervalli, dei colleghi col calendario collegato.
 */
const freeBusy: Calendar["freeBusy"] = async (personIds, from, to) => {
  try {
    const { items } = await appClient().calendar.freeBusy({ personIds: [...personIds], from, to });
    // Solo gli intervalli, qualunque cosa arrivi: nessun altro campo passa.
    return items.map(
      (r): FreeBusy => ({
        personId: r.personId,
        availability: r.availability as FreeBusy["availability"],
        busy: r.busy.map((b) => ({ startsAt: b.startsAt, endsAt: b.endsAt })),
      }),
    );
  } catch (error) {
    throw writeError(error);
  }
};

/** «Trova un orario»: calcolato qui dal libero/occupato della giornata, con la regola del prototipo. */
const findFirstFreeSlot: Calendar["findFirstFreeSlot"] = async (personIds, durationMin, from) => {
  if (!Number.isInteger(durationMin) || durationMin <= 0) throw new Error("invalid: duration");
  const start = new Date(from);
  if (Number.isNaN(start.getTime())) throw new Error("invalid: range");
  const dayStart = startOfLocalDay(start);
  const rows = await freeBusy(
    personIds,
    dayStart.toISOString(),
    addDays(dayStart, 1).toISOString(),
  );
  return firstFreeSlot(
    rows.flatMap((r) => r.busy),
    durationMin,
    start,
  );
};

export const calendarWriteFunctions: Partial<Calendar> = {
  createEvent,
  updateEvent,
  moveEvent,
  deleteEvent,
  respond,
  setEventProject,
  retrySave,
  revertEvent,
  freeBusy,
  findFirstFreeSlot,
};
