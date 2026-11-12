import { randomUUID } from "node:crypto";
import { calendarEvents, calendarSeries, encrypt, googleAccounts, googleWorkspaces, notifications, projects, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { GoogleApiError, type GoogleCalendarEvent } from "@stubwise/google";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { CalendarWriteClient } from "../services/calendar-writes.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * SCRIVERE SUL CALENDARIO (area 6, F4, task 3): le rotte di scrittura.
 * Filo conduttore: i controlli stanno sul SERVER e, quando dicono no,
 * Google non viene chiamato; la riga si aggiorna nella stessa richiesta
 * dopo il sì di Google; solo le proprie caselle, anche per un admin.
 */

const KEY = Buffer.alloc(32, 9);
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"];
const DAY = 24 * 3600_000;
const at = (days: number, hour = 9) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
const calls: { fn: string; input: Record<string, unknown> }[] = [];
let failWith: unknown = null;
let parent: GoogleCalendarEvent | null = null;
let instances: GoogleCalendarEvent[] = [];

function gEvent(over: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    id: `g-${randomUUID()}`,
    status: "confirmed",
    title: "Revisione",
    description: null,
    allDay: false,
    startsAt: at(3),
    endsAt: at(3, 10),
    attendees: [],
    organizer: null,
    htmlLink: null,
    etag: '"10"',
    iCalUID: "uid-1@google.com",
    visibility: "default",
    organizerSelf: true,
    eventType: "default",
    transparency: "opaque",
    updatedAt: null,
    recurringEventId: null,
    originalStartTime: null,
    location: null,
    hangoutLink: null,
    conferenceEntryPoints: [],
    reminders: [],
    remindersUseDefault: true,
    ...over,
  };
}

function record(fn: string, input: object) {
  calls.push({ fn, input: input as Record<string, unknown> });
  if (failWith) throw failWith;
}

const fake: CalendarWriteClient = {
  refreshAccessToken: async () => ({ accessToken: "at-casella", expiresInSeconds: 3600, refreshToken: null, scopes: [], tokenType: "Bearer", idToken: null }),
  insertCalendarEvent: async (input) => {
    record("insert", input);
    return gEvent({ id: "g-new", title: input.event.title, startsAt: new Date(input.event.startsAt), endsAt: new Date(input.event.endsAt), hangoutLink: input.event.addMeet ? "https://meet.google.com/abc" : null, attendees: input.event.guests.map((g) => ({ email: g.email, responseStatus: "needsAction" })) });
  },
  patchCalendarEvent: async (input) => {
    record("patch", input);
    return gEvent({ id: input.eventId, etag: '"11"', title: input.patch.title ?? "Revisione", ...(input.patch.startsAt ? { startsAt: new Date(input.patch.startsAt), endsAt: new Date(input.patch.endsAt!) } : {}) });
  },
  deleteCalendarEvent: async (input) => {
    record("delete", input);
  },
  respondToCalendarEvent: async (input) => {
    record("respond", input);
    return gEvent({ id: input.eventId, etag: '"12"', organizerSelf: false, organizer: "capo@x.it", attendees: input.attendees.map((a) => (a.email.toLowerCase() === input.selfEmail.toLowerCase() ? { email: a.email, responseStatus: input.response, comment: input.note ?? undefined, self: true } : { email: a.email, responseStatus: a.responseStatus as "accepted" })) });
  },
  getCalendarEvent: async (input) => {
    record("get", input);
    return parent!;
  },
  listEventInstances: async (input) => {
    record("instances", input);
    return instances;
  },
};

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: KEY.toString("base64"), calendarWriteClient: fake });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);
beforeEach(() => {
  calls.length = 0;
  failWith = null;
  parent = null;
  instances = [];
});
afterEach(async () => {
  await db.delete(calendarSeries);
  await db.delete(calendarEvents);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
});
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function scenario(scopes = SCOPES) {
  const me = await createUserWithSession(app, `ada-${randomUUID()}@acme.com`);
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: encrypt("s", KEY) }).returning();
  const email = `ada-box-${randomUUID().slice(0, 6)}@acme.com`;
  const [box] = await db.insert(googleAccounts).values({ userId: me.id, workspaceId: ws!.id, email, googleSub: randomUUID(), refreshTokenEncrypted: encrypt("r", KEY), scopes }).returning();
  return { me, accountId: box!.id, email };
}

