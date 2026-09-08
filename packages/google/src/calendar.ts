/**
 * Google Calendar in sola lettura: `events.list` sul calendario `primary`, con
 * sincronizzazione incrementale via `syncToken`.
 *
 * La fase 6 non scrive mai sul calendario (design §2): da qui escono solo
 * eventi normalizzati, che diventano PROPOSTE di milestone da confermare con un
 * tap.
 */
import { z } from "zod";
import { buildUrl, parseGoogleJson, requestGoogle, type GoogleClientOptions } from "./fetch.js";

/** Base delle API Calendar. */
export const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/** Un evento normalizzato, nella forma che serve a `calendar_events`. */
export interface GoogleCalendarEvent {
  id: string;
  /** `confirmed | tentative | cancelled` (lo stesso CHECK della tabella). */
  status: string;
  /** `summary` di Google, mai null: un evento senza titolo è titolo vuoto. */
  title: string;
  description: string | null;
  /** True se l'evento è "tutto il giorno" (Google manda `date` invece di `dateTime`). */
  allDay: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  /** Email dei partecipanti, in minuscolo: sono ciò su cui il routing fa match. */
  attendees: string[];
  organizer: string | null;
  htmlLink: string | null;
  updatedAt: Date | null;
}

/** Una pagina di `events.list`. */
export interface CalendarEventsPage {
  events: GoogleCalendarEvent[];
  nextPageToken: string | null;
  /** Presente solo sull'ULTIMA pagina: è il punto di ripartenza del ciclo dopo. */
  nextSyncToken: string | null;
}

const dateSchema = z.object({ date: z.string().optional(), dateTime: z.string().optional() });

const eventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  start: dateSchema.optional(),
  end: dateSchema.optional(),
  attendees: z.array(z.object({ email: z.string().optional() })).optional(),
  organizer: z.object({ email: z.string().optional() }).optional(),
  htmlLink: z.string().optional(),
  updated: z.string().optional(),
});

const eventsListSchema = z.object({
  items: z.array(eventSchema).optional(),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
});

/** Converte una data ISO in Date, tollerando i valori che Google non manda. */
function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Normalizza un evento.
 *
 * Un evento "tutto il giorno" arriva come `date` (`2026-09-12`) senza fuso:
 * lo fissiamo a mezzanotte UTC perché `calendar_events.starts_at` è un
 * timestamptz e serve UN istante — la scelta è dichiarata qui invece di
 * lasciarla al fuso della macchina che esegue il worker, che varierebbe.
 */
function toEvent(raw: z.infer<typeof eventSchema>): GoogleCalendarEvent {
  const allDay = Boolean(raw.start?.date && !raw.start.dateTime);
  const startsAt = allDay ? toDate(`${raw.start?.date}T00:00:00.000Z`) : toDate(raw.start?.dateTime);
  const endsAt = allDay ? toDate(`${raw.end?.date}T00:00:00.000Z`) : toDate(raw.end?.dateTime);
  return {
    id: raw.id,
    status: raw.status ?? "confirmed",
    title: raw.summary ?? "",
    description: raw.description ?? null,
    allDay,
    startsAt,
    endsAt,
    attendees: (raw.attendees ?? [])
      .map((attendee) => attendee.email?.toLowerCase())
      .filter((email): email is string => Boolean(email)),
    organizer: raw.organizer?.email?.toLowerCase() ?? null,
    htmlLink: raw.htmlLink ?? null,
    updatedAt: toDate(raw.updated),
  };
}

/** Argomenti di `events.list`. */
export interface ListEventsInput {
  accessToken: string;
  /** Calendario da leggere (default `primary`: la casella collegata). */
  calendarId?: string;
  /** Punto di ripartenza incrementale: `google_accounts.calendar_sync_token`. */
  syncToken?: string | null;
  pageToken?: string | null;
  /** Finestra del PRIMO giro. Ignorati se c'è un `syncToken`. */
  timeMin?: Date | null;
  timeMax?: Date | null;
  maxResults?: number;
  showDeleted?: boolean;
}

/**
 * Una pagina di eventi.
 *
 * ⚠️ Due cose non negoziabili dell'API di Google, entrambe difese qui:
 *  - con un `syncToken` la finestra (`timeMin`/`timeMax`) NON si può mandare —
 *    Google risponde 400 —, quindi quando c'è il token la finestra viene
 *    semplicemente omessa invece di far scegliere al chiamante;
 *  - un **410** significa che il `syncToken` è troppo vecchio: diventa
 *    `sync_token_expired`, NON è fatale, e il poller riparte con un giro pieno.
 */
export async function listEvents(
  input: ListEventsInput,
  options: GoogleClientOptions = {},
): Promise<CalendarEventsPage> {
  const api = "calendar.events.list";
  const calendarId = input.calendarId ?? "primary";
  const incremental = Boolean(input.syncToken);
  const payload = await requestGoogle(
    {
      api,
      url: buildUrl(`${CALENDAR_API_BASE}/${encodeURIComponent(calendarId)}/events`, {
        singleEvents: "true",
        syncToken: input.syncToken ?? undefined,
        pageToken: input.pageToken ?? undefined,
        maxResults: input.maxResults,
        showDeleted: input.showDeleted === undefined ? undefined : String(input.showDeleted),
        timeMin: incremental ? undefined : (input.timeMin?.toISOString() ?? undefined),
        timeMax: incremental ? undefined : (input.timeMax?.toISOString() ?? undefined),
      }),
      accessToken: input.accessToken,
      statusCodes: { 410: "sync_token_expired" },
    },
    options,
  );
  const raw = parseGoogleJson(api, eventsListSchema, payload);
  return {
    events: (raw.items ?? []).map(toEvent),
    nextPageToken: raw.nextPageToken ?? null,
    nextSyncToken: raw.nextSyncToken ?? null,
  };
}
