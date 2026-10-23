/** "Oggi" fisso del prototipo: i dati e i test non dipendono dall'orologio. */
export const TODAY = "2026-10-23";

/** Data ISO (YYYY-MM-DD) a `days` giorni da `TODAY` (negativi = passato). */
export function daysFromToday(days: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Settimana ISO 8601 di una data ISO, nel formato "2026-W43". */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // giovedì della settimana
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
