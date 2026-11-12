import { calendarEvents, calendarSeries, googleAccounts, notifications, users, type Db } from "@stubwise/db";
import {
  deleteCalendarEvent,
  getCalendarEvent,
  GoogleApiError,
  insertCalendarEvent,
  listEventInstances,
  missingGoogleScopes,
  patchCalendarEvent,
  refreshAccessToken,
  respondToCalendarEvent,
  type CalendarEventPatch,
  type CalendarGuest,
  type GoogleCalendarEvent,
} from "@stubwise/google";
import { loadGoogleAccountCredentials } from "@stubwise/google/credentials";
import { projectPermissionsOfUser } from "@stubwise/notifications";
import {
  CALENDAR_CANCELLED_OUTCOME,
  CALENDAR_LOOKBACK_DAYS,
  CALENDAR_WINDOW_DAYS,
  computeCalendarFingerprint,
  type CalendarAttendee,
  type CalendarEventCreate,
  type CalendarEventEdit,
  type CalendarEventMove,
  type CalendarEventRespond,
  type CalendarGuestInput,
  type CalendarWriteScope,
} from "@stubwise/shared";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

/**
 * SCRIVERE SUL CALENDARIO (area 6, fetta 4). Le regole delle rotte
 * `/api/me/calendar/events…` (`routes/me-calendar.ts`), in UN posto.
 *
 * - **Un gesto della persona, sempre**: queste funzioni le chiama SOLO una
 *   rotta. Nessun poller, job o azione di Claude scrive sul calendario.
 * - **Solo le PROPRIE caselle**: l'id di chi chiede è nella WHERE; un evento
 *   altrui è `not_found`, anche per un admin (come le letture).
 * - **I controlli prima di Google**: chi non organizza non modifica, sposta o
 *   elimina (`not_organizer`); l'organizzatore non risponde (`organizer`), chi
 *   non è invitato nemmeno (`not_invited`); un etag diverso da quello della
 *   riga è `changed_on_google` — e in tutti questi casi Google non viene
 *   chiamato.
 * - **La riga dopo il sì di Google, nella stessa richiesta** (Q2): `range` la
 *   mostra subito, senza aspettare il poller, che poi la rinfresca. Se la
 *   scrittura nel DB fallisce dopo il sì, il poller converge al giro dopo.
 * - **«Tutta la serie»** scrive sul PADRE (letto da Google per la sua data e il
 *   suo etag) e riscrive le righe della serie dalle date che Google rende
 *   (`events.instances`, nella finestra): spostare una serie cambia gli id
 *   delle date, e una data che non c'è più si chiude come una cancellata.
 * - **Eliminare** chiude le righe come il poller chiude un evento cancellato
 *   (Q5: la proposta aperta se ne va con lui, la card si chiude) e, con la
 *   serie, toglie la sua configurazione (`calendar_series`).
 */

export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export interface CalendarWriteClient {
  refreshAccessToken: typeof refreshAccessToken;
  insertCalendarEvent: typeof insertCalendarEvent;
  patchCalendarEvent: typeof patchCalendarEvent;
  deleteCalendarEvent: typeof deleteCalendarEvent;
  respondToCalendarEvent: typeof respondToCalendarEvent;
  getCalendarEvent: typeof getCalendarEvent;
  listEventInstances: typeof listEventInstances;
}

export const realCalendarWriteClient: CalendarWriteClient = {
  refreshAccessToken,
  insertCalendarEvent,
  patchCalendarEvent,
  deleteCalendarEvent,
  respondToCalendarEvent,
  getCalendarEvent,
  listEventInstances,
};

export interface CalendarWriteDeps {
  db: Db;
  encryptionKey: Buffer;
  client: CalendarWriteClient;
  now?: () => Date;
}

export type CalendarWriteError =
  | { error: "not_found" }
  | { error: "invalid_range" }
  | { error: "outside_window" }
  | { error: "all_day_series" }
  | { error: "organizer" }
  | { error: "not_invited" }
  | { error: "not_organizer" }
  | { error: "changed_on_google" }
  | { error: "google_scope_missing"; missing: string[] }
  | { error: "account_disabled" }
  | { error: "token_expired" }
  | { error: "google_unavailable" }
  | { error: "google_rejected"; reason: string };

