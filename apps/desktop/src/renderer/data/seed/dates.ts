import { addDaysIso } from "../clockMath";

export { isoWeek } from "../clockMath";

/** "Oggi" fisso del prototipo: i dati e i test non dipendono dall'orologio. */
export const TODAY = "2026-10-23";

/**
 * L'«adesso» da cui parte l'orologio del prototipo: mezzogiorno di `TODAY`.
 * È l'unico (orologio unico): `now()` dello store parte da qui, e i tempi
 * del seme che dicono un'età si scrivono all'indietro da qui, mai dopo.
 */
export const CLOCK_START = `${TODAY}T12:00:00Z`;

/** Data ISO (YYYY-MM-DD) a `days` giorni da `TODAY` (negativi = passato). */
export function daysFromToday(days: number): string {
  return addDaysIso(TODAY, days);
}
