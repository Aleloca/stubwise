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
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

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

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * L'istante di un orario del corpo (review F4, punto 12): un tutto il giorno
 * è una DATA `YYYY-MM-DD` (fine esclusiva), letta a mezzanotte UTC come la
 * scrive il worker; un evento con orario è un istante ISO. Mescolarli è
 * `invalid_range`: una mezzanotte locale tagliata a `slice(0, 10)`
 * prenoterebbe il giorno prima a chi sta a est di Greenwich.
 */
function instantOf(value: string, allDay: boolean): Date | null {
  if (allDay) return DATE_ONLY.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
  return DATE_ONLY.test(value) ? null : new Date(value);
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

/** Ciò che una riga porta con sé oltre ai dati di Google: il progetto e la storia della proposta. */
interface RowKeep {
  projectId: string | null;
  projectBy: "rules" | "model" | "manual" | null;
  proposalCandidate?: boolean;
  proposalNotificationId?: string | null;
  outcome?: Record<string, unknown> | null;
}

/**
 * Scrive (o aggiorna) la riga di un evento dopo il sì di Google. Una riga
 * nuova è solo VISTA (`proposal_candidate` false): una riunione che creo io
 * non è una proposta per me; il poller la rivaluta come ogni altra. `keep`
 * vale anche sul conflitto (review F4, punto 10: se il poller ha scritto la
 * riga prima, il progetto scelto alla creazione non si perde).
 */
async function upsertRow(tx: Tx, accountId: string, event: GoogleCalendarEvent, keep?: RowKeep): Promise<string> {
  const fresh = freshValues(event);
  const [row] = await tx
    .insert(calendarEvents)
    .values({ accountId, googleEventId: event.id, ...fresh, proposalCandidate: false, projectId: null, projectBy: null, ...(keep ?? {}) })
    .onConflictDoUpdate({ target: [calendarEvents.accountId, calendarEvents.googleEventId], set: { ...fresh, ...(keep ?? {}) } })
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

/**
 * La data ORIGINALE di una riga di serie: l'id di un'occorrenza è
 * `<padre>_<inizio originale>` (`…_20261112T090000Z`, o `…_20261112` per un
 * tutto il giorno), e resta quello anche se l'occorrenza è stata spostata.
 */
function originalOf(row: { googleEventId: string; startsAt: Date }): Date {
  const m = /_(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(row.googleEventId);
  if (!m) return row.startsAt;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)));
}

/** Come si riconosce, dopo la scrittura, la data nuova di una data vecchia. */
interface SeriesRekey {
  /** La chiave di una data originale nuova (come la rende Google). */
  keyOf: (original: Date) => number;
  /** La chiave che la data originale di una riga vecchia ha DOPO la scrittura. */
  moved: (original: Date) => number;
}

const SAME_DATES: SeriesRekey = { keyOf: (d) => d.getTime(), moved: (d) => d.getTime() };

/**
 * Riscrive le righe di una serie dalle date che Google rende nella finestra.
 * Una data che cambia id (lo spostamento di una serie cambia gli id) PORTA
 * con sé progetto, candidatura e card dalla riga vecchia (review F4, punto
 * 4), abbinata per data originale; solo una data che non c'è più si chiude, e
 * solo dentro la finestra (punto 5: fuori dalla finestra Google non ha reso
 * niente, quindi non si sa).
 */
async function rewriteSeries(db: Db, now: Date, accountId: string, recurringEventId: string, instances: GoogleCalendarEvent[], rekey: SeriesRekey): Promise<string[]> {
  const { timeMin, timeMax } = windowOf(now);
  return db.transaction(async (tx) => {
    const old = await tx
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.accountId, accountId),
          eq(calendarEvents.recurringEventId, recurringEventId),
          sql`${calendarEvents.status} is distinct from 'cancelled'`,
          gte(calendarEvents.startsAt, timeMin),
          lte(calendarEvents.startsAt, timeMax),
        ),
      );
    const byMovedKey = new Map(old.map((r) => [rekey.moved(originalOf(r)), r]));
    const consumed = new Set<string>();
    const ids: string[] = [];
    for (const instance of instances) {
      const prev = byMovedKey.get(rekey.keyOf(instance.originalStartTime ?? instance.startsAt!));
      let keep: RowKeep | undefined;
      if (prev) {
        consumed.add(prev.id);
        if (prev.googleEventId !== instance.id) {
          keep = { projectId: prev.projectId, projectBy: prev.projectBy, proposalCandidate: prev.proposalCandidate, proposalNotificationId: prev.proposalNotificationId, outcome: prev.outcome };
          await tx.delete(calendarEvents).where(eq(calendarEvents.id, prev.id));
        }
      }
      ids.push(await upsertRow(tx, accountId, instance, keep));
    }
    const liveIds = new Set(instances.map((e) => e.id));
    const gone = old.filter((r) => !consumed.has(r.id) && !liveIds.has(r.googleEventId)).map((r) => r.googleEventId);
    await closeRows(tx, accountId, gone);
    return ids;
  });
}