/** Le righe toccate (id di `calendar_events`), che la rotta rilegge nella forma di `range`. */
export type CalendarWriteOutcome = { ok: true; rowIds: string[] } | CalendarWriteError;

/**
 * Sono l'organizzatore? Lo dice Google (`organizer.self`) o, per una riga di
 * prima, l'organizzatore è la casella. UN posto: lo leggono anche le letture
 * (`canEdit` di `me-calendar.ts`).
 */
export function isOrganizerRow(row: { organizerSelf: boolean; organizer: string | null; accountEmail: string }): boolean {
  return row.organizerSelf || (row.organizer !== null && row.organizer.toLowerCase() === row.accountEmail.toLowerCase());
}

/** La mia riga fra gli invitati (`self`, o l'indirizzo della casella). */
export function myAttendee(attendees: readonly CalendarAttendee[], accountEmail: string): CalendarAttendee | undefined {
  const email = accountEmail.toLowerCase();
  return attendees.find((a) => a.self === true) ?? attendees.find((a) => a.email.toLowerCase() === email);
}

const DAY_MS = 24 * 3600_000;

function windowOf(now: Date): { timeMin: Date; timeMax: Date } {
  return { timeMin: new Date(now.getTime() - CALENDAR_LOOKBACK_DAYS * DAY_MS), timeMax: new Date(now.getTime() + CALENDAR_WINDOW_DAYS * DAY_MS) };
}

/** Le date nuove stanno nella finestra che il calendario legge (fuori, la riga non si vedrebbe mai). */
function checkTimes(now: Date, startsAt: Date, endsAt: Date): CalendarWriteError | null {
  if (endsAt.getTime() <= startsAt.getTime()) return { error: "invalid_range" };
  const { timeMin, timeMax } = windowOf(now);
  if (startsAt < timeMin || startsAt > timeMax || endsAt < timeMin || endsAt > timeMax) return { error: "outside_window" };
  return null;
}

type Account = { id: string; email: string; scopes: string[]; disabledAt: Date | null };

function accountProblem(account: Account): CalendarWriteError | null {
  if (account.disabledAt) return { error: "account_disabled" };
  if (!account.scopes.includes(CALENDAR_EVENTS_SCOPE)) return { error: "google_scope_missing", missing: missingGoogleScopes(account.scopes) };
  return null;
}

async function ownAccount(db: Db, userId: string, accountId: string): Promise<Account | null> {
  const [account] = await db
    .select({ id: googleAccounts.id, email: googleAccounts.email, scopes: googleAccounts.scopes, disabledAt: googleAccounts.disabledAt })
    .from(googleAccounts)
    .where(and(eq(googleAccounts.id, accountId), eq(googleAccounts.userId, userId)));
  return account ?? null;
}

type OwnRow = typeof calendarEvents.$inferSelect & { account: Account };

/** La riga, solo se è di una casella di chi chiede. */
async function ownRow(db: Db, userId: string, rowId: string): Promise<OwnRow | null> {
  const [row] = await db
    .select({
      event: calendarEvents,
      account: { id: googleAccounts.id, email: googleAccounts.email, scopes: googleAccounts.scopes, disabledAt: googleAccounts.disabledAt },
    })
    .from(calendarEvents)
    .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
    .where(and(eq(calendarEvents.id, rowId), eq(googleAccounts.userId, userId)));
  return row ? { ...row.event, account: row.account } : null;
}

async function accessTokenFor(deps: CalendarWriteDeps, accountId: string): Promise<string> {
  const credentials = await loadGoogleAccountCredentials(deps.db, deps.encryptionKey, accountId);
  if (!credentials) throw new GoogleApiError({ api: "credentials", status: 401, code: "invalid_grant", reason: "no_credentials" });
  const tokens = await deps.client.refreshAccessToken({ clientId: credentials.clientId, clientSecret: credentials.clientSecret, refreshToken: credentials.refreshToken });
  return tokens.accessToken;
}

