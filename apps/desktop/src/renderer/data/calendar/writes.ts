import { EMAIL, lower, teamAddresses } from "../mail/compose";
import { CALENDAR_CASES } from "../seed/calendar";
import { copy, gate, newId, now, onStoreReset, state, storeGeneration } from "../store";
import type {
  CalendarAttendee,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventPatch,
  CalendarEventView,
  CalendarGuestInput,
  CalendarScope,
  CalendarSeries,
  CalendarSeriesPatch,
  CalendarSeriesView,
  Rsvp,
} from "../types";
import { deadlineProposal } from "./deadlines";
import { eventView, isoAt, readableEvent, seriesView } from "./reads";
import { calendarWindow, canSeeSeries, inWindow, isOrganizer } from "./visibility";

// Le scritture del Calendario (area 6). Come le altre: `gate()` prima di
// tutto (con la generazione dello stato: un ripristino durante l'attesa
// ferma la scrittura), ogni controllo prima di ogni scrittura (dopo un
// rifiuto lo stato è intatto). Un evento che chi agisce non legge è
// `not_found` (R-G5); uno che legge ma non organizza è `forbidden` per
// modifica, spostamento ed eliminazione — la risposta è di ogni invitato.
//
// Le scritture verso Google (crea, modifica, sposta, risposta) cambiano
// SUBITO lo store con `save.state: "saving"`; un passo simulato
// (`calendar.advanceSave`, via `gate()`: segue `setLatency`, `failNext` lo fa
// fallire) le porta a `saved` o `failed`. Un evento del seme
// (`CALENDAR_CASES.saveFails`) fallisce sempre al primo salvataggio. Da
// `failed`: «Riprova» (`retrySave`) o «Annulla la modifica» (`revertEvent`,
// torna alla versione di Google). Progetto dell'evento e configurazione
// delle serie sono di Stubwise, non di Google: si scrivono e basta.

const notFound = () => new Error("not_found");
const forbidden = () => new Error("forbidden");
const invalid = (what: string) => new Error(`invalid: ${what}`);

const RSVPS: ReadonlySet<Rsvp> = new Set(["accepted", "declined", "tentative"]);
const ACTIONS: ReadonlySet<CalendarSeries["action"]> = new Set(["milestone", "request", "remind"]);
const DAY_MS = 86_400_000;
const MAX_LEAD_DAYS = 14;

const pending = new Set<Promise<void>>();

