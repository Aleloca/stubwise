import { randomUUID } from "node:crypto";
import { CALENDAR_API_BASE, parseCalendarEvent, type GoogleCalendarEvent } from "./calendar.js";
import { buildUrl, parseGoogleJson, requestGoogle, type GoogleClientOptions } from "./fetch.js";
import { z } from "zod";

/**
 * SCRIVERE SUL CALENDARIO (area 6, fetta 4): le chiamate a Google, e nient'altro.
 * Le fa SOLO una rotta chiamata da un gesto della persona.
 *
 * - Gli inviti li manda Google: `sendUpdates=all` su ogni scrittura (Q6,
 *   anche gli invitati esterni).
 * - Le modifiche portano l'etag in `If-Match`: un evento cambiato su Google
 *   nel frattempo risponde 412, che qui è `changed_on_google` (Q4: si
 *   rilegge e si rifà il gesto, non vince l'ultimo).
 * - Meet: `conferenceData.createRequest` con `conferenceDataVersion=1`.
 * - «Tutta la serie»: il chiamante scrive sull'evento PADRE
 *   (`recurringEventId`); spostarlo sposta ogni data con lo stesso scarto.
 */

const CHANGED = { 412: "changed_on_google" };

export interface CalendarGuest {
  email: string;
  name?: string | null;
}

export type CalendarReminders = { minutes: number; method: "popup" | "email" }[] | "default";

export interface NewCalendarEvent {
  /**
   * L'id scelto dal client (base32hex, 5–1024 caratteri): Riprova rimanda lo
   * stesso, e Google risponde 409 `duplicate` invece di creare una seconda
   * riunione con gli inviti mandati due volte (review F4).
   */
  id?: string;
  title: string;
  /** ISO con orario; per un tutto il giorno la data `YYYY-MM-DD` (fine esclusiva). */
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  guests: CalendarGuest[];
  description?: string | null;
  location?: string | null;
  addMeet: boolean;
  reminders: CalendarReminders;
}

export interface CalendarEventPatch {
  title?: string;
  startsAt?: string;
  endsAt?: string;
  allDay?: boolean;
  guests?: CalendarGuest[];
  description?: string | null;
  location?: string | null;
  addMeet?: boolean;
  reminders?: CalendarReminders;
}