/** Il progetto di una riunione: solo uno che chi scrive vede (un admin li vede tutti, come membro implicito). */
async function projectAllowed(db: Db, userId: string, projectId: string | null): Promise<boolean> {
  if (projectId === null) return true;
  return (await projectPermissionsOfUser(db, userId, projectId)) !== null;
}

// --- Le operazioni -------------------------------------------------------

/**
 * Crea la riunione UNA volta sola (review F4): l'id lo sceglie il client e
 * Riprova lo rimanda. Un 409 `duplicate` di Google su quell'id vuol dire «già
 * creato» (la prima volta Google ha detto sì, ma la risposta o il DB no): si
 * rilegge l'evento e si prosegue come se fosse riuscito. Solo se lo organizza
 * la casella: un id che ne indovina uno altrui non diventa una presa.
 */
async function insertOnce(deps: CalendarWriteDeps, accessToken: string, event: Parameters<CalendarWriteClient["insertCalendarEvent"]>[0]["event"]): Promise<GoogleCalendarEvent> {
  try {
    return await deps.client.insertCalendarEvent({ accessToken, event });
  } catch (err) {
    if (!(err instanceof GoogleApiError && err.code === "duplicate") || !event.id) throw err;
    const existing = await deps.client.getCalendarEvent({ accessToken, eventId: event.id });
    // Creato e poi eliminato (review F4, punto 9): non è «riuscito», si rilegge.
    if (existing.status === "cancelled") throw new GoogleApiError({ api: "calendar.events.insert", status: 409, code: "changed_on_google", reason: "duplicate_cancelled" });
    if (!existing.organizerSelf) throw new GoogleApiError({ api: "calendar.events.insert", status: 400, code: "duplicate", reason: "duplicate_id" });
    return existing;
  }
}

export async function createCalendarEvent(deps: CalendarWriteDeps, userId: string, input: CalendarEventCreate): Promise<CalendarWriteOutcome> {
  const account = await ownAccount(deps.db, userId, input.accountId);
  if (!account) return { error: "not_found" };
  const problem = accountProblem(account);
  if (problem) return problem;
  const startsAt = instantOf(input.startsAt, input.allDay);
  const endsAt = instantOf(input.endsAt, input.allDay);
  if (!startsAt || !endsAt) return { error: "invalid_range" };
  const timeProblem = checkTimes(deps.now?.() ?? new Date(), startsAt, endsAt);
  if (timeProblem) return timeProblem;
  if (!(await projectAllowed(deps.db, userId, input.projectId))) return { error: "not_found" };
  const guests = await resolveGuests(deps.db, input.guests);
  if (!guests) return { error: "not_found" };

  let event: GoogleCalendarEvent;
  try {
    const accessToken = await accessTokenFor(deps, account.id);
    event = await insertOnce(deps, accessToken, {
        id: input.eventId,
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        allDay: input.allDay,
        guests,
        description: input.description,
        location: input.location,
        addMeet: input.addMeet,
        reminders: input.reminders,
    });
  } catch (err) {
    return googleError(err);
  }
  if (!event.startsAt) return { error: "google_unavailable" };
  const id = await deps.db.transaction((tx) => upsertRow(tx, account.id, event, { projectId: input.projectId, projectBy: input.projectId ? "manual" : null }));
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
  return writeAndPersist(deps, row, input.scope, async (accessToken, t) => ({ event: await deps.client.patchCalendarEvent({ accessToken, eventId: t.eventId, etag: t.etag, patch }) }));
}

/** L'ora LOCALE di un istante in un fuso, come millisecondi «ingenui» (per contare in ore d'orologio). */
function wallMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
}

/** `YYYY-MM-DDTHH:mm:ss`, l'ora locale da mandare a Google insieme al fuso. */
const wallString = (ms: number) => new Date(ms).toISOString().slice(0, 19);

