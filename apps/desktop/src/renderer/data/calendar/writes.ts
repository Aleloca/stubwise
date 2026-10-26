import { applyActions } from "../api-mutations";
import { EMAIL, lower, teamAddresses } from "../mail/compose";
import { isProjectMember } from "../mail/visibility";
import { gate, newId, now, state, storeGeneration, visibleProjectIds } from "../store";
import { forbidden, invalid, notFound, writer } from "../writer";
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
  MailProposal,
  Rsvp,
} from "../types";
import { DAY_MS, deadlineProposal, seriesProposal } from "./proposals";
import { eventView, isoAt, readableEvent, seriesView } from "./reads";
import { forget, markCreated, retryGroup, revertGroup, save, track } from "./save";
import { calendarWindow, canSeeEvent, canSeeSeries, inWindow, isOrganizer } from "./visibility";

// Le scritture del Calendario (area 6). Come le altre: `gate()` prima di
// tutto (con la generazione dello stato: un ripristino durante l'attesa
// ferma la scrittura), ogni controllo prima di ogni scrittura (dopo un
// rifiuto lo stato è intatto). Un evento che chi agisce non legge è
// `not_found` (R-G5); uno che legge ma non organizza è `forbidden` per
// modifica, spostamento ed eliminazione — la risposta è di ogni invitato.
//
// Le scritture verso Google (crea, modifica, sposta, risposta) passano da
// `save.ts` («Salvataggio…» → salvato o fallito, «Riprova», «Annulla la
// modifica»). Progetto dell'evento e configurazione delle serie sono di
// Stubwise, non di Google: si scrivono e basta.


const RSVPS: ReadonlySet<Rsvp> = new Set(["accepted", "declined", "tentative"]);
const ACTIONS: ReadonlySet<CalendarSeries["action"]> = new Set(["milestone", "request", "remind"]);
const MAX_LEAD_DAYS = 14;

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

// --- salvataggio: «Riprova» e «Annulla la modifica» ---------------------------

/** «Riprova» un salvataggio fallito, con tutto il suo gruppo. */
export async function retrySave(id: string): Promise<CalendarEventView> {
  const me = await writer("calendar.retrySave");
  const e = readableEvent(me, id);
  retryGroup(e);
  return eventView(me, e);
}

/** «Annulla la modifica» dopo un salvataggio fallito: torna la versione di Google, per tutto il gruppo. */
export async function revertEvent(id: string): Promise<void> {
  const me = await writer("calendar.revertEvent");
  revertGroup(readableEvent(me, id));
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
  if (projectId !== null && !isProjectMember(me, projectId)) throw notFound();
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
  markCreated(e);
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
  allDay?: boolean,
): Promise<CalendarEventView> {
  const me = await writer("calendar.moveEvent");
  const e = organizedEvent(me, id);
  const targets = targetsOf(e, scope);
  // Diventare (o smettere di essere) «tutto il giorno» vale per una data sola:
  // per la serie lo scarto non ha senso fra un istante e una data.
  const nextAllDay = allDay ?? e.allDay;
  if (nextAllDay !== e.allDay && scope === "series") throw invalid("all_day_series");
  checkTimes(startsAt, endsAt, nextAllDay);
  const delta = Date.parse(startsAt) - Date.parse(e.startsAt);
  const duration = Date.parse(endsAt) - Date.parse(startsAt);
  save(targets, (t) => {
    const start = Date.parse(t.startsAt) + delta;
    t.startsAt = isoAt(start);
    t.endsAt = isoAt(start + duration);
    t.allDay = nextAllDay;
  });
  return eventView(me, e);
}

/** Le proposte ancora aperte nate da questi eventi. */
const openProposalsOf = (ids: ReadonlySet<string>): MailProposal[] =>
  state.mailProposals.filter(
    (p) => p.source === "calendar" && ids.has(p.sourceId) && p.status === "open",
  );

/**
 * Elimina (dell'organizzatore) l'evento o tutta la serie, configurazione
 * compresa; le proposte aperte nate da quelle date se ne vanno con loro.
 */