async function seedRow(accountId: string, over: Partial<typeof calendarEvents.$inferInsert> = {}) {
  const startsAt = (over.startsAt as Date | undefined) ?? at(3);
  const [row] = await db
    .insert(calendarEvents)
    .values({ accountId, googleEventId: `g-${randomUUID()}`, title: "Revisione", startsAt, endsAt: new Date(startsAt.getTime() + 3600_000), status: "confirmed", fingerprint: "x", organizerSelf: true, etag: '"10"', proposalCandidate: false, ...over })
    .returning();
  return row!;
}

async function seedProject() {
  const [p] = await db.insert(projects).values({ name: "Progetto", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
  return p!.id;
}

const inject = (cookie: { cookie: string }, method: "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url: `/api/me/calendar${url}`, headers: cookie, ...(payload ? { payload } : {}) });

describe("POST /events — nuova riunione", () => {
  it("scrive su Google con gli invitati risolti, poi la riga (progetto a mano, la vede subito range)", async () => {
    const { me, accountId } = await scenario();
    const bob = await createUserWithSession(app, `bob-${randomUUID()}@acme.com`);
    const projectId = await seedProject();
    await addMember(app, projectId, me.id);
    const res = await inject(me.headers, "POST", "/events", {
      accountId,
      title: "Revisione",
      startsAt: at(3).toISOString(),
      endsAt: at(3, 10).toISOString(),
      guests: [{ personId: bob.id }, { email: "esterno@altro.it", name: "Esterno" }],
      addMeet: true,
      projectId,
      reminders: [{ minutes: 10, method: "popup" }],
    });
    expect(res.statusCode).toBe(200);
    const event = (calls[0]!.input as { event: { guests: { email: string }[] } }).event;
    expect(event.guests.map((g) => g.email)).toEqual([expect.stringMatching(/^bob-/), "esterno@altro.it"]);
    const item = res.json().items[0];
    expect(item).toMatchObject({ title: "Revisione", canEdit: true, etag: '"10"', projectId, projectBy: "manual", hangoutLink: "https://meet.google.com/abc" });
    const [row] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, item.id));
    expect(row).toMatchObject({ googleEventId: "g-new", proposalCandidate: false, projectBy: "manual" });
  });

  it("i no PRIMA di Google: un progetto che non vedo (404), fuori dalla finestra (400), lo scope che manca (409), la casella di un altro (404) — nessuna chiamata", async () => {
    const { me, accountId } = await scenario();
    const notMine = await seedProject();
    const base = { accountId, title: "R", startsAt: at(3).toISOString(), endsAt: at(3, 10).toISOString() };
    expect((await inject(me.headers, "POST", "/events", { ...base, projectId: notMine })).statusCode).toBe(404);
    const far = await inject(me.headers, "POST", "/events", { ...base, startsAt: at(70).toISOString(), endsAt: at(70, 10).toISOString() });
    expect([far.statusCode, far.json().code]).toEqual([400, "outside_window"]);
    const other = await scenario();
    expect((await inject(other.me.headers, "POST", "/events", base)).statusCode).toBe(404);
    const narrow = await scenario(["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"]);
    const missing = await inject(narrow.me.headers, "POST", "/events", { ...base, accountId: narrow.accountId });
    expect([missing.statusCode, missing.json().code, missing.json().missing]).toEqual([409, "google_scope_missing", expect.arrayContaining(["https://www.googleapis.com/auth/calendar.events"])]);
    expect(calls).toEqual([]);
  });

  it("nessuna notifica nuova", async () => {
    const { me, accountId } = await scenario();
    const before = (await db.select().from(notifications)).length;
    await inject(me.headers, "POST", "/events", { accountId, title: "R", startsAt: at(3).toISOString(), endsAt: at(3, 10).toISOString() });
    expect((await db.select().from(notifications)).length).toBe(before);
  });
});

describe("PATCH /events/:id e /move — solo l'organizzatore, sull'etag letto", () => {
  it("modifica: Google col mio etag, la riga aggiornata nella stessa richiesta", async () => {
    const { me, accountId } = await scenario();
    const row = await seedRow(accountId);
    const res = await inject(me.headers, "PATCH", `/events/${row.id}`, { etag: '"10"', patch: { title: "Nuovo titolo" } });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ fn: "patch", input: expect.objectContaining({ eventId: row.googleEventId, etag: '"10"', patch: { title: "Nuovo titolo" } }) }]);
    expect(res.json().items[0]).toMatchObject({ id: row.id, title: "Nuovo titolo", etag: '"11"' });
  });

  it("un invitato che non organizza: 403 not_organizer, e Google non viene chiamato (modifica, sposta, elimina)", async () => {
    const { me, accountId, email } = await scenario();
    const row = await seedRow(accountId, { organizerSelf: false, organizer: "capo@x.it", attendees: [{ email, responseStatus: "accepted", self: true }] });
    const edit = await inject(me.headers, "PATCH", `/events/${row.id}`, { etag: '"10"', patch: { title: "x" } });
    const move = await inject(me.headers, "POST", `/events/${row.id}/move`, { etag: '"10"', startsAt: at(4).toISOString(), endsAt: at(4, 10).toISOString() });
    const del = await inject(me.headers, "DELETE", `/events/${row.id}?etag=${encodeURIComponent('"10"')}`);
    expect([edit, move, del].map((r) => [r.statusCode, r.json().code])).toEqual([[403, "not_organizer"], [403, "not_organizer"], [403, "not_organizer"]]);
    expect(calls).toEqual([]);
    const [still] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, row.id));
    expect(still!.title).toBe("Revisione");
  });

  it("l'evento di un altro, anche per un admin: 404 e nessuna chiamata", async () => {
    const { accountId } = await scenario();
    const row = await seedRow(accountId);
    const res = await inject({ cookie: adminCookie }, "PATCH", `/events/${row.id}`, { etag: '"10"', patch: { title: "x" } });
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it("un etag vecchio: 409 changed_on_google senza chiamare Google; un 412 di Google è lo stesso 409, e la riga non cambia", async () => {
    const { me, accountId } = await scenario();
    const row = await seedRow(accountId);
    const stale = await inject(me.headers, "PATCH", `/events/${row.id}`, { etag: '"9"', patch: { title: "x" } });
    expect([stale.statusCode, stale.json().code]).toEqual([409, "changed_on_google"]);
    expect(calls).toEqual([]);
    failWith = new GoogleApiError({ api: "calendar.events.patch", status: 412, code: "changed_on_google", reason: "conditionNotMet" });
    const raced = await inject(me.headers, "PATCH", `/events/${row.id}`, { etag: '"10"', patch: { title: "x" } });
    expect([raced.statusCode, raced.json().code]).toEqual([409, "changed_on_google"]);
    const [still] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, row.id));
    expect(still!.title).toBe("Revisione");
  });

  it("Google rifiuta (400): 422 google_rejected col motivo; Google irraggiungibile: 502", async () => {
    const { me, accountId } = await scenario();
    const row = await seedRow(accountId);
    failWith = new GoogleApiError({ api: "calendar.events.patch", status: 400, code: "bad_request", reason: "invalid" });
    const rejected = await inject(me.headers, "PATCH", `/events/${row.id}`, { etag: '"10"', patch: { title: "x" } });
    expect([rejected.statusCode, rejected.json().reason]).toEqual([422, "invalid"]);
    failWith = new GoogleApiError({ api: "calendar.events.patch", status: 0, code: "network", reason: "timeout" });
    expect((await inject(me.headers, "PATCH", `/events/${row.id}`, { etag: '"10"', patch: { title: "x" } })).statusCode).toBe(502);
  });

  it("sposta «solo questo»: le date nuove su Google e sulla riga; fuori dalla finestra 400", async () => {
    const { me, accountId } = await scenario();
    const row = await seedRow(accountId);
    const res = await inject(me.headers, "POST", `/events/${row.id}/move`, { etag: '"10"', startsAt: at(5, 14).toISOString(), endsAt: at(5, 15).toISOString() });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].startsAt).toBe(at(5, 14).toISOString());
    calls.length = 0;
    const far = await inject(me.headers, "POST", `/events/${row.id}/move`, { etag: '"11"', startsAt: at(-40).toISOString(), endsAt: at(-40, 10).toISOString() });
    expect([far.statusCode, far.json().code]).toEqual([400, "outside_window"]);
    // Comincia fuori e finisce dentro: fuori lo stesso (conta anche l'inizio).
    const straddle = await inject(me.headers, "POST", `/events/${row.id}/move`, { etag: '"11"', startsAt: at(-31).toISOString(), endsAt: at(-29).toISOString() });
    expect([straddle.statusCode, straddle.json().code]).toEqual([400, "outside_window"]);
    expect(calls).toEqual([]);
  });

  it("sposta «tutta la serie»: il PADRE con lo stesso scarto, poi le righe riscritte dalle date di Google; una data che non c'è più si chiude con la sua card", async () => {
    const { me, accountId } = await scenario();
    const old = await seedRow(accountId, { recurringEventId: "p", googleEventId: "p_old", startsAt: at(3) });
    const candidate = await seedRow(accountId, { recurringEventId: "p", googleEventId: "p_old2", startsAt: at(10), proposalCandidate: true });
    const [card] = await db.insert(notifications).values({ userId: me.id, kind: "google.proposal", status: "open", event: { kind: "google.proposal" } as never }).returning();
    await db.update(calendarEvents).set({ proposalNotificationId: card!.id }).where(eq(calendarEvents.id, candidate.id));
    parent = gEvent({ id: "p", etag: '"p1"', startsAt: at(-20), endsAt: at(-20, 10) });
    instances = [gEvent({ id: "p_new", recurringEventId: "p", startsAt: at(3, 11), endsAt: at(3, 12) })];
    const res = await inject(me.headers, "POST", `/events/${old.id}/move`, { scope: "series", etag: '"10"', startsAt: at(3, 11).toISOString(), endsAt: at(3, 12).toISOString() });
    expect(res.statusCode).toBe(200);
    const patch = calls.find((c) => c.fn === "patch")!.input as { eventId: string; etag: string; patch: { startsAt: string; endsAt: string } };
    expect(patch).toMatchObject({ eventId: "p", etag: '"p1"', patch: { startsAt: at(-20, 11).toISOString(), endsAt: at(-20, 12).toISOString() } });
    expect(res.json().items.map((i: { startsAt: string }) => i.startsAt)).toEqual([at(3, 11).toISOString()]);
    const rows = await db.select().from(calendarEvents).where(eq(calendarEvents.accountId, accountId));
    expect(rows.map((r) => [r.googleEventId, r.status]).sort()).toEqual([["p_new", "confirmed"], ["p_old2", "cancelled"]]);
    const [closed] = await db.select().from(notifications).where(eq(notifications.id, card!.id));
    expect(closed!.status).toBe("handled");
  });

  it("una serie non passa fra «tutto il giorno» e con orario: 400 all_day_series", async () => {
    const { me, accountId } = await scenario();
    const row = await seedRow(accountId, { recurringEventId: "p" });
    const res = await inject(me.headers, "POST", `/events/${row.id}/move`, { scope: "series", etag: '"10"', allDay: true, startsAt: at(3, 0).toISOString(), endsAt: at(4, 0).toISOString() });
    expect([res.statusCode, res.json().code]).toEqual([400, "all_day_series"]);
    expect(calls).toEqual([]);
  });
});