/** Un errore di Google nelle parole che il client mappa. */
function googleError(err: unknown): CalendarWriteError {
  if (err instanceof GoogleApiError) {
    // Cambiato o sparito su Google nel frattempo: si rilegge e si rifà il gesto (Q4).
    if (err.code === "changed_on_google" || err.code === "event_gone" || err.status === 404 || err.status === 410) return { error: "changed_on_google" };
    if (err.code === "invalid_grant" || err.status === 401) return { error: "token_expired" };
    if (err.code === "insufficient_scope") return { error: "google_scope_missing", missing: [CALENDAR_EVENTS_SCOPE] };
    if (err.status === 400 || err.status === 403) return { error: "google_rejected", reason: err.reason.slice(0, 80) };
  }
  return { error: "google_unavailable" };
}

/** Gli invitati: le persone di Stubwise risolte nel loro indirizzo; una persona che non c'è è `not_found`. */
async function resolveGuests(db: Db, guests: readonly CalendarGuestInput[]): Promise<CalendarGuest[] | null> {
  const personIds = [...new Set(guests.flatMap((g) => ("personId" in g ? [g.personId] : [])))];
  const people = new Map<string, { email: string; name: string | null }>();
  if (personIds.length > 0) {
    // `users` non ha un nome: l'invito porta l'indirizzo, e il nome lo mette Google.
    for (const row of await db.select({ id: users.id, email: users.email }).from(users).where(and(inArray(users.id, personIds), eq(users.isAgent, false)))) people.set(row.id, { email: row.email, name: null });
  }
  const out: CalendarGuest[] = [];
  const seen = new Set<string>();
  for (const guest of guests) {
    const resolved = "personId" in guest ? people.get(guest.personId) : { email: guest.email, name: guest.name ?? null };
    if (!resolved) return null;
    const key = resolved.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ email: resolved.email, name: resolved.name });
  }
  return out;
}

const KNOWN_STATUSES = new Set(["confirmed", "tentative", "cancelled"]);

