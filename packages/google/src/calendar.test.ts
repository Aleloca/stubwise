import { describe, expect, it } from "vitest";
import { listEvents } from "./calendar.js";
import { GoogleApiError, isFatalGoogleError } from "./errors.js";
import { fakeFetch, jsonResponse } from "./test-support.js";

const EMPTY = { items: [], nextSyncToken: "s2" };

describe("listEvents", () => {
  it("primo giro: finestra timeMin/timeMax sul calendario primary", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(EMPTY)]);
    await listEvents(
      {
        accessToken: "at",
        timeMin: new Date("2026-09-07T00:00:00.000Z"),
        timeMax: new Date("2026-11-06T00:00:00.000Z"),
        maxResults: 250,
      },
      { fetchImpl: impl },
    );
    const call = calls[0];
    expect(call?.url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")).toBe(true);
    expect(call?.headers.authorization).toBe("Bearer at");
    expect(call?.params.get("timeMin")).toBe("2026-09-07T00:00:00.000Z");
    expect(call?.params.get("timeMax")).toBe("2026-11-06T00:00:00.000Z");
    expect(call?.params.get("singleEvents")).toBe("true");
    expect(call?.params.get("maxResults")).toBe("250");
    expect(call?.params.has("syncToken")).toBe(false);
  });

  it("giri successivi: syncToken, e MAI insieme alla finestra (Google la rifiuterebbe)", async () => {
    const { impl, calls } = fakeFetch([jsonResponse(EMPTY)]);
    await listEvents(
      { accessToken: "at", syncToken: "s1", timeMin: new Date("2026-09-07T00:00:00.000Z"), pageToken: "p1" },
      { fetchImpl: impl },
    );
    expect(calls[0]?.params.get("syncToken")).toBe("s1");
    expect(calls[0]?.params.get("pageToken")).toBe("p1");
    expect(calls[0]?.params.has("timeMin")).toBe(false);
    expect(calls[0]?.params.has("timeMax")).toBe(false);
  });

  it("410 significa syncToken scaduto: code sync_token_expired, non fatale", async () => {
    const { impl } = fakeFetch([
      jsonResponse({ error: { code: 410, message: "Sync token is no longer valid.", errors: [{ reason: "fullSyncRequired" }] } }, { status: 410 }),
    ]);
    const error = await listEvents({ accessToken: "at", syncToken: "vecchio" }, { fetchImpl: impl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    const api = error as GoogleApiError;
    expect(api.status).toBe(410);
    expect(api.code).toBe("sync_token_expired");
    expect(api.reason).toBe("fullSyncRequired");
    expect(isFatalGoogleError(api)).toBe(false);
  });

  it("normalizza gli eventi: titolo, orari, partecipanti, organizzatore", async () => {
    const { impl } = fakeFetch([
      jsonResponse({
        items: [
          {
            id: "e1",
            status: "confirmed",
            summary: "Kickoff Acme",
            description: "Avvio",
            start: { dateTime: "2026-09-10T09:00:00+02:00" },
            end: { dateTime: "2026-09-10T10:00:00+02:00" },
            attendees: [{ email: "Ada@ACME.test" }, { email: "bob@acme.test" }, { displayName: "senza email" }],
            organizer: { email: "Ada@ACME.test" },
            htmlLink: "https://calendar.google.test/e1",
            updated: "2026-09-01T08:00:00.000Z",
          },
        ],
        nextPageToken: "p2",
        nextSyncToken: "s9",
      }),
    ]);
    const page = await listEvents({ accessToken: "at" }, { fetchImpl: impl });
    expect(page.nextPageToken).toBe("p2");
    expect(page.nextSyncToken).toBe("s9");
    expect(page.events).toHaveLength(1);
    const event = page.events[0]!;
    expect(event.id).toBe("e1");
    expect(event.status).toBe("confirmed");
    expect(event.title).toBe("Kickoff Acme");
    expect(event.description).toBe("Avvio");
    expect(event.allDay).toBe(false);
    expect(event.startsAt?.toISOString()).toBe("2026-09-10T07:00:00.000Z");
    expect(event.endsAt?.toISOString()).toBe("2026-09-10T08:00:00.000Z");
    expect(event.attendees).toEqual(["ada@acme.test", "bob@acme.test"]);
    expect(event.organizer).toBe("ada@acme.test");
    expect(event.htmlLink).toBe("https://calendar.google.test/e1");
  });

  it("un evento tutto il giorno ha allDay true e la mezzanotte UTC come inizio", async () => {
    const { impl } = fakeFetch([
      jsonResponse({
        items: [{ id: "e2", status: "confirmed", summary: "Consegna", start: { date: "2026-09-12" }, end: { date: "2026-09-13" } }],
      }),
    ]);
    const page = await listEvents({ accessToken: "at" }, { fetchImpl: impl });
    const event = page.events[0]!;
    expect(event.allDay).toBe(true);
    expect(event.startsAt?.toISOString()).toBe("2026-09-12T00:00:00.000Z");
    expect(event.endsAt?.toISOString()).toBe("2026-09-13T00:00:00.000Z");
  });

  it("un'occorrenza di una serie ricorrente porta recurringEventId e originalStartTime (fase 7b)", async () => {
    const { impl } = fakeFetch([
      jsonResponse({
        items: [
          {
            id: "e4_20260910",
            status: "confirmed",
            summary: "Pianificazione task",
            start: { dateTime: "2026-09-10T09:00:00+02:00" },
            end: { dateTime: "2026-09-10T10:00:00+02:00" },
            recurringEventId: "e4",
            originalStartTime: { dateTime: "2026-09-10T09:00:00+02:00" },
          },
        ],
      }),
    ]);
    const page = await listEvents({ accessToken: "at" }, { fetchImpl: impl });
    const event = page.events[0]!;
    expect(event.recurringEventId).toBe("e4");
    expect(event.originalStartTime?.toISOString()).toBe("2026-09-10T07:00:00.000Z");
  });

  it("un evento singolo (non ricorrente) non ha recurringEventId né originalStartTime", async () => {
    const { impl } = fakeFetch([
      jsonResponse({ items: [{ id: "e5", status: "confirmed", summary: "Singolo", start: { dateTime: "2026-09-10T09:00:00Z" } }] }),
    ]);
    const page = await listEvents({ accessToken: "at" }, { fetchImpl: impl });
    const event = page.events[0]!;
    expect(event.recurringEventId).toBeNull();
    expect(event.originalStartTime).toBeNull();
  });

  it("un evento cancellato arriva con status cancelled e senza orari", async () => {
    const { impl } = fakeFetch([jsonResponse({ items: [{ id: "e3", status: "cancelled" }], nextSyncToken: "s3" })]);
    const page = await listEvents({ accessToken: "at", syncToken: "s2" }, { fetchImpl: impl });
    const event = page.events[0]!;
    expect(event.status).toBe("cancelled");
    expect(event.title).toBe("");
    expect(event.startsAt).toBeNull();
    expect(event.attendees).toEqual([]);
    expect(event.organizer).toBeNull();
  });

  it("una pagina senza nextSyncToken lo riporta null (la sync non è finita)", async () => {
    const { impl } = fakeFetch([jsonResponse({ items: [], nextPageToken: "p3" })]);
    const page = await listEvents({ accessToken: "at" }, { fetchImpl: impl });
    expect(page.nextSyncToken).toBeNull();
    expect(page.nextPageToken).toBe("p3");
  });
});
