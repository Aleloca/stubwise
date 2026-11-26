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
            attendees: [
              { email: "Ada@ACME.test", responseStatus: "accepted" },
              { email: "bob@acme.test", responseStatus: "needsAction" },
              { displayName: "senza email" },
            ],
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
    expect(event.attendees).toEqual([
      { email: "ada@acme.test", responseStatus: "accepted", name: null, comment: null, self: false },
      { email: "bob@acme.test", responseStatus: "needsAction", name: null, comment: null, self: false },
    ]);
    expect(event.organizer).toBe("ada@acme.test");
    expect(event.htmlLink).toBe("https://calendar.google.test/e1");
  });

  it("F4, task 0: etag, iCalUID, visibilità, organizzatore e i dati degli invitati (nome, nota, self)", async () => {
    const { impl } = fakeFetch([
      jsonResponse({
        items: [
          {
            id: "e1",
            etag: '"3412"',
            iCalUID: "abc@google.com",
            visibility: "private",
            summary: "Revisione",
            start: { dateTime: "2026-09-10T09:00:00Z" },
            organizer: { email: "Ada@ACME.test", self: true },
            attendees: [
              { email: "ada@acme.test", self: true, responseStatus: "accepted", organizer: true },
              { email: "Bob@acme.test", displayName: "Bob Rossi", responseStatus: "tentative", comment: "arrivo tardi" },
            ],
          },
          { id: "e2", summary: "Vecchio", start: { dateTime: "2026-09-11T09:00:00Z" } },
        ],
      }),
    ]);
    const page = await listEvents({ accessToken: "at" }, { fetchImpl: impl });
    expect(page.events[0]).toMatchObject({ etag: '"3412"', iCalUID: "abc@google.com", visibility: "private", organizerSelf: true });
    expect(page.events[0]!.attendees).toEqual([
      { email: "ada@acme.test", responseStatus: "accepted", name: null, comment: null, self: true },
      { email: "bob@acme.test", responseStatus: "tentative", name: "Bob Rossi", comment: "arrivo tardi", self: false },
    ]);
    expect(page.events[1]).toMatchObject({ etag: null, iCalUID: null, visibility: "default", organizerSelf: false });
  });

  it("F5: gli allegati dell'evento (dove Gemini attacca gli appunti), coi soli campi che servono; assenti = []", async () => {
    const { impl } = fakeFetch([
      jsonResponse({
        items: [
          {
            id: "e1",
            summary: "Revisione",
            start: { dateTime: "2026-09-10T09:00:00Z" },
            attachments: [
              { fileUrl: "https://docs.google.com/document/d/doc1/edit", title: "Notes – Revisione", mimeType: "application/vnd.google-apps.document", fileId: "doc1", iconLink: "x" },
              { fileUrl: "https://example.com/x.pdf", title: "x.pdf" },
            ],
          },
          { id: "e2", summary: "Senza", start: { dateTime: "2026-09-11T09:00:00Z" } },
        ],
      }),
    ]);
    const page = await listEvents({ accessToken: "at" }, { fetchImpl: impl });
    expect(page.events[0]!.attachments).toEqual([
      { fileId: "doc1", title: "Notes – Revisione", mimeType: "application/vnd.google-apps.document", fileUrl: "https://docs.google.com/document/d/doc1/edit" },
      { fileId: null, title: "x.pdf", mimeType: null, fileUrl: "https://example.com/x.pdf" },
    ]);
    expect(page.events[1]!.attachments).toEqual([]);
  });

  it("F3b: eventType e transparency — assenti valgono default/opaque (le regole di Google), gli altri si portano come sono", async () => {
    const { impl } = fakeFetch([
      jsonResponse({
        items: [
          { id: "a", summary: "A", start: { dateTime: "2026-09-10T09:00:00Z" } },
          { id: "b", summary: "Ferie", start: { date: "2026-09-11" }, eventType: "outOfOffice", transparency: "transparent" },
        ],
      }),
    ]);
    const page = await listEvents({ accessToken: "at" }, { fetchImpl: impl });
    expect(page.events.map((e) => [e.eventType, e.transparency])).toEqual([
      ["default", "opaque"],
      ["outOfOffice", "transparent"],
    ]);
  });

  it("responseStatus assente o non riconosciuto → null, mai un valore inventato (fase 9, Task 2)", async () => {
    const { impl } = fakeFetch([
      jsonResponse({
        items: [
          {
            id: "e3",
            status: "confirmed",
            summary: "Revisione",
            start: { dateTime: "2026-09-10T09:00:00+02:00" },
            end: { dateTime: "2026-09-10T10:00:00+02:00" },
            attendees: [
              { email: "senza-stato@acme.test" },
              { email: "stato-ignoto@acme.test", responseStatus: "maybe" },
            ],
          },
        ],
      }),
    ]);
    const page = await listEvents({ accessToken: "at" }, { fetchImpl: impl });
    expect(page.events[0]!.attendees).toEqual([
      { email: "senza-stato@acme.test", responseStatus: null, name: null, comment: null, self: false },
      { email: "stato-ignoto@acme.test", responseStatus: null, name: null, comment: null, self: false },
    ]);
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
