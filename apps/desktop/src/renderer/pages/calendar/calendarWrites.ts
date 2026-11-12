import { featureIntegrated } from "../../data/integration";
import type { CalendarEventView } from "../../data/types";

// Cosa il Calendario può fare oltre a leggere, in questa build. Nel prototipo
// tutto; nella build app (area 6, fetta 1) solo leggere e configurare le
// serie: i gesti che scrivono su Google (nuova riunione, sposta, modifica,
// elimina, rispondi, progetto a mano) sono della F4, il riassunto e le task
// di una riunione della F5; «Aggiorna ora» c'è dalla F1.2. Nascosti, come le
// altre parti non integrate (decisione dell'orchestratrice).

/** Scrivere sul calendario (F4). */
export const calendarWrites = (): boolean => featureIntegrated("calendar-write");

/**
 * L'evento si sposta, si modifica e si elimina da qui: lo dice il server
 * (`canEdit`, F4), altrimenti dall'organizzatore; e la build scrive.
 */
export const canEditEvent = (e: Pick<CalendarEventView, "isOrganizer" | "canEdit">): boolean =>
  (e.canEdit ?? e.isOrganizer) && calendarWrites();

/** Rispondo da qui (Sì / Forse / No): lo dice il server (`canRespond`), altrimenti invitato e non organizzatore. */
export const canRespondTo = (
  e: Pick<CalendarEventView, "isOrganizer" | "canRespond" | "myResponse">,
): boolean => (e.canRespond ?? (e.myResponse !== null && !e.isOrganizer)) && calendarWrites();

/** «Aggiorna ora» di una casella (F1.2). */
export const googleSync = (): boolean => featureIntegrated("google-sync");

/** Il riassunto e le task di una riunione registrata (F5). */
export const meetingNotes = (): boolean => featureIntegrated("meeting-notes");

/**
 * Due orari si confrontano come ISTANTI (review F4, 2): il server li scrive
 * a modo suo (senza millisecondi, col fuso), e una stringa diversa per lo
 * stesso istante faceva partire una move inutile.
 */
export const sameInstant = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);

export const sameSpan = (
  a: { startsAt: string; endsAt: string },
  b: { startsAt: string; endsAt: string },
): boolean => sameInstant(a.startsAt, b.startsAt) && sameInstant(a.endsAt, b.endsAt);