/** I dati di Google su una riga, come li scrive il poller (`fresh` in `apps/worker/src/google/poller.ts`). */
function freshValues(event: GoogleCalendarEvent) {
  const startsAt = event.startsAt!;
  return {
    title: event.title.trim(),
    startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    attendees: event.attendees,
    organizer: event.organizer,
    htmlLink: event.htmlLink,
    description: event.description,
    location: event.location,
    hangoutLink: event.hangoutLink,
    conferenceEntryPoints: event.conferenceEntryPoints,
    reminders: event.reminders,
    remindersUseDefault: event.remindersUseDefault,
    status: KNOWN_STATUSES.has(event.status) ? (event.status as "confirmed" | "tentative" | "cancelled") : null,
    fingerprint: computeCalendarFingerprint(event.title, startsAt),
    recurringEventId: event.recurringEventId,
    eventType: event.eventType,
    transparency: event.transparency,
    etag: event.etag,
    icalUid: event.iCalUID,
    visibility: event.visibility,
    organizerSelf: event.organizerSelf,
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Scrive (o aggiorna) la riga di un evento dopo il sì di Google. Una riga
 * nuova è solo VISTA (`proposal_candidate` false): una riunione che creo io
 * non è una proposta per me; il poller la rivaluta come ogni altra.
 */
async function upsertRow(tx: Tx, accountId: string, event: GoogleCalendarEvent, project?: { projectId: string | null }): Promise<string> {
  const fresh = freshValues(event);
  const [row] = await tx
    .insert(calendarEvents)
    .values({
      accountId,
      googleEventId: event.id,
      ...fresh,
      proposalCandidate: false,
      projectId: project?.projectId ?? null,
      projectBy: project?.projectId ? "manual" : null,
    })
    .onConflictDoUpdate({ target: [calendarEvents.accountId, calendarEvents.googleEventId], set: fresh })
    .returning({ id: calendarEvents.id });
  return row!.id;
}

/**
 * Le righe di eventi che non ci sono più, come il poller chiude un evento
 * cancellato: una riga solo vista se ne va, una candidata si chiude con la
 * sua card (la sua storia resta), nella STESSA transazione.
 */
async function closeRows(tx: Tx, accountId: string, googleEventIds: string[]): Promise<void> {
  if (googleEventIds.length === 0) return;
  await tx
    .delete(calendarEvents)
    .where(and(eq(calendarEvents.accountId, accountId), inArray(calendarEvents.googleEventId, googleEventIds), eq(calendarEvents.proposalCandidate, false)));
  const closed = await tx
    .update(calendarEvents)
    .set({ status: "cancelled", outcome: sql`coalesce(${calendarEvents.outcome}, ${JSON.stringify(CALENDAR_CANCELLED_OUTCOME)}::jsonb)` })
    .where(and(eq(calendarEvents.accountId, accountId), inArray(calendarEvents.googleEventId, googleEventIds)))
    .returning({ notificationId: calendarEvents.proposalNotificationId });
  const cards = closed.flatMap((r) => (r.notificationId ? [r.notificationId] : []));
  if (cards.length > 0) {
    await tx.update(notifications).set({ status: "handled", handledAt: new Date() }).where(and(inArray(notifications.id, cards), eq(notifications.status, "open")));
  }
}

/** Le date della serie che Google rende nella finestra (dopo una scrittura su «tutta la serie»). */
async function seriesInstances(deps: CalendarWriteDeps, accessToken: string, recurringEventId: string): Promise<GoogleCalendarEvent[]> {
  const { timeMin, timeMax } = windowOf(deps.now?.() ?? new Date());
  return (await deps.client.listEventInstances({ accessToken, eventId: recurringEventId, timeMin, timeMax })).filter(
    (e) => e.status !== "cancelled" && e.startsAt !== null && e.startsAt >= timeMin && e.startsAt <= timeMax,
  );
}

/** Riscrive le righe di una serie da quelle date: le nuove entrano, quelle che non ci sono più si chiudono. */
async function rewriteSeries(db: Db, accountId: string, recurringEventId: string, instances: GoogleCalendarEvent[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    const ids: string[] = [];
    for (const instance of instances) ids.push(await upsertRow(tx, accountId, instance));
    const liveIds = instances.map((e) => e.id);
    const gone = await tx
      .select({ googleEventId: calendarEvents.googleEventId })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.accountId, accountId),
          eq(calendarEvents.recurringEventId, recurringEventId),
          sql`${calendarEvents.status} is distinct from 'cancelled'`,
          ...(liveIds.length > 0 ? [notInArray(calendarEvents.googleEventId, liveIds)] : []),
        ),
      );
    await closeRows(tx, accountId, gone.map((r) => r.googleEventId));
    return ids;
  });
}

/** Il progetto di una riunione: solo uno che chi scrive vede (un admin li vede tutti, come membro implicito). */
async function projectAllowed(db: Db, userId: string, projectId: string | null): Promise<boolean> {
  if (projectId === null) return true;
  return (await projectPermissionsOfUser(db, userId, projectId)) !== null;
}

// --- Le operazioni -------------------------------------------------------

export async function createCalendarEvent(deps: CalendarWriteDeps, userId: string, input: CalendarEventCreate): Promise<CalendarWriteOutcome> {
  const account = await ownAccount(deps.db, userId, input.accountId);
  if (!account) return { error: "not_found" };
  const problem = accountProblem(account);
  if (problem) return problem;
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  const timeProblem = checkTimes(deps.now?.() ?? new Date(), startsAt, endsAt);
  if (timeProblem) return timeProblem;
  if (!(await projectAllowed(deps.db, userId, input.projectId))) return { error: "not_found" };
  const guests = await resolveGuests(deps.db, input.guests);
  if (!guests) return { error: "not_found" };

  let event: GoogleCalendarEvent;
  try {
    const accessToken = await accessTokenFor(deps, account.id);
    event = await deps.client.insertCalendarEvent({
      accessToken,
      event: {
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        allDay: input.allDay,
        guests,
        description: input.description,
        location: input.location,
        addMeet: input.addMeet,
        reminders: input.reminders,
      },
    });
  } catch (err) {
    return googleError(err);
  }
  if (!event.startsAt) return { error: "google_unavailable" };
  const id = await deps.db.transaction((tx) => upsertRow(tx, account.id, event, { projectId: input.projectId }));
  return { ok: true, rowIds: [id] };
}

