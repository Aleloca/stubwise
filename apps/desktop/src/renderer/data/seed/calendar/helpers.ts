import type { CalendarAttendee, CalendarEvent, Rsvp } from "../../types";
import { daysFromToday } from "../dates";
import { person } from "../mail/helpers";

/** Istante ISO del giorno a `days` da oggi (negativi = passato), all'ora `hm` UTC. */
export const on = (days: number, hm: string): string => `${daysFromToday(days)}T${hm}:00Z`;

/** Mezzanotte UTC del giorno a `days` da oggi: la data di un evento «tutto il giorno». */
export const day = (days: number): string => `${daysFromToday(days)}T00:00:00Z`;

/** Un invitato del team, con la sua risposta. */
export function guest(
  personId: string,
  response: Rsvp = "accepted",
  organizer = false,
): CalendarAttendee {
  const a = person(personId);
  return { email: a.email, name: a.name, personId, response, organizer };
}

/** L'organizzatore del team (ha accettato per definizione). */
export const organizer = (personId: string): CalendarAttendee => guest(personId, "accepted", true);

/** Un invitato fuori dal team. */
export function outsider(
  name: string,
  email: string,
  response: Rsvp = "accepted",
  isOrganizer = false,
): CalendarAttendee {
  return { email, name, personId: null, response, organizer: isOrganizer };
}

type Essentials = Pick<
  CalendarEvent,
  "id" | "calendarPersonIds" | "title" | "startsAt" | "endsAt" | "attendees"
>;

/** Un evento con i default del seme: con orario, senza luogo, Meet, serie né progetto. */
export function event(e: Essentials & Partial<CalendarEvent>): CalendarEvent {
  return {
    description: null,
    allDay: false,
    location: null,
    meetUrl: null,
    reminders: "default",
    seriesId: null,
    projectId: null,
    projectBy: e.projectId ? "model" : null,
    ...e,
  };
}
