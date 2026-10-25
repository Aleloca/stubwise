// Il Calendario (area 6) come lo espone `api.ts`: `api.calendar.<funzione>`.
// Chi vede che cosa lo decide `canSeeEvent` (visibility.ts), dentro la
// finestra letta; modifica, spostamento ed eliminazione sono
// dell'organizzatore. Le proposte del calendario sono proposte della Posta
// (`source: "calendar"`): si leggono e si decidono con `api.mail`.
export {
  CALENDAR_STALE_MS,
  findFirstFreeSlot,
  FREE_SLOT_HOURS,
  freeBusy,
  getEvent,
  listCalendars,
  listEvents,
  listSeries,
  listUpcomingEvents,
} from "./reads";
export {
  configureSeries,
  createEvent,
  deleteEvent,
  moveEvent,
  respond,
  retrySave,
  revertEvent,
  setEventProject,
  syncCalendar,
  updateEvent,
  whenCalendarIdle,
} from "./writes";
export { calendarWindow } from "./visibility";
