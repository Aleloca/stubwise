// L'orologio della build «app» (`@backend/clock`), con le firme di
// `data/seed/dates.ts`: lì «oggi» è fisso, qui è la data LOCALE di chi guarda,
// fissata al caricamento della finestra (come il prototipo, «oggi» non
// cambia mentre la pagina è aperta).
import { addDaysIso } from "../../clockMath";

export { isoWeek } from "../../clockMath";

function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const started = new Date();

/** La data locale di oggi (YYYY-MM-DD). */
export const TODAY = localIsoDate(started);

/** L'istante in cui la finestra è partita (ISO). */
export const CLOCK_START = started.toISOString();

/** Data ISO (YYYY-MM-DD) a `days` giorni da `TODAY` (negativi = passato). */
export function daysFromToday(days: number): string {
  return addDaysIso(TODAY, days);
}