describe("POST /events/:id/respond", () => {
  it("l'organizzatore non risponde (400 organizer), chi non è invitato nemmeno (400 not_invited): nessuna chiamata", async () => {
    const { me, accountId } = await scenario();
    const mine = await seedRow(accountId);
    const notInvited = await seedRow(accountId, { organizerSelf: false, organizer: "capo@x.it", attendees: [{ email: "capo@x.it", responseStatus: "accepted" }] });
    const a = await inject(me.headers, "POST", `/events/${mine.id}/respond`, { response: "accepted" });
    const b = await inject(me.headers, "POST", `/events/${notInvited.id}/respond`, { response: "accepted" });
    expect([a, b].map((r) => [r.statusCode, r.json().code])).toEqual([[400, "organizer"], [400, "not_invited"]]);
    expect(calls).toEqual([]);
  });

  it("un invitato risponde con la nota: tutti gli invitati a Google, la riga con la mia risposta", async () => {
    const { me, accountId, email } = await scenario();
    const row = await seedRow(accountId, { organizerSelf: false, organizer: "capo@x.it", attendees: [{ email: "capo@x.it", responseStatus: "accepted" }, { email, responseStatus: "needsAction", self: true }] });
    const res = await inject(me.headers, "POST", `/events/${row.id}/respond`, { response: "tentative", note: "arrivo tardi" });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.input).toMatchObject({ eventId: row.googleEventId, etag: '"10"', selfEmail: email, response: "tentative", note: "arrivo tardi", attendees: [{ email: "capo@x.it", responseStatus: "accepted" }, { email, responseStatus: "needsAction" }] });
    expect(res.json().items[0]).toMatchObject({ myResponse: "tentative", myNote: "arrivo tardi", canRespond: true });
  });
});

