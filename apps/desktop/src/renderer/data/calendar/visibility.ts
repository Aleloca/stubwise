import { CALENDAR_LOOKBACK_DAYS, CALENDAR_WINDOW_DAYS } from "@stubwise/shared";
import { daysFromToday } from "../seed/dates";
import { state } from "../store";
import type { CalendarEvent, CalendarSeries } from "../types";
import { activeParticipants } from "./proposals";

// Chi vede che cosa nel Calendario (area 6): UNA regola, per ogni lettura e
// ogni scrittura. Un evento lo vede chi lo ha nel proprio calendario o è fra
// gli invitati; per gli altri non esiste (R-G5: `not_found`, mai
// `forbidden`). E Stubwise legge solo la FINESTRA `oggi − 30 → oggi + 60`
// giorni (`CALENDAR_LOOKBACK_DAYS`/`CALENDAR_WINDOW_DAYS` di
// `@stubwise/shared`): un'occorrenza fuori finestra c'è su Google, ma qui
// non si legge né si tocca. Modificare, spostare ed eliminare è
// dell'organizzatore; gli altri cambiano solo la propria risposta.

/**
 * La finestra letta, a giorni interi UTC: dall'inizio del giorno di 30 giorni
 * fa alla fine di quello fra 60 (oggi 23 ottobre → 23 settembre – 22
 * dicembre compresi). `to` è esclusa.
 *
 * I giorni interi sono DELIBERATI, non `now ± giorni` al minuto come il
 * poller del web: lo shape del Calendario mostra e promette «Sep 23 – Dec
 * 22» («Stubwise can schedule up to Dec 22»), e un bordo a mezzogiorno
 * taglierebbe a metà il primo e l'ultimo giorno. UTC perché la finestra è
 * una sola per tutti, non dipende dal fuso di chi guarda.
 */
export function calendarWindow(): { from: string; to: string } {
  return {
    from: `${daysFromToday(-CALENDAR_LOOKBACK_DAYS)}T00:00:00Z`,
    to: `${daysFromToday(CALENDAR_WINDOW_DAYS + 1)}T00:00:00Z`,
  };
}

/**
 * L'evento tocca la finestra letta. Il confronto è per ISTANTI, a
 * differenza di `spanOf` in `reads.ts` (che legge un «tutto il giorno» nei
 * giorni locali di chi guarda): i bordi della finestra sono mezzanotti UTC
 * e un «tutto il giorno» è salvato a mezzanotte UTC della sua data, quindi
 * qui istante e data coincidono e il fuso di chi guarda non c'entra.
 */
export function inWindow(e: Pick<CalendarEvent, "startsAt" | "endsAt">): boolean {
  const w = calendarWindow();
  return Date.parse(e.startsAt) < Date.parse(w.to) && Date.parse(e.endsAt) > Date.parse(w.from);
}

/** Chi guarda ha l'evento nel suo calendario o ne è un invitato. */
export const canSeeEvent = (me: string, e: CalendarEvent): boolean =>
  e.calendarPersonIds.includes(me) || e.attendees.some((a) => a.personId === me);

/** Un evento che chi guarda legge: lo vede ed è dentro la finestra. */
export const canReadEvent = (me: string, e: CalendarEvent): boolean =>
  canSeeEvent(me, e) && inWindow(e);

/** Gli eventi che chi guarda legge. */
export const readableEvents = (me: string): CalendarEvent[] =>
  state.calendarEvents.filter((e) => canReadEvent(me, e));

/**
 * L'organizzatore: l'invitato segnato come tale; un evento senza invitati è
 * di chi lo ha in calendario.
 */
export function isOrganizer(me: string, e: CalendarEvent): boolean {
  if (e.attendees.length === 0) return e.calendarPersonIds.includes(me);
  return e.attendees.some((a) => a.organizer && a.personId === me);
}

/**
 * Una serie la vede chi vede almeno una delle sue date, anche fuori dalla
 * finestra: una serie senza date nella finestra resta fra le serie.
 */
export const canSeeSeries = (me: string, s: CalendarSeries): boolean =>
  state.calendarEvents.some((e) => e.seriesId === s.id && canSeeEvent(me, e));

/**
 * I partecipanti in Stubwise di un evento che non l'hanno rifiutato: chi
 * vede una sua proposta (con l'essere membro del progetto). Un evento che
 * non c'è (o fuori finestra) non ha partecipanti.
 */
export function eventParticipants(eventId: string): string[] {
  const e = state.calendarEvents.find((x) => x.id === eventId);
  return e && inWindow(e) ? activeParticipants(e) : [];
}
