import { describe, expect, it } from "vitest";
import { deleteCalendarEvent, insertCalendarEvent, patchCalendarEvent, respondToCalendarEvent } from "./calendar-write.js";
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
  it("manda TUTTI gli invitati, cambiando solo la mia risposta e la mia nota", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(created)]);
    await respondToCalendarEvent(
      {
        accessToken: "at",
        eventId: "e1",
        etag: '"1"',
        selfEmail: "ada@acme.com",
        attendees: [
          { email: "capo@x.it", responseStatus: "accepted" },
          { email: "Ada@Acme.com", responseStatus: "needsAction" },
        ],
        response: "tentative",
        note: "arrivo tardi",
      },
      { fetchImpl: impl },
    );
    expect(calls[0]!.headers["if-match"]).toBe('"1"');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      attendees: [
        { email: "capo@x.it", responseStatus: "accepted" },
        { email: "Ada@Acme.com", responseStatus: "tentative", comment: "arrivo tardi" },
      ],
    });
  });
});