describe("DELETE /events/:id", () => {
  it("solo questo: Google, poi la riga se ne va; una candidata si chiude con la sua card (Q5)", async () => {
    const { me, accountId } = await scenario();
    const seen = await seedRow(accountId);
    const candidate = await seedRow(accountId, { proposalCandidate: true });
    const [card] = await db.insert(notifications).values({ userId: me.id, kind: "google.proposal", status: "open", event: { kind: "google.proposal" } as never }).returning();
    await db.update(calendarEvents).set({ proposalNotificationId: card!.id }).where(eq(calendarEvents.id, candidate.id));
    expect((await inject(me.headers, "DELETE", `/events/${seen.id}?etag=${encodeURIComponent('"10"')}`)).statusCode).toBe(204);
    expect((await inject(me.headers, "DELETE", `/events/${candidate.id}?etag=${encodeURIComponent('"10"')}`)).statusCode).toBe(204);
    expect(calls.map((c) => [c.fn, c.input.eventId])).toEqual([["delete", seen.googleEventId], ["delete", candidate.googleEventId]]);
    const rows = await db.select().from(calendarEvents).where(eq(calendarEvents.accountId, accountId));
    expect(rows.map((r) => [r.id, r.status, (r.outcome as { type?: string } | null)?.type])).toEqual([[candidate.id, "cancelled", "cancelled"]]);
    const [closed] = await db.select().from(notifications).where(eq(notifications.id, card!.id));
    expect(closed!.status).toBe("handled");
  });

  it("tutta la serie: il padre su Google, tutte le date e la configurazione della serie se ne vanno", async () => {
    const { me, accountId } = await scenario();
    const one = await seedRow(accountId, { recurringEventId: "p" });
    await seedRow(accountId, { recurringEventId: "p", startsAt: at(10) });
    const other = await seedRow(accountId);
    await db.insert(calendarSeries).values({ accountId, recurringEventId: "p", enabled: false });
    parent = gEvent({ id: "p", etag: '"p1"' });
    expect((await inject(me.headers, "DELETE", `/events/${one.id}?scope=series&etag=${encodeURIComponent('"10"')}`)).statusCode).toBe(204);
    expect(calls.find((c) => c.fn === "delete")!.input).toMatchObject({ eventId: "p", etag: '"p1"' });
    const rows = await db.select().from(calendarEvents).where(eq(calendarEvents.accountId, accountId));
    expect(rows.map((r) => r.id)).toEqual([other.id]);
    expect(await db.select().from(calendarSeries)).toEqual([]);
  });

  it("già sparito su Google (404): la riga se ne va lo stesso", async () => {
    const { me, accountId } = await scenario();
    const row = await seedRow(accountId);
    failWith = new GoogleApiError({ api: "calendar.events.delete", status: 410, code: "event_gone", reason: "deleted" });
    expect((await inject(me.headers, "DELETE", `/events/${row.id}?etag=${encodeURIComponent('"10"')}`)).statusCode).toBe(204);
    expect(await db.select().from(calendarEvents).where(eq(calendarEvents.id, row.id))).toEqual([]);
  });
});
