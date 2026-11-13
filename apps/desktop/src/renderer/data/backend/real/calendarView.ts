import type { CalendarEventItem, CalendarSeriesItem } from "@stubwise/shared";
import type {
  CalendarAttendee,
  CalendarEventView,
  CalendarSeries,
  CalendarSeriesView,
} from "../../types";
import { session } from "./client";

// Le righe del Calendario come le legge la pagina (area 6, F1, F3b, F4):
// un evento e una serie del server nella vista del prototipo. A sé, perché la
// usano sia le letture (`calendar.ts`) sia le scritture (`calendarWrites.ts`),
// e un import fra quei due moduli sarebbe circolare.

const DAY_MS = 86_400_000;

/**
 * L'id di una serie nell'app: casella + id della serie su Google, uniti da
 * `_` (passa per l'indirizzo, `?series=`). L'id di Google da solo non basta:
 * la stessa serie su due caselle mie ha lo stesso.
 */
export const seriesIdOf = (accountId: string, recurringEventId: string) =>
  `${accountId}_${recurringEventId}`;

/** Le azioni di una serie: il vocabolario del prototipo e quello del server. */
const ACTION_OF_SERVER = {
  milestone: "milestone",
  backlog_item: "request",
  reminder: "remind",
} as const satisfies Record<CalendarSeriesItem["action"], CalendarSeries["action"]>;
export const ACTION_TO_SERVER = {
  milestone: "milestone",
  request: "backlog_item",
  remind: "reminder",
} as const satisfies Record<CalendarSeries["action"], CalendarSeriesItem["action"]>;

const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * Un appuntamento visto, come lo legge chi guarda. Il server non sa i nomi né
 * le persone degli invitati: il nome è l'indirizzo, la persona sono io solo
 * sul mio indirizzo. Senza fine (righe vecchie): un «tutto il giorno» dura il
 * suo giorno, uno con orario resta un istante — nessuna durata inventata.
 */
/**
 * I campi della F3b (piano di 72, tutti additivi), letti con la difesa per un
 * server che non li manda: lo schema li porterà con `.default()`, ma la build
 * web non parsa (`as`), quindi la difesa sta qui.
 */
type F3bFields = {
  canEdit?: boolean;
  canRespond?: boolean;
  recognized?: boolean;
  projectBy?: "rules" | "model" | "manual" | null;
  eventType?: string;
  transparency?: "opaque" | "transparent";
  myResponse?: CalendarAttendee["response"] | null;
};

/** Chi ha deciso il progetto: le regole e il modello sono un suggerimento di Stubwise. */
function projectByOf(e: CalendarEventItem & F3bFields): CalendarEventView["projectBy"] {
  if (e.projectBy === "manual") return "manual";
  if (e.projectBy === "rules" || e.projectBy === "model") return "model";
  // Un server di prima non lo dice (e lo schema dà `null`; anche le righe prima della
  // F3b): un progetto c'era solo se lo aveva messo Stubwise.
  return e.projectId === null ? null : "model";
}

export function eventView(raw: CalendarEventItem): CalendarEventView {
  const e = raw as CalendarEventItem & F3bFields;
  const me = session.personId ?? "";
  const endsAt =
    e.endsAt ?? (e.allDay ? new Date(Date.parse(e.startsAt) + DAY_MS).toISOString() : e.startsAt);
  const isOrganizer = e.organizer === null || same(e.organizer, e.accountEmail);
  const recognized = e.recognized ?? true;
  const by = projectByOf(e);
  // `range` è leggero (F3b): invitati, descrizione e promemoria solo in `event(id)`.
  const attendees = (e.attendees ?? []).map<CalendarAttendee>((a) => ({
    email: a.email,
    name: a.email,
    personId: same(a.email, e.accountEmail) ? me : null,
    response: a.responseStatus ?? "needsAction",
    organizer: same(e.organizer, a.email),
  }));
  // Sulla riga leggera la dice il server; altrimenti dagli invitati.
  const myResponse =
    e.myResponse ?? attendees.find((a) => a.personId === me && me !== "")?.response ?? null;
  return {
    id: e.id,
    calendarPersonIds: [me],
    title: e.title ?? "",
    description: e.descriptionText ?? null,
    startsAt: e.startsAt,
    endsAt,
    allDay: e.allDay,
    location: e.location,
    meetUrl: e.hangoutLink,
    attendees,
    reminders: e.remindersUseDefault
      ? "default"
      : (e.reminders ?? []).map((r) => ({
          minutes: r.minutes,
          method: r.method === "email" ? "email" : "popup",
        })),
    seriesId: e.recurringEventId === null ? null : seriesIdOf(e.accountId, e.recurringEventId),
    // Un evento personale (non riconosciuto) non ha un suggerimento: «No project»,
    // salvo un progetto messo a mano.
    projectId: recognized || by === "manual" ? e.projectId : null,
    projectBy: recognized || by === "manual" ? by : null,
    recognized,
    eventType: e.eventType ?? "default",
    transparency: e.transparency === "transparent" ? "transparent" : "opaque",
    attendeeCount: e.attendeeCount ?? null,
    // F4: chi modifica e chi risponde lo dice il server. Lo schema condiviso dà
    // `false` a un server di prima (c7c5b714 di 72), che infatti non scrive; il
    // ripiego dall'organizzatore vale solo per una riga letta senza schema.
    canEdit: e.canEdit ?? isOrganizer,
    canRespond: e.canRespond ?? (!isOrganizer && myResponse !== null),
    googleUrl: e.eventUrl ?? e.url,
    myResponse,
    isOrganizer,
    calendarEmail: e.accountEmail,
    // La scheda di preparazione la decide il SERVER (F5a: futuro, con un
    // progetto che chi guarda vede); un server di prima non la manda.
    hasPrep: e.hasPrep ?? false,
  };
}

export function seriesView(s: CalendarSeriesItem): CalendarSeriesView {
  return {
    id: seriesIdOf(s.accountId, s.recurringEventId),
    title: s.title ?? "",
    // La regola sta sulle occorrenze, non sulla serie: senza, «a parole» non si dice.
    rule: "",
    projectId: s.projectId,
    enabled: s.enabled,
    action: ACTION_OF_SERVER[s.action],
    leadDays: s.leadDays,
    auto: s.auto,
    occurrencesInWindow: s.occurrenceCount,
    nextAt: s.nextOccurrenceAt,
    recognized: (s as CalendarSeriesItem & { recognized?: boolean }).recognized ?? true,
  };
}

/** Le serie: prima quelle di lavoro (F3b), poi per titolo. */
export const bySeries = (a: CalendarSeriesView, b: CalendarSeriesView) =>
  Number(b.recognized !== false) - Number(a.recognized !== false) ||
  a.title.localeCompare(b.title) ||
  a.id.localeCompare(b.id);
