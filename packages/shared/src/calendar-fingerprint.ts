/**
 * L'IMPRONTA di un appuntamento (giorno UTC + titolo normalizzato) e l'esito
 * di una riga chiusa perché l'appuntamento è cancellato.
 *
 * Stavano solo nel worker (`apps/worker/src/google/calendar.ts`, che le
 * ri-esporta): dalla F4 anche il SERVER scrive righe di `calendar_events`
 * (una riunione nuova, una serie spostata, un evento eliminato), e la stessa
 * riga deve avere la stessa impronta chiunque la scriva — la dedup del poller
 * ci si appoggia. Il ragionamento sull'UTC e sull'orario escluso è nel
 * docblock del worker.
 */
export function computeCalendarFingerprint(title: string | null | undefined, startsAt: Date): string {
  const day = startsAt.toISOString().slice(0, 10);
  const normalized = (title ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${day} ${normalized}`;
}

/** L'esito di una riga CHIUSA perché l'appuntamento è stato cancellato. */
export const CALENDAR_CANCELLED_OUTCOME = { type: "cancelled" } as const;