/** I controlli comuni a modificare, spostare ed eliminare: mia, organizzo io, etag giusto, casella scrivibile. */
async function editableRow(deps: CalendarWriteDeps, userId: string, rowId: string, etag: string | null): Promise<OwnRow | CalendarWriteError> {
  const row = await ownRow(deps.db, userId, rowId);
  if (!row || row.status === "cancelled") return { error: "not_found" };
  if (!isOrganizerRow({ organizerSelf: row.organizerSelf, organizer: row.organizer, accountEmail: row.account.email })) return { error: "not_organizer" };
  if (etag !== row.etag) return { error: "changed_on_google" };
  return accountProblem(row.account) ?? row;
}

/** Su chi si scrive: l'evento (solo questo) o il padre letto da Google (tutta la serie). */
async function target(deps: CalendarWriteDeps, accessToken: string, row: OwnRow, scope: CalendarWriteScope) {
  if (scope === "series" && row.recurringEventId) {
    const parent = await deps.client.getCalendarEvent({ accessToken, eventId: row.recurringEventId });
    return { series: true as const, eventId: parent.id, etag: parent.etag, parent };
  }
  return { series: false as const, eventId: row.googleEventId, etag: row.etag, parent: null };
}

export async function editCalendarEvent(deps: CalendarWriteDeps, userId: string, rowId: string, input: CalendarEventEdit): Promise<CalendarWriteOutcome> {
  const row = await editableRow(deps, userId, rowId, input.etag);
  if ("error" in row) return row;
  const p = input.patch;
  let guests: CalendarGuest[] | undefined;
  if (p.guests !== undefined) {
    const resolved = await resolveGuests(deps.db, p.guests);
    if (!resolved) return { error: "not_found" };
    guests = resolved;
  }
  const patch: CalendarEventPatch = {
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(guests !== undefined ? { guests } : {}),
    ...(p.addMeet !== undefined ? { addMeet: p.addMeet } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.location !== undefined ? { location: p.location } : {}),
    ...(p.reminders !== undefined ? { reminders: p.reminders } : {}),
  };
  return writeAndPersist(deps, row, input.scope, (accessToken, t) => deps.client.patchCalendarEvent({ accessToken, eventId: t.eventId, etag: t.etag, patch }));
}

export async function moveCalendarEvent(deps: CalendarWriteDeps, userId: string, rowId: string, input: CalendarEventMove): Promise<CalendarWriteOutcome> {
  const row = await editableRow(deps, userId, rowId, input.etag);
  if ("error" in row) return row;
  const series = input.scope === "series" && row.recurringEventId !== null;
  const allDay = input.allDay ?? row.allDay;
  // Una serie è tutta «tutto il giorno» o tutta con orario: non si mescolano.
  if (series && allDay !== row.allDay) return { error: "all_day_series" };
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  const timeProblem = checkTimes(deps.now?.() ?? new Date(), startsAt, endsAt);
  if (timeProblem) return timeProblem;
  return writeAndPersist(deps, row, input.scope, (accessToken, t) => {
    if (!t.series) return deps.client.patchCalendarEvent({ accessToken, eventId: t.eventId, etag: t.etag, patch: { startsAt: input.startsAt, endsAt: input.endsAt, allDay } });
    // La serie si sposta con lo STESSO scarto su ogni data: il padre di quanto si sposta questa data.
    const parentStart = t.parent.startsAt;
    if (!parentStart) throw new GoogleApiError({ api: "calendar.events.get", status: 0, code: "unavailable", reason: "parent_without_start" });
    const shift = startsAt.getTime() - row.startsAt.getTime();
    const duration = endsAt.getTime() - startsAt.getTime();
    const newStart = new Date(parentStart.getTime() + shift);
    const newEnd = new Date(newStart.getTime() + duration);
    return deps.client.patchCalendarEvent({ accessToken, eventId: t.eventId, etag: t.etag, patch: { startsAt: newStart.toISOString(), endsAt: newEnd.toISOString(), allDay } });
  });
}

