/**
 * Le settimane ISO 8601 delle task (`YYYY-Www`), COPIA di
 * `packages/shared/src/tasks/weeks.ts` (con `isoWeekOf` di `stall.ts`):
 * il pacchetto pubblicato dipende a runtime solo dalle sue `dependencies`, e
 * `@stubwise/shared` non è fra queste (revisione finale della parità MCP,
 * C1). `weeks.test.ts` le confronta con l'originale: chi cambia quello rifà
 * questa copia.
 */

/** Il fuso della «settimana corrente»: quello del giro notturno. */
const WEEK_TIME_ZONE = "Europe/Rome";

const DAY_MS = 86_400_000;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Il lunedì (data ISO) di una settimana `YYYY-Www`. Il 4 gennaio è sempre nella W01. */
function isoWeekToMonday(week: string): string {
  const match = WEEK_RE.exec(week);
  if (!match) throw new Error(`settimana ISO non valida: ${week}`);
  const [, y, w] = match;
  const jan4 = new Date(Date.UTC(Number(y), 0, 4));
  const dow = jan4.getUTCDay() || 7;
  return isoDay(new Date(jan4.getTime() - (dow - 1) * DAY_MS + (Number(w) - 1) * 7 * DAY_MS));
}

/** La settimana `YYYY-Www` di una data ISO (non per forza un lunedì). */
export function mondayToIsoWeek(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // giovedì della settimana
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Una stringa `YYYY-Www` che esiste davvero (2027 non ha la W53). */
export function isIsoWeek(value: unknown): value is string {
  if (typeof value !== "string" || !WEEK_RE.test(value)) return false;
  const n = Number(value.slice(6));
  if (n < 1 || n > 53) return false;
  return mondayToIsoWeek(isoWeekToMonday(value)) === value;
}

export function addWeeks(week: string, n: number): string {
  const monday = Date.parse(`${isoWeekToMonday(week)}T00:00:00Z`);
  return mondayToIsoWeek(isoDay(new Date(monday + n * 7 * DAY_MS)));
}

/** La settimana corrente all'istante `now`, nel fuso {@link WEEK_TIME_ZONE}. */
export function currentIsoWeek(now: Date): string {
  // `en-CA` formatta come YYYY-MM-DD.
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: WEEK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return mondayToIsoWeek(local);
}