export async function moveCalendarEvent(deps: CalendarWriteDeps, userId: string, rowId: string, input: CalendarEventMove): Promise<CalendarWriteOutcome> {
  const row = await editableRow(deps, userId, rowId, input.etag);
  if ("error" in row) return row;
  const series = input.scope === "series" && row.recurringEventId !== null;
  const allDay = input.allDay ?? row.allDay;
  // Una serie è tutta «tutto il giorno» o tutta con orario: non si mescolano.
  if (series && allDay !== row.allDay) return { error: "all_day_series" };
  const startsAt = instantOf(input.startsAt, allDay);
  const endsAt = instantOf(input.endsAt, allDay);
  if (!startsAt || !endsAt) return { error: "invalid_range" };
  const timeProblem = checkTimes(deps.now?.() ?? new Date(), startsAt, endsAt);
  if (timeProblem) return timeProblem;
  return writeAndPersist(deps, row, input.scope, async (accessToken, t) => {
    if (!t.series) return { event: await deps.client.patchCalendarEvent({ accessToken, eventId: t.eventId, etag: t.etag, patch: { startsAt: input.startsAt, endsAt: input.endsAt, allDay } }) };
    // La serie si sposta con lo STESSO scarto su ogni data (review F4, punto
    // 3): lo scarto si misura dall'inizio ORIGINALE di questa data (se era già
    // stata spostata, da dove stava nella serie) e in ORE D'OROLOGIO nel fuso
    // del padre, così attraversare l'ora legale non sposta l'ora di un'ora.
    const parentStart = t.parent.startsAt;
    if (!parentStart) throw new GoogleApiError({ api: "calendar.events.get", status: 0, code: "unavailable", reason: "parent_without_start" });
    const instance = await deps.client.getCalendarEvent({ accessToken, eventId: row.googleEventId });
    const original = instance.originalStartTime ?? instance.startsAt ?? row.startsAt;
    const timeZone = allDay ? "UTC" : (t.parent.timeZone ?? "UTC");
    const shift = wallMs(startsAt, timeZone) - wallMs(original, timeZone);
    const duration = wallMs(endsAt, timeZone) - wallMs(startsAt, timeZone);
    const newStart = wallMs(parentStart, timeZone) + shift;
    const patch = allDay
      ? { startsAt: wallString(newStart).slice(0, 10), endsAt: wallString(newStart + duration).slice(0, 10), allDay }
      : { startsAt: wallString(newStart), endsAt: wallString(newStart + duration), allDay, timeZone };
    const event = await deps.client.patchCalendarEvent({ accessToken, eventId: t.eventId, etag: t.etag, patch });
    return { event, rekey: { keyOf: (d: Date) => wallMs(d, timeZone), moved: (d: Date) => wallMs(d, timeZone) + shift } };
  });
}

export async function respondCalendarEvent(deps: CalendarWriteDeps, userId: string, rowId: string, input: CalendarEventRespond): Promise<CalendarWriteOutcome> {
  const row = await ownRow(deps.db, userId, rowId);
  if (!row || row.status === "cancelled") return { error: "not_found" };
  if (isOrganizerRow({ organizerSelf: row.organizerSelf, organizer: row.organizer, accountEmail: row.account.email })) return { error: "organizer" };
  if (!myAttendee(row.attendees, row.account.email)) return { error: "not_invited" };
  const problem = accountProblem(row.account);
  if (problem) return problem;
  return writeAndPersist(deps, row, input.scope, async (accessToken, t) => ({
    // Gli invitati li rilegge e li rimanda interi `respondToCalendarEvent`
    // (review F4, punto 8); una nota assente lascia quella di prima.
    event: await deps.client.respondToCalendarEvent({
      accessToken,
      eventId: t.eventId,
      etag: t.etag,
      selfEmail: myAttendee(t.parent?.attendees ?? row.attendees, row.account.email)?.email ?? row.account.email,
      response: input.response,
      ...(input.note !== undefined ? { note: input.note } : {}),
    }),
  }));
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
  write: (accessToken: string, t: Awaited<ReturnType<typeof target>>) => Promise<{ event: GoogleCalendarEvent; rekey?: SeriesRekey }>,
): Promise<CalendarWriteOutcome> {
  let written: { event: GoogleCalendarEvent; rekey?: SeriesRekey };
  let instances: GoogleCalendarEvent[] | null = null;
  try {
    const accessToken = await accessTokenFor(deps, row.account.id);
    const t = await target(deps, accessToken, row, scope);
    written = await write(accessToken, t);
    if (t.series) instances = await seriesInstances(deps, accessToken, row.recurringEventId!);
  } catch (err) {
    return googleError(err);
  }
  if (instances) return { ok: true, rowIds: await rewriteSeries(deps.db, deps.now?.() ?? new Date(), row.account.id, row.recurringEventId!, instances, written.rekey ?? SAME_DATES) };
  if (!written.event.startsAt) return { error: "google_unavailable" };
  const id = await deps.db.transaction((tx) => upsertRow(tx, row.account.id, written.event));
  return { ok: true, rowIds: [id] };
}
