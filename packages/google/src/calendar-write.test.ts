import { describe, expect, it } from "vitest";
import { deleteCalendarEvent, getCalendarEvent, insertCalendarEvent, listEventInstances, patchCalendarEvent, respondToCalendarEvent } from "./calendar-write.js";
import { fakeFetch, jsonResponse } from "./test-support.js";

/**
 * Scrivere sul Calendario (area 6, F4, task 2): le richieste esatte a Google.
 * Gli inviti li manda Google (`sendUpdates=all`, Q6), le modifiche portano
 * l'etag (`If-Match`): un evento cambiato su Google è `changed_on_google`.
 */

const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const created = { id: "e1", etag: '"1"', summary: "Revisione", start: { dateTime: "2026-09-15T09:00:00Z" }, end: { dateTime: "2026-09-15T10:00:00Z" }, hangoutLink: "https://meet.google.com/abc" };

describe("insertCalendarEvent", () => {
  it("POST con sendUpdates=all, gli invitati, i promemoria, e Meet con conferenceDataVersion=1 e una createRequest", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(created)]);
    const event = await insertCalendarEvent(
      {
        accessToken: "at",
        event: {
          title: "Revisione",
          startsAt: "2026-09-15T09:00:00.000Z",
          endsAt: "2026-09-15T10:00:00.000Z",
          allDay: false,
          guests: [{ email: "bob@x.it", name: "Bob" }],
          description: "Ordine del giorno",
          location: "Sala 2",
          addMeet: true,
          reminders: [{ minutes: 10, method: "popup" }],
        },
      },
      { fetchImpl: impl },
    );
    expect(event).toMatchObject({ id: "e1", etag: '"1"', hangoutLink: "https://meet.google.com/abc" });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE}?sendUpdates=all&conferenceDataVersion=1`);
    const body = JSON.parse(call.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      summary: "Revisione",
      description: "Ordine del giorno",
      location: "Sala 2",
      start: { dateTime: "2026-09-15T09:00:00.000Z" },
      end: { dateTime: "2026-09-15T10:00:00.000Z" },
      attendees: [{ email: "bob@x.it", displayName: "Bob" }],
      reminders: { useDefault: false, overrides: [{ minutes: 10, method: "popup" }] },
    });
    expect((body.conferenceData as { createRequest: { conferenceSolutionKey: { type: string }; requestId: string } }).createRequest).toMatchObject({ conferenceSolutionKey: { type: "hangoutsMeet" }, requestId: expect.any(String) });
  });

  it("tutto il giorno: date (fine esclusiva), senza Meet niente conferenceDataVersion", async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ ...created, start: { date: "2026-09-15" }, end: { date: "2026-09-16" } })]);
    await insertCalendarEvent({ accessToken: "at", event: { title: "Ferie", startsAt: "2026-09-15", endsAt: "2026-09-16", allDay: true, guests: [], addMeet: false, reminders: "default" } }, { fetchImpl: impl });
    expect(calls[0]!.url).toBe(`${BASE}?sendUpdates=all`);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ start: { date: "2026-09-15" }, end: { date: "2026-09-16" }, reminders: { useDefault: true } });
  });
});

describe("patchCalendarEvent / deleteCalendarEvent", () => {
  it("PATCH con If-Match sull'etag; un 412 di Google è changed_on_google", async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ ...created, etag: '"2"' }), jsonResponse({ error: { code: 412, message: "Precondition Failed", errors: [{ reason: "conditionNotMet" }] } }, { status: 412 })]);
    const out = await patchCalendarEvent({ accessToken: "at", eventId: "e1", etag: '"1"', patch: { title: "Revisione 2" } }, { fetchImpl: impl });
    expect(out.etag).toBe('"2"');
    expect(calls[0]).toMatchObject({ method: "PATCH", url: `${BASE}/e1?sendUpdates=all` });
    expect(calls[0]!.headers["if-match"]).toBe('"1"');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ summary: "Revisione 2" });
    await expect(patchCalendarEvent({ accessToken: "at", eventId: "e1", etag: '"1"', patch: { title: "x" } }, { fetchImpl: impl })).rejects.toMatchObject({ status: 412, code: "changed_on_google" });
  });

  it("DELETE con If-Match e sendUpdates=all", async () => {
    const { impl, calls } = fakeFetch([new Response(null, { status: 204 })]);
    await deleteCalendarEvent({ accessToken: "at", eventId: "e 1", etag: '"5"' }, { fetchImpl: impl });
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `${BASE}/e%201?sendUpdates=all` });
    expect(calls[0]!.headers["if-match"]).toBe('"5"');
  });
});

describe("respondToCalendarEvent", () => {
  const raw = {
    ...created,
    etag: '"1"',
    attendees: [
      { email: "capo@x.it", responseStatus: "accepted", displayName: "Il Capo", organizer: true },
      { email: "ospite@x.it", responseStatus: "needsAction", optional: true, additionalGuests: 1 },
      { email: "Ada@Acme.com", responseStatus: "needsAction", comment: "nota di prima", self: true },
    ],
  };

  it("rilegge gli invitati GREZZI e li rimanda tutti con ogni loro campo, cambiando solo la mia risposta e la mia nota (review F4, punto 8)", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(raw), jsonResponse(created)]);
    await respondToCalendarEvent({ accessToken: "at", eventId: "e1", etag: '"1"', selfEmail: "ada@acme.com", response: "tentative", note: "arrivo tardi" }, { fetchImpl: impl });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.headers["if-match"]).toBe('"1"');
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      attendees: [
        { email: "capo@x.it", responseStatus: "accepted", displayName: "Il Capo", organizer: true },
        { email: "ospite@x.it", responseStatus: "needsAction", optional: true, additionalGuests: 1 },
        { email: "Ada@Acme.com", responseStatus: "tentative", comment: "arrivo tardi", self: true },
      ],
    });
  });

  it("senza nota la mia nota di prima resta; con una nota vuota se ne va", async () => {
    const keep = fakeFetch([jsonResponse(raw), jsonResponse(created)]);
    await respondToCalendarEvent({ accessToken: "at", eventId: "e1", etag: '"1"', selfEmail: "ada@acme.com", response: "accepted" }, { fetchImpl: keep.impl });
    expect((JSON.parse(keep.calls[1]!.body!) as { attendees: Record<string, unknown>[] }).attendees[2]).toEqual({ email: "Ada@Acme.com", responseStatus: "accepted", comment: "nota di prima", self: true });
    const clear = fakeFetch([jsonResponse(raw), jsonResponse(created)]);
    await respondToCalendarEvent({ accessToken: "at", eventId: "e1", etag: '"1"', selfEmail: "ada@acme.com", response: "accepted", note: null }, { fetchImpl: clear.impl });
    expect((JSON.parse(clear.calls[1]!.body!) as { attendees: Record<string, unknown>[] }).attendees[2]).toEqual({ email: "Ada@Acme.com", responseStatus: "accepted", self: true });
  });

  it("un etag diverso da quello che il client ha letto: changed_on_google, nessuna scrittura", async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ ...raw, etag: '"2"' })]);
    await expect(respondToCalendarEvent({ accessToken: "at", eventId: "e1", etag: '"1"', selfEmail: "ada@acme.com", response: "accepted" }, { fetchImpl: impl })).rejects.toMatchObject({ status: 412, code: "changed_on_google" });
    expect(calls).toHaveLength(1);
  });
});

describe("patch: orari espliciti (review F4, punti 3 e 6)", () => {
  it("da con orario a tutto il giorno: `dateTime: null` accanto a `date` (Google unisce gli oggetti annidati)", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(created)]);
    await patchCalendarEvent({ accessToken: "at", eventId: "e1", etag: '"1"', patch: { startsAt: "2026-09-15", endsAt: "2026-09-16", allDay: true } }, { fetchImpl: impl });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ start: { date: "2026-09-15", dateTime: null, timeZone: null }, end: { date: "2026-09-16", dateTime: null, timeZone: null } });
  });

  it("da tutto il giorno a con orario: `date: null`; con un fuso, l'ora LOCALE di quel fuso", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(created), jsonResponse(created)]);
    await patchCalendarEvent({ accessToken: "at", eventId: "e1", etag: '"1"', patch: { startsAt: "2026-09-15T09:00:00.000Z", endsAt: "2026-09-15T10:00:00.000Z", allDay: false } }, { fetchImpl: impl });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ start: { dateTime: "2026-09-15T09:00:00.000Z", date: null }, end: { dateTime: "2026-09-15T10:00:00.000Z", date: null } });
    await patchCalendarEvent({ accessToken: "at", eventId: "e1", etag: '"1"', patch: { startsAt: "2026-11-02T11:00:00", endsAt: "2026-11-02T12:00:00", allDay: false, timeZone: "Europe/Rome" } }, { fetchImpl: impl });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ start: { dateTime: "2026-11-02T11:00:00", timeZone: "Europe/Rome", date: null }, end: { dateTime: "2026-11-02T12:00:00", timeZone: "Europe/Rome", date: null } });
  });

  it("il fuso dell'evento si legge da `start.timeZone`", async () => {
    const { impl } = fakeFetch([jsonResponse({ ...created, start: { dateTime: "2026-09-15T09:00:00+02:00", timeZone: "Europe/Rome" } })]);
    expect(await getCalendarEvent({ accessToken: "at", eventId: "e1" }, { fetchImpl: impl })).toMatchObject({ timeZone: "Europe/Rome" });
  });
});

describe("le letture che servono a scrivere una serie", () => {
  it("getCalendarEvent: l'evento intero col suo etag (il padre di una serie)", async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ ...created, id: "p 1", etag: '"9"', recurrence: ["RRULE:FREQ=WEEKLY"] })]);
    const event = await getCalendarEvent({ accessToken: "at", eventId: "p 1" }, { fetchImpl: impl });
    expect(event).toMatchObject({ id: "p 1", etag: '"9"' });
    expect(calls[0]!.url).toBe(`${BASE}/p%201`);
  });

  it("listEventInstances: le date della serie nella finestra, pagina dopo pagina", async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({ items: [{ ...created, id: "p_1", recurringEventId: "p" }], nextPageToken: "n2" }),
      jsonResponse({ items: [{ ...created, id: "p_2", recurringEventId: "p" }] }),
    ]);
    const events = await listEventInstances(
      { accessToken: "at", eventId: "p", timeMin: new Date("2026-09-01T00:00:00.000Z"), timeMax: new Date("2026-10-01T00:00:00.000Z") },
      { fetchImpl: impl },
    );
    expect(events.map((e) => e.id)).toEqual(["p_1", "p_2"]);
    expect(calls[0]!.url).toBe(`${BASE}/p/instances?timeMin=2026-09-01T00%3A00%3A00.000Z&timeMax=2026-10-01T00%3A00%3A00.000Z&maxResults=250`);
    expect(calls[1]!.url).toContain("pageToken=n2");
  });
});

describe("insertCalendarEvent idempotente (review F4: Riprova non crea una seconda riunione)", () => {
  it("manda l'id scelto dal client; un 409 di Google su quell'id è `duplicate`", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(created), jsonResponse({ error: { code: 409, message: "The requested identifier already exists.", errors: [{ reason: "duplicate" }] } }, { status: 409 })]);
    const event = { title: "R", startsAt: "2026-09-15T09:00:00.000Z", endsAt: "2026-09-15T10:00:00.000Z", allDay: false, guests: [], addMeet: false, reminders: "default" as const, id: "abc0123456v" };
    await insertCalendarEvent({ accessToken: "at", event }, { fetchImpl: impl });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ id: "abc0123456v" });
    await expect(insertCalendarEvent({ accessToken: "at", event }, { fetchImpl: impl })).rejects.toMatchObject({ status: 409, code: "duplicate" });
  });
});
