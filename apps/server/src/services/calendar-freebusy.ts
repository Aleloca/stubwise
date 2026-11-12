import { calendarEvents, googleAccounts, users, type Db } from "@stubwise/db";
import type { CalendarFreeBusyPerson } from "@stubwise/shared";
import { myAttendee } from "./calendar-writes.js";
import { and, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";

/**
 * IL LIBERO/OCCUPATO DEI COLLEGHI (area 6, F4, task 5; D8 = b, fonte Q3 = a).
 *
 * ⚠️ È un'ECCEZIONE DICHIARATA a «Posta e Calendario personali»
 * (`docs/invariants/mail-calendar.md`): chiunque nell'istanza lo legge *(O,
 * 46)*, per organizzare una riunione. Il perimetro, e non si allarga:
 * - escono SOLO `personId`, `availability` e gli intervalli
 *   (`startsAt`/`endsAt`) — mai un titolo, un luogo, un invitato, un id di
 *   evento o di casella, nemmeno di un evento `private` (occupa, e basta);
 * - gli intervalli sono FUSI: non si conta nemmeno quanti eventi ci sono;
 * - solo i colleghi col calendario COLLEGATO in Stubwise (`not_connected`
 *   senza casella, `expired` con le caselle tutte disattivate);
 * - dalle righe di `calendar_events` già salvate: NESSUNA chiamata a Google
 *   (niente freeBusy di Google, cambio esplicito di D8 con Q3 = a).
 *
 * Occupa un evento con orario, non cancellato, non `transparent` (una riga di
 * prima senza trasparenza vale `opaque`, il default di Google), che la
 * casella non ha rifiutato. Un tutto il giorno non occupa (prototipo); un
 * fuori ufficio sì.
 */

export const FREEBUSY_MAX_PEOPLE = 50;
export const FREEBUSY_MAX_DAYS = 31;

export async function freeBusyOf(db: Db, personIds: string[], from: Date, to: Date): Promise<CalendarFreeBusyPerson[]> {
  if (personIds.length === 0) return [];
  const accounts = await db
    .select({ userId: googleAccounts.userId, disabledAt: googleAccounts.disabledAt })
    .from(googleAccounts)
    .innerJoin(users, eq(users.id, googleAccounts.userId))
    .where(and(inArray(googleAccounts.userId, personIds), eq(users.isAgent, false)));
  const rows = await db
    .select({ userId: googleAccounts.userId, accountEmail: googleAccounts.email, startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, attendees: calendarEvents.attendees })
    .from(calendarEvents)
    .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
    .where(
      and(
        inArray(googleAccounts.userId, personIds),
        isNull(googleAccounts.disabledAt),
        eq(calendarEvents.allDay, false),
        isNotNull(calendarEvents.endsAt),
        sql`${calendarEvents.status} is distinct from 'cancelled'`,
        sql`coalesce(${calendarEvents.transparency}, 'opaque') <> 'transparent'`,
        lt(calendarEvents.startsAt, to),
        gt(calendarEvents.endsAt, from),
      ),
    );

  const intervals = new Map<string, [number, number][]>();
  for (const row of rows) {
    // La risposta della casella come la leggono le scritture: `self` prima (review F4, punto 7).
    if (myAttendee(row.attendees, row.accountEmail)?.responseStatus === "declined") continue;
    const start = Math.max(row.startsAt.getTime(), from.getTime());
    const end = Math.min(row.endsAt!.getTime(), to.getTime());
    if (end <= start) continue;
    const list = intervals.get(row.userId) ?? [];
    list.push([start, end]);
    intervals.set(row.userId, list);
  }

  return [...new Set(personIds)].map((personId) => {
    const own = accounts.filter((a) => a.userId === personId);
    if (own.length === 0) return { personId, availability: "not_connected" as const, busy: [] };
    if (own.every((a) => a.disabledAt !== null)) return { personId, availability: "expired" as const, busy: [] };
    return { personId, availability: "connected" as const, busy: merge(intervals.get(personId) ?? []) };
  });
}

/** Fonde gli intervalli che si sovrappongono o si toccano. */
function merge(list: [number, number][]): { startsAt: string; endsAt: string }[] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out.map(([s, e]) => ({ startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString() }));
}
