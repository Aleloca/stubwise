import { featureIntegrated } from "../../data/integration";
import type { CalendarEventView } from "../../data/types";

// Cosa il Calendario può fare oltre a leggere, in questa build. Nel prototipo
// tutto; nella build app (area 6, fetta 1) solo leggere e configurare le
// serie: i gesti che scrivono su Google (nuova riunione, sposta, modifica,
// elimina, rispondi, progetto a mano) sono della F4, «Aggiorna ora» della
// F1.2, il riassunto e le task di una riunione della F5. Nascosti, come le
// altre parti non integrate (decisione dell'orchestratrice).

/** Scrivere sul calendario (F4). */
export const calendarWrites = (): boolean => featureIntegrated("calendar-write");

/** L'evento si sposta, si modifica e si elimina da qui: è mio e la build scrive. */
export const canEditEvent = (e: Pick<CalendarEventView, "isOrganizer">): boolean =>
  e.isOrganizer && calendarWrites();

/** «Aggiorna ora» di una casella (F1.2). */
export const googleSync = (): boolean => featureIntegrated("google-sync");

/** Il riassunto e le task di una riunione registrata (F5). */
export const meetingNotes = (): boolean => featureIntegrated("meeting-notes");
