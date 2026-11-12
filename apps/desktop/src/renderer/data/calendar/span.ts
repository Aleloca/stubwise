import type { CalendarEvent } from "../types";

// L'intervallo che un evento occupa per chi guarda: puro, senza lo stato del
// prototipo, così lo usa anche la build app (`backend/real/calendar.ts`). I
// fusi seguono `calendar-grid` di `@stubwise/shared`: un evento con orario è
// un intervallo di istanti (letto nel fuso locale), uno «tutto il giorno» è
// una DATA — copre i giorni locali con la stessa data, ovunque sia chi guarda.

/** La mezzanotte LOCALE della data UTC di un istante: il giorno di un «tutto il giorno». */
function localDateOf(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** L'intervallo (in ms) che l'evento occupa per chi guarda. */
export function spanOf(e: Pick<CalendarEvent, "startsAt" | "endsAt" | "allDay">): {
  from: number;
  to: number;
} {
  if (!e.allDay) return { from: Date.parse(e.startsAt), to: Date.parse(e.endsAt) };
  return { from: localDateOf(e.startsAt).getTime(), to: localDateOf(e.endsAt).getTime() };
}