function eventsUrl(calendarId: string, eventId?: string, query: Record<string, string> = {}): string {
  const path = `${CALENDAR_API_BASE}/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;
  return buildUrl(path, { sendUpdates: "all", ...query });
}

function when(value: string, allDay: boolean) {
  return allDay ? { date: value.slice(0, 10) } : { dateTime: value };
}

function remindersBody(reminders: CalendarReminders) {
  return reminders === "default" ? { useDefault: true } : { useDefault: false, overrides: reminders.map((r) => ({ minutes: r.minutes, method: r.method })) };
}

function guestsBody(guests: CalendarGuest[]) {
  return guests.map((g) => ({ email: g.email, ...(g.name ? { displayName: g.name } : {}) }));
}

const meetRequest = () => ({ createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } });

/** Una riunione nuova sul calendario principale della casella. */
export async function insertCalendarEvent(
  input: { accessToken: string; calendarId?: string; event: NewCalendarEvent },
  options: GoogleClientOptions = {},
): Promise<GoogleCalendarEvent> {
  const e = input.event;
  const api = "calendar.events.insert";
  const payload = await requestGoogle(
    {
      api,
      method: "POST",
      url: eventsUrl(input.calendarId ?? "primary", undefined, e.addMeet ? { conferenceDataVersion: "1" } : {}),
      accessToken: input.accessToken,
      statusCodes: { 409: "duplicate" },
      json: {
        ...(e.id ? { id: e.id } : {}),
        summary: e.title,
        ...(e.description ? { description: e.description } : {}),
        ...(e.location ? { location: e.location } : {}),
        start: when(e.startsAt, e.allDay),
        end: when(e.endsAt, e.allDay),
        attendees: guestsBody(e.guests),
        reminders: remindersBody(e.reminders),
        ...(e.addMeet ? { conferenceData: meetRequest() } : {}),
      },
    },
    options,
  );
  return parseCalendarEvent(api, payload);
}

/** Modifica (o sposta) un evento, sull'etag che il client ha letto. */
export async function patchCalendarEvent(
  input: { accessToken: string; calendarId?: string; eventId: string; etag: string | null; patch: CalendarEventPatch },
  options: GoogleClientOptions = {},
): Promise<GoogleCalendarEvent> {
  const p = input.patch;
  const allDay = p.allDay === true;
  const api = "calendar.events.patch";
  const payload = await requestGoogle(
    {
      api,
      method: "PATCH",
      url: eventsUrl(input.calendarId ?? "primary", input.eventId, p.addMeet ? { conferenceDataVersion: "1" } : {}),
      accessToken: input.accessToken,
      ...(input.etag ? { ifMatch: input.etag } : {}),
      statusCodes: CHANGED,
      json: {
        ...(p.title !== undefined ? { summary: p.title } : {}),
        ...(p.description !== undefined ? { description: p.description ?? "" } : {}),
        ...(p.location !== undefined ? { location: p.location ?? "" } : {}),
        ...(p.startsAt !== undefined ? { start: when(p.startsAt, allDay) } : {}),
        ...(p.endsAt !== undefined ? { end: when(p.endsAt, allDay) } : {}),
        ...(p.guests !== undefined ? { attendees: guestsBody(p.guests) } : {}),
        ...(p.reminders !== undefined ? { reminders: remindersBody(p.reminders) } : {}),
        ...(p.addMeet ? { conferenceData: meetRequest() } : {}),
      },
    },
    options,
  );
  return parseCalendarEvent(api, payload);
}

/** Elimina un evento (o la serie, sul padre). */
export async function deleteCalendarEvent(
  input: { accessToken: string; calendarId?: string; eventId: string; etag: string | null },
  options: GoogleClientOptions = {},
): Promise<void> {
  await requestGoogle(
    {
      api: "calendar.events.delete",
      method: "DELETE",
      url: eventsUrl(input.calendarId ?? "primary", input.eventId),
      accessToken: input.accessToken,
      ...(input.etag ? { ifMatch: input.etag } : {}),
      statusCodes: CHANGED,
      expectEmpty: true,
    },
    options,
  );
}

/**
 * La risposta di un invitato. Si mandano TUTTI gli invitati, con la sola
 * risposta (e nota) della casella cambiata: non ci si affida a come Google
 * fonderebbe un elenco parziale.
 */
export async function respondToCalendarEvent(
  input: {
    accessToken: string;
    calendarId?: string;
    eventId: string;
    etag: string | null;
    selfEmail: string;
    attendees: { email: string; responseStatus: string | null }[];
    response: "accepted" | "tentative" | "declined";
    note?: string | null;
  },
  options: GoogleClientOptions = {},
): Promise<GoogleCalendarEvent> {
  const self = input.selfEmail.toLowerCase();
  const api = "calendar.events.patch";
  const payload = await requestGoogle(
    {
      api,
      method: "PATCH",
      url: eventsUrl(input.calendarId ?? "primary", input.eventId),
      accessToken: input.accessToken,
      ...(input.etag ? { ifMatch: input.etag } : {}),
      statusCodes: CHANGED,
      json: {
        attendees: input.attendees.map((a) =>
          a.email.toLowerCase() === self
            ? { email: a.email, responseStatus: input.response, ...(input.note ? { comment: input.note } : {}) }
            : { email: a.email, ...(a.responseStatus ? { responseStatus: a.responseStatus } : {}) },
        ),
      },
    },
    options,
  );
  return parseCalendarEvent(api, payload);
}

/** L'evento intero, col suo etag: per una serie, il PADRE (la sua data d'inizio e la sua versione). */
export async function getCalendarEvent(
  input: { accessToken: string; calendarId?: string; eventId: string },
  options: GoogleClientOptions = {},
): Promise<GoogleCalendarEvent> {
  const api = "calendar.events.get";
  const url = `${CALENDAR_API_BASE}/${encodeURIComponent(input.calendarId ?? "primary")}/events/${encodeURIComponent(input.eventId)}`;
  const payload = await requestGoogle({ api, url, accessToken: input.accessToken, statusCodes: { 404: "event_gone", 410: "event_gone" } }, options);
  return parseCalendarEvent(api, payload);
}

const instancesPageSchema = z.object({ items: z.array(z.unknown()).optional(), nextPageToken: z.string().optional() });

/**
 * Le date di una serie fra `timeMin` e `timeMax` (`events.instances`): dopo una
 * scrittura su «tutta la serie» il server riscrive le righe da qui, perché
 * spostare una serie cambia gli id delle sue date.
 */
export async function listEventInstances(
  input: { accessToken: string; calendarId?: string; eventId: string; timeMin: Date; timeMax: Date },
  options: GoogleClientOptions = {},
): Promise<GoogleCalendarEvent[]> {
  const api = "calendar.events.instances";
  const path = `${CALENDAR_API_BASE}/${encodeURIComponent(input.calendarId ?? "primary")}/events/${encodeURIComponent(input.eventId)}/instances`;
  const events: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const payload = await requestGoogle(
      {
        api,
        url: buildUrl(path, { timeMin: input.timeMin.toISOString(), timeMax: input.timeMax.toISOString(), maxResults: 250, pageToken }),
        accessToken: input.accessToken,
      },
      options,
    );
    const page = parseGoogleJson(api, instancesPageSchema, payload);
    for (const item of page.items ?? []) events.push(parseCalendarEvent(api, item));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return events;
}