export async function deleteEvent(id: string, scope: CalendarScope = "one"): Promise<void> {
  const me = await writer("calendar.deleteEvent");
  const e = organizedEvent(me, id);
  const targets = new Set(targetsOf(e, scope));
  const ids = new Set([...targets].map((t) => t.id));
  const gone = new Set(openProposalsOf(ids));
  state.calendarEvents = state.calendarEvents.filter((x) => !targets.has(x));
  state.mailProposals = state.mailProposals.filter((p) => !gone.has(p));
  forget([...ids]);
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
 * vedono (il progetto è dell'evento). Lo fa chiunque veda l'evento, purché
 * sia membro del progetto scelto (altrimenti come inesistente) e veda
 * quello di adesso: un progetto che non vede non lo toglie né lo cambia
 * (`forbidden`). Una proposta aperta dell'evento segue il progetto (senza
 * progetto, sparisce).
 */
export async function setEventProject(
  id: string,
  projectId: string | null,
): Promise<CalendarEventView> {
  const me = await writer("calendar.setEventProject");
  const e = readableEvent(me, id);
  if (projectId !== null && !isProjectMember(me, projectId)) throw notFound();
  if (e.projectId !== null && !visibleProjectIds(me).has(e.projectId)) throw forbidden();
  e.projectId = projectId;
  e.projectBy = projectId === null ? null : "manual";
  for (const open of openProposalsOf(new Set([e.id]))) {
    if (projectId === null) state.mailProposals.splice(state.mailProposals.indexOf(open), 1);
    else {
      open.projectId = projectId;
      for (const a of open.actions) if ("projectId" in a.args) a.args = { ...a.args, projectId };
    }
  }
  return eventView(me, e);
}

/**
 * Una proposta di una serie con «Agisci da solo»: nasce già confermata, da
 * Stubwise (`decidedById: null`), eseguita a nome di chi ha il calendario
 * (`actor`) con i suoi permessi. Non avvia mai il lavoro di Claude: le
 * azioni di una serie non comprendono `startRun`. Se l'esecuzione fallisce
 * resta `failed`, col codice.
 */
function settleAutomatically(actor: string, p: MailProposal): void {
  const result = applyActions(actor, p.actions);
  p.decidedAt = now();
  if (result.ok) {
    p.status = "confirmed";
    p.resultCodes = result.codes;
  } else {
    p.status = "failed";
    p.error = result.code;
  }
}

/**
 * Le proposte nuove degli eventi che `actor` vede nella finestra: le
 * scadenze e le date delle serie accese entrate nei giorni di anticipo. Mai
 * per una data passata, quindi accendere una serie non crea nulla
 * all'indietro. Una per evento (o data): una già nata non si rifà.
 */
function proposeFromCalendar(actor: string): void {
  const at = now();
  for (const e of state.calendarEvents) {
    if (!canSeeEvent(actor, e) || !inWindow(e)) continue;
    const series = state.calendarSeries.find((s) => s.id === e.seriesId);
    const fromSeries = series ? seriesProposal(series, e, at) : null;
    for (const p of [deadlineProposal(e, at), fromSeries]) {
      if (!p || state.mailProposals.some((x) => x.id === p.id)) continue;
      if (p === fromSeries && series!.auto) settleAutomatically(actor, p);
      state.mailProposals.push(p);
    }
  }
}

/**
 * La configurazione di una serie: progetto (fra i miei), proposte accese o
 * spente, azione, giorni di anticipo (0–14), «Agisci da solo». Accesa
 * senza progetto → `choose_project_first`. Accesa, propone subito le date
 * già nei giorni di anticipo (mai quelle passate).
 */
export async function configureSeries(
  id: string,
  patch: CalendarSeriesPatch,
): Promise<CalendarSeriesView> {
  const me = await writer("calendar.configureSeries");
  const s = state.calendarSeries.find((x) => x.id === id);
  if (!s || !canSeeSeries(me, s)) throw notFound();
  // Come `setEventProject` (R-I12): la configurazione di un progetto che non
  // vedo — progetto, accesa/spenta, «Agisci da solo», «Rimuovi
  // configurazione» — non la tocco.
  if (s.projectId !== null && !visibleProjectIds(me).has(s.projectId)) throw forbidden();
  if (typeof patch !== "object" || patch === null) throw invalid("patch");
  const next = { ...s, ...patch };
  if (
    next.projectId !== null &&
    next.projectId !== s.projectId &&
    !isProjectMember(me, next.projectId)
  )
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
  if (s.enabled) proposeFromCalendar(me);
  return seriesView(me, s);
}

// --- allineamento ----------------------------------------------------------------

/** Un passo dell'allineamento: il calendario torna `ok`, e nascono le proposte nuove. */
async function advanceSync(personId: string): Promise<void> {
  const generation = storeGeneration();
  const alive = () => storeGeneration() === generation;
  const row = () => state.calendarSync.find((c) => c.personId === personId)!;
  try {
    await gate("calendar.advanceSync");
    if (!alive()) return;
    Object.assign(row(), { sync: "ok", syncedAt: now() });
    proposeFromCalendar(personId);
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
