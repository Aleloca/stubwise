// Il seme del Calendario (area 6): gli eventi (singoli e delle serie), le
// serie con la loro configurazione, l'allineamento di ogni calendario e le
// proposte che nascono dagli eventi (solo le scadenze future).
import { deadlineProposal } from "../../calendar/deadlines";
import type { CalendarEvent, CalendarSync, MailProposal } from "../../types";
import { TODAY } from "../dates";
import { at, person } from "../mail/helpers";
import { SINGLE_EVENTS } from "./events";
import { SERIES_EVENTS } from "./series";

export { CALENDAR_CASES } from "./events";
export { CALENDAR_SERIES, SERIES_IDS } from "./series";

/** In ordine di inizio. */
export const CALENDAR_EVENTS: CalendarEvent[] = [...SINGLE_EVENTS, ...SERIES_EVENTS].sort(
  (a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id),
);

/**
 * L'allineamento dei calendari, uno per account Google (area 5), come le
 * caselle: Giulia aggiornata da due minuti, Matteo da dodici (vecchio),
 * Laura col collegamento scaduto.
 */
export const CALENDAR_SYNC: CalendarSync[] = [
  { personId: "p-giulia", email: person("p-giulia").email, syncedAt: at(0, "11:58"), sync: "ok" },
  { personId: "p-matteo", email: person("p-matteo").email, syncedAt: at(0, "11:48"), sync: "ok" },
  {
    personId: "p-laura",
    email: person("p-laura").email,
    syncedAt: at(5, "08:00"),
    sync: "failed",
  },
];

/** Le proposte del calendario, nate alla lettura del mattino (07:00). */
export const CALENDAR_PROPOSALS: MailProposal[] = CALENDAR_EVENTS.flatMap((e) => {
  const p = deadlineProposal(e, `${TODAY}T12:00:00Z`);
  return p ? [{ ...p, createdAt: at(0, "07:00") }] : [];
});