function track(work: Promise<void>): void {
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/** Si risolve quando nessun salvataggio o allineamento simulato è più in corso. */
export async function whenCalendarIdle(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * La versione di Google di ogni evento con un salvataggio non confermato
 * (`null`: l'evento non c'era, è nato qui). La rimette «Annulla la modifica».
 */
const googleVersion = new Map<string, CalendarEvent | null>();
onStoreReset(() => googleVersion.clear());

async function writer(fnName: Parameters<typeof gate>[0]): Promise<string> {
  const gen = storeGeneration();
  const me = await gate(fnName);
  if (gen !== storeGeneration()) throw new Error("reset");
  return me;
}

const isMember = (me: string, projectId: string) =>
  !!state.projectsById.get(projectId)?.memberIds.includes(me);

/** Un evento che chi agisce legge e organizza. */
function organizedEvent(me: string, id: string): CalendarEvent {
  const e = readableEvent(me, id);
  if (!isOrganizer(me, e)) throw forbidden();
  return e;
}

/** L'evento («solo questo») o tutte le date della sua serie, anche fuori finestra. */
function targetsOf(e: CalendarEvent, scope: CalendarScope): CalendarEvent[] {
  if (scope === "one") return [e];
  if (scope !== "series" || e.seriesId === null) throw invalid("scope");
  return state.calendarEvents.filter((x) => x.seriesId === e.seriesId);
}

// --- salvataggio verso Google -------------------------------------------------

/** Un passo del salvataggio: `saving` → `saved` (o `failed`). */
async function advanceSave(ids: readonly string[]): Promise<void> {
  const generation = storeGeneration();
  const alive = () => storeGeneration() === generation;
  const saving = () =>
    state.calendarEvents.filter((e) => ids.includes(e.id) && e.save?.state === "saving");
  try {
    await gate("calendar.advanceSave");
    if (!alive()) return;
    for (const e of saving()) {
      if (e.id === CALENDAR_CASES.saveFails && !state.calendarFailedOnce.has(e.id)) {
        state.calendarFailedOnce.add(e.id);
        e.save = { state: "failed", error: "rejected" };
        continue;
      }
      e.save = { state: "saved" };
      googleVersion.delete(e.id);
    }
  } catch {
    if (!alive()) return;
    for (const e of saving()) e.save = { state: "failed", error: "unreachable" };
  }
}

/**
 * Applica `change` agli eventi e li manda a Google: subito `saving`, poi il
 * passo simulato. La versione di Google si tiene la prima volta (dopo un
 * fallimento la modifica successiva non la sovrascrive).
 */
function save(events: CalendarEvent[], change: (e: CalendarEvent) => void): void {
  for (const e of events) {
    if (!googleVersion.has(e.id)) googleVersion.set(e.id, copy(e));
    change(e);
    e.save = { state: "saving" };
  }
  track(advanceSave(events.map((e) => e.id)));
}

/** «Riprova» un salvataggio fallito. */
export async function retrySave(id: string): Promise<CalendarEventView> {
  const me = await writer("calendar.retrySave");
  const e = readableEvent(me, id);
  if (e.save?.state !== "failed") throw invalid("not failed");
  e.save = { state: "saving" };
  track(advanceSave([e.id]));
  return eventView(me, e);
}

/** «Annulla la modifica» dopo un salvataggio fallito: torna la versione di Google. */
export async function revertEvent(id: string): Promise<void> {
  const me = await writer("calendar.revertEvent");
  const e = readableEvent(me, id);
  if (e.save?.state !== "failed") throw invalid("not failed");
  const before = googleVersion.get(id);
  googleVersion.delete(id);
  const index = state.calendarEvents.indexOf(e);
  if (before === null || before === undefined) state.calendarEvents.splice(index, 1);
  else state.calendarEvents[index] = before;
}

// --- creare, modificare, spostare, eliminare ---------------------------------

/** Gli orari: validi, la fine dopo l'inizio, dentro la finestra; «tutto il giorno» a date intere. */
function checkTimes(startsAt: string, endsAt: string, allDay: boolean): void {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw invalid("time");
  if (allDay && (start % DAY_MS !== 0 || end % DAY_MS !== 0)) throw invalid("time");
  const w = calendarWindow();
  if (start < Date.parse(w.from) || end > Date.parse(w.to)) throw invalid("outside_window");
}

/** Gli invitati: persone del team (col loro indirizzo) o indirizzi; un indirizzo del team è la persona. */
function attendeesOf(guests: CalendarGuestInput[], keep: CalendarAttendee[]): CalendarAttendee[] {
  const team = teamAddresses();
  const out: CalendarAttendee[] = [];
  for (const g of guests) {
    let address;
    if ("personId" in g) {
      address = team.find((t) => t.personId === g.personId);
      if (!address) throw invalid("guest");
    } else {
      if (typeof g.email !== "string" || !EMAIL.test(g.email.trim())) throw invalid("guest");
      const email = lower(g.email);
      address = team.find((t) => lower(t.email) === email) ?? {
        email,
        name: g.name?.trim() || email,
        personId: null,
      };
    }
    const a: CalendarAttendee = { ...address, response: "needsAction", organizer: false };
    if (out.some((x) => lower(x.email) === lower(a.email))) continue;
    // Chi era già invitato tiene la sua risposta.
    out.push(keep.find((k) => lower(k.email) === lower(a.email)) ?? a);
  }
  return out;
}

/** I calendari che ricevono l'evento: l'organizzatore e gli invitati con l'account Google. */
const calendarsOf = (attendees: CalendarAttendee[]): string[] =>
  attendees.flatMap((a) =>
    a.personId !== null && state.googleAccounts.some((g) => g.personId === a.personId)
      ? [a.personId]
      : [],
  );

const meetUrl = () => `https://meet.google.com/${newId("stw")}`;

/** Io come organizzatore, con l'indirizzo del mio account Google. */
function hostOf(me: string): CalendarAttendee {
  const self = teamAddresses().find((t) => t.personId === me)!;
  return { ...self, personId: me, response: "accepted", organizer: true };
}

/**
 * Gli invitati con l'organizzatore in testa e i calendari che li ricevono;
 * senza invitati l'evento è solo nel mio calendario.
 */
function withGuests(
  me: string,
  host: CalendarAttendee | undefined,
  guests: CalendarAttendee[],
): Pick<CalendarEvent, "attendees" | "calendarPersonIds"> {
  if (guests.length === 0) return { attendees: [], calendarPersonIds: [me] };
  const attendees = [host ?? hostOf(me), ...guests];
  return { attendees, calendarPersonIds: calendarsOf(attendees) };
}

/**
 * «Nuova riunione» nel mio calendario: io organizzatore, gli invitati «senza
 * risposta», il link Meet se richiesto, il progetto solo fra i miei.
 */
export async function createEvent(input: CalendarEventInput): Promise<CalendarEventView> {
  const me = await writer("calendar.createEvent");
  const account = state.googleAccounts.find((a) => a.personId === me);
  if (account?.status !== "connected") throw new Error("google_not_connected");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw invalid("title");
  const allDay = input.allDay === true;
  checkTimes(input.startsAt, input.endsAt, allDay);
  const projectId = input.projectId ?? null;
  if (projectId !== null && !isMember(me, projectId)) throw notFound();
  const guests = attendeesOf(input.guests ?? [], []).filter((a) => a.personId !== me);
  const e: CalendarEvent = {
    id: newId("ev"),
    ...withGuests(me, undefined, guests),
    title,
    description: input.description?.trim() || null,
    startsAt: isoAt(Date.parse(input.startsAt)),
    endsAt: isoAt(Date.parse(input.endsAt)),
    allDay,
    location: input.location?.trim() || null,
    meetUrl: input.addMeet === true ? meetUrl() : null,
    reminders: input.reminders ?? "default",
    seriesId: null,
    projectId,
    projectBy: projectId !== null ? "manual" : null,
  };
  // Su Google non c'era: «Annulla la modifica» dopo un fallimento la toglie.
  googleVersion.set(e.id, null);
  state.calendarEvents.push(e);
  save([e], () => {});
  return eventView(me, e);
}

/** «Modifica» (dell'organizzatore): solo questo evento o tutta la serie. */
export async function updateEvent(
  id: string,
  patch: CalendarEventPatch,
  scope: CalendarScope = "one",
): Promise<CalendarEventView> {
  const me = await writer("calendar.updateEvent");
  const e = organizedEvent(me, id);
  const targets = targetsOf(e, scope);
  if (typeof patch !== "object" || patch === null) throw invalid("patch");
  let title: string | undefined;
  if (patch.title !== undefined) {
    title = typeof patch.title === "string" ? patch.title.trim() : "";
    if (!title) throw invalid("title");
  }
  // Ogni controllo prima di ogni scrittura: gli invitati si risolvono qui.
  const guestLists = new Map(
    targets.map((t) => [
      t.id,
      patch.guests === undefined
        ? null
        : attendeesOf(patch.guests, t.attendees).filter((a) => !a.organizer && a.personId !== me),
    ]),
  );
  save(targets, (t) => {
    if (title !== undefined) t.title = title;
    if (patch.description !== undefined) t.description = patch.description?.trim() || null;
    if (patch.location !== undefined) t.location = patch.location?.trim() || null;
    if (patch.reminders !== undefined) t.reminders = patch.reminders;
    if (patch.addMeet !== undefined) t.meetUrl = patch.addMeet ? (t.meetUrl ?? meetUrl()) : null;
    const guests = guestLists.get(t.id);
    if (guests)
      Object.assign(
        t,
        withGuests(
          me,
          t.attendees.find((a) => a.organizer),
          guests,
        ),
      );
  });
  return eventView(me, e);
}

/**
 * Sposta (o ridimensiona) un evento dell'organizzatore. Per «tutta la
 * serie» ogni data si sposta dello stesso scarto e prende la nuova durata.
 * Non oltre la finestra: lì si va su Google Calendar.
 */
export async function moveEvent(
  id: string,
  startsAt: string,
  endsAt: string,
  scope: CalendarScope = "one",
): Promise<CalendarEventView> {
  const me = await writer("calendar.moveEvent");
  const e = organizedEvent(me, id);
  const targets = targetsOf(e, scope);
  checkTimes(startsAt, endsAt, e.allDay);
  const delta = Date.parse(startsAt) - Date.parse(e.startsAt);
  const duration = Date.parse(endsAt) - Date.parse(startsAt);
  save(targets, (t) => {
    const start = Date.parse(t.startsAt) + delta;
    t.startsAt = isoAt(start);
    t.endsAt = isoAt(start + duration);
  });
  return eventView(me, e);
}

/** Elimina (dell'organizzatore) l'evento o tutta la serie, configurazione compresa. */
export async function deleteEvent(id: string, scope: CalendarScope = "one"): Promise<void> {
  const me = await writer("calendar.deleteEvent");
  const e = organizedEvent(me, id);
  const targets = new Set(targetsOf(e, scope));
  state.calendarEvents = state.calendarEvents.filter((x) => !targets.has(x));
  for (const t of targets) googleVersion.delete(t.id);
  if (scope === "series")
    state.calendarSeries = state.calendarSeries.filter((s) => s.id !== e.seriesId);
}

/**
 * La risposta a un invito (Sì, Forse, No) con nota facoltativa: di ogni
 * invitato tranne l'organizzatore; per una serie, anche su tutte le date a
 * cui sono invitato.
 */
export async function respond(
  id: string,
  rsvp: Rsvp,
  note?: string,
  scope: CalendarScope = "one",
): Promise<CalendarEventView> {
  const me = await writer("calendar.respond");
  const e = readableEvent(me, id);
  if (!RSVPS.has(rsvp)) throw invalid("rsvp");
  const mine = e.attendees.find((a) => a.personId === me);
  if (!mine) throw invalid("not_invited");
  if (mine.organizer) throw invalid("organizer");
  const targets = targetsOf(e, scope).filter((t) =>
    t.attendees.some((a) => a.personId === me && !a.organizer),
  );
  const text = typeof note === "string" ? note.trim() : "";
  save(targets, (t) => {
    const a = t.attendees.find((x) => x.personId === me)!;
    a.response = rsvp;
    if (text) a.note = text;
    else delete a.note;
  });
  return eventView(me, e);
}

// --- progetto e serie (di Stubwise, non di Google) -----------------------------

/**
 * Corregge a mano il progetto di un evento: vale per tutti quelli che lo
 * vedono (il progetto è dell'evento), lo fa chiunque lo veda purché sia
 * membro del progetto scelto; un progetto di cui non lo è risponde come
 * inesistente. Una proposta aperta dell'evento segue il progetto (senza
 * progetto, sparisce).
 */
export async function setEventProject(
  id: string,
  projectId: string | null,
): Promise<CalendarEventView> {
  const me = await writer("calendar.setEventProject");
  const e = readableEvent(me, id);
  if (projectId !== null && !isMember(me, projectId)) throw notFound();
  e.projectId = projectId;
  e.projectBy = projectId === null ? null : "manual";
  const open = state.mailProposals.find(
    (p) => p.source === "calendar" && p.sourceId === e.id && p.status === "open",
  );
  if (open && projectId === null) state.mailProposals.splice(state.mailProposals.indexOf(open), 1);
  else if (open && projectId !== null) {
    open.projectId = projectId;
    for (const a of open.actions) a.args = { ...a.args, projectId };
  }
  return eventView(me, e);
}

/**
 * La configurazione di una serie: progetto (fra i miei), proposte accese o
 * spente, azione, giorni di anticipo (0–14), «Agisci da solo». Accesa
 * senza progetto → `choose_project_first`.
 */
export async function configureSeries(
  id: string,
  patch: CalendarSeriesPatch,
): Promise<CalendarSeriesView> {
  const me = await writer("calendar.configureSeries");
  const s = state.calendarSeries.find((x) => x.id === id);
  if (!s || !canSeeSeries(me, s)) throw notFound();
  if (typeof patch !== "object" || patch === null) throw invalid("patch");
  const next = { ...s, ...patch };
  if (next.projectId !== null && next.projectId !== s.projectId && !isMember(me, next.projectId))
    throw notFound();
  if (!ACTIONS.has(next.action)) throw invalid("action");
  if (!Number.isInteger(next.leadDays) || next.leadDays < 0 || next.leadDays > MAX_LEAD_DAYS)
    throw invalid("leadDays");
  if (typeof next.enabled !== "boolean" || typeof next.auto !== "boolean") throw invalid("patch");
  if (next.enabled && next.projectId === null) throw new Error("choose_project_first");
  Object.assign(s, {
    projectId: next.projectId,
    enabled: next.enabled,
    action: next.action,
    leadDays: next.leadDays,
    auto: next.auto,
  });
  return seriesView(me, s);
}

// --- allineamento ----------------------------------------------------------------

/** Un passo dell'allineamento: il calendario torna `ok`, e nascono le proposte delle scadenze nuove. */
async function advanceSync(personId: string): Promise<void> {
  const generation = storeGeneration();
  const alive = () => storeGeneration() === generation;
  const row = () => state.calendarSync.find((c) => c.personId === personId)!;
  try {
    await gate("calendar.advanceSync");
    if (!alive()) return;
    Object.assign(row(), { sync: "ok", syncedAt: now() });
    for (const e of state.calendarEvents) {
      if (!e.calendarPersonIds.includes(personId) || !inWindow(e)) continue;
      const p = deadlineProposal(e, now());
      if (p && !state.mailProposals.some((x) => x.id === p.id)) state.mailProposals.push(p);
    }
  } catch {
    if (!alive()) return;
    row().sync = "failed";
  }
}

/** «Aggiorna ora» sul mio calendario. Con l'account scaduto non si allinea («Ricollega»). */
export async function syncCalendar(): Promise<void> {
  const me = await writer("calendar.syncCalendar");
  const row = state.calendarSync.find((c) => c.personId === me);
  if (!row) throw notFound();
  if (state.googleAccounts.find((a) => a.personId === me)?.status !== "connected")
    throw new Error("google_not_connected");
  if (row.sync === "syncing") return;
  row.sync = "syncing";
  track(advanceSync(me));
}