export async function respondCalendarEvent(deps: CalendarWriteDeps, userId: string, rowId: string, input: CalendarEventRespond): Promise<CalendarWriteOutcome> {
  const row = await ownRow(deps.db, userId, rowId);
  if (!row || row.status === "cancelled") return { error: "not_found" };
  if (isOrganizerRow({ organizerSelf: row.organizerSelf, organizer: row.organizer, accountEmail: row.account.email })) return { error: "organizer" };
  if (!myAttendee(row.attendees, row.account.email)) return { error: "not_invited" };
  const problem = accountProblem(row.account);
  if (problem) return problem;
  return writeAndPersist(deps, row, input.scope, (accessToken, t) => {
    // Tutti gli invitati, cambiando solo la casella: quelli del padre per la serie.
    const attendees = (t.parent?.attendees ?? row.attendees).map((a) => ({ email: a.email, responseStatus: a.responseStatus }));
    return deps.client.respondToCalendarEvent({
      accessToken,
      eventId: t.eventId,
      etag: t.etag,
      selfEmail: myAttendee(t.parent?.attendees ?? row.attendees, row.account.email)?.email ?? row.account.email,
      attendees,
      response: input.response,
      note: input.note ?? null,
    });
  });
}

export async function deleteCalendarEventRow(
  deps: CalendarWriteDeps,
  userId: string,
  rowId: string,
  input: { scope: CalendarWriteScope; etag: string | null },
): Promise<{ ok: true } | CalendarWriteError> {
  const row = await editableRow(deps, userId, rowId, input.etag);
  if ("error" in row) return row;
  let series: boolean;
  try {
    const accessToken = await accessTokenFor(deps, row.account.id);
    const t = await target(deps, accessToken, row, input.scope);
    series = t.series;
    try {
      await deps.client.deleteCalendarEvent({ accessToken, eventId: t.eventId, etag: t.etag });
    } catch (err) {
      // Già sparito su Google: l'esito voluto c'è.
      if (!(err instanceof GoogleApiError && (err.status === 404 || err.status === 410))) throw err;
    }
  } catch (err) {
    return googleError(err);
  }
  await deps.db.transaction(async (tx) => {
    if (series && row.recurringEventId) {
      const all = await tx
        .select({ googleEventId: calendarEvents.googleEventId })
        .from(calendarEvents)
        .where(and(eq(calendarEvents.accountId, row.account.id), eq(calendarEvents.recurringEventId, row.recurringEventId)));
      await closeRows(tx, row.account.id, all.map((r) => r.googleEventId));
      await tx.delete(calendarSeries).where(and(eq(calendarSeries.accountId, row.account.id), eq(calendarSeries.recurringEventId, row.recurringEventId)));
    } else {
      await closeRows(tx, row.account.id, [row.googleEventId]);
    }
  });
  return { ok: true };
}

/**
 * Il passo comune: token, bersaglio, la scrittura su Google, poi le righe.
 * Solo le chiamate a Google stanno nel `try`: un errore del DB DOPO il sì di
 * Google è un 500, non un «Google non risponde».
 */
async function writeAndPersist(
  deps: CalendarWriteDeps,
  row: OwnRow,
  scope: CalendarWriteScope,
  write: (accessToken: string, t: Awaited<ReturnType<typeof target>>) => Promise<GoogleCalendarEvent>,
): Promise<CalendarWriteOutcome> {
  let written: GoogleCalendarEvent;
  let instances: GoogleCalendarEvent[] | null = null;
  try {
    const accessToken = await accessTokenFor(deps, row.account.id);
    const t = await target(deps, accessToken, row, scope);
    written = await write(accessToken, t);
    if (t.series) instances = await seriesInstances(deps, accessToken, row.recurringEventId!);
  } catch (err) {
    return googleError(err);
  }
  if (instances) return { ok: true, rowIds: await rewriteSeries(deps.db, row.account.id, row.recurringEventId!, instances) };
  if (!written.startsAt) return { error: "google_unavailable" };
  const id = await deps.db.transaction((tx) => upsertRow(tx, row.account.id, written));
  return { ok: true, rowIds: [id] };
}
