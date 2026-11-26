import { startOfLocalDay } from "@stubwise/shared";

// «Trova un orario» (area 6): la regola PURA, una sola per il prototipo e per
// la build app (che la calcola dal libero/occupato del server, D8 = b, F4).
// Il primo spazio di `durationMin` minuti libero per tutti nella giornata
// locale di `from`, a passi di 15′, non prima di `from`, fra le 8 e le 20.

/** «Trova un orario» cerca fra queste ore (locali) della giornata. */
export const FREE_SLOT_HOURS = { from: 8, to: 20 } as const;

const STEP_MS = 15 * 60_000;

/** Un istante nel formato del seme (`…T09:15:00Z`, senza millisecondi). */
export const isoAt = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export interface BusyInterval {
  startsAt: string;
  endsAt: string;
}

/** Il primo spazio libero per tutti, o `null` se nella giornata non ce n'è. */
export function firstFreeSlot(
  busy: readonly BusyInterval[],
  durationMin: number,
  start: Date,
): { startsAt: string; endsAt: string } | null {
  const dayStart = startOfLocalDay(start);
  const open = new Date(dayStart);
  open.setHours(FREE_SLOT_HOURS.from);
  const close = new Date(dayStart);
  close.setHours(FREE_SLOT_HOURS.to);
  const duration = durationMin * 60_000;
  let at = Math.ceil(Math.max(start.getTime(), open.getTime()) / STEP_MS) * STEP_MS;
  for (; at + duration <= close.getTime(); at += STEP_MS) {
    const end = at + duration;
    if (busy.every((b) => Date.parse(b.endsAt) <= at || Date.parse(b.startsAt) >= end)) {
      return { startsAt: isoAt(at), endsAt: isoAt(end) };
    }
  }
  return null;
}
