import { CALENDAR_LOOKBACK_DAYS, CALENDAR_WINDOW_DAYS, startOfMonth } from "@stubwise/shared";

/**
 * I BORDI della navigazione fra i mesi (App M3, Fase D, Task 11 — design
 * §6).
 *
 * Il calendario dell'app mostra solo ciò che il poller ha ingerito, e il
 * poller guarda una finestra sola: da `CALENDAR_LOOKBACK_DAYS` giorni
 * indietro a `CALENDAR_WINDOW_DAYS` avanti (`@stubwise/shared`, usata
 * operativamente da `apps/worker/src/google/calendar.ts`). Fuori di lì un
 * mese è vuoto **non perché non ci siano impegni**, ma perché lì Stubwise
 * non ha guardato — e una griglia che lasciasse scorrere all'infinito
 * mostrerebbe mesi vuoti indistinguibili da un guasto.
 *
 * Quindi la navigazione si ferma, e al bordo la pagina dice perché. Queste
 * funzioni rispondono alle due domande che servono a dirlo: «posso andare
 * ancora in quella direzione?» e «da quando a quando Stubwise guarda?».
 *
 * ⚠️ **Fermare la navigazione è una scelta dell'APP, non del web**: la
 * pagina `/calendar` del sito lascia navigare ovunque (design fase 9). Non è
 * un'incoerenza da appianare in un senso o nell'altro senza una decisione:
 * su un telefono lo spazio per spiegare un mese vuoto non c'è, e un dito
 * scorre più in fretta di un click.
 *
 * `now` è iniettabile per i test, stesso pattern di `relativeTimeCompact`.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface IngestionWindow {
  /** Il primo istante che il poller guarda (`now − CALENDAR_LOOKBACK_DAYS`). */
  from: Date;
  /** L'ultimo istante che il poller guarda (`now + CALENDAR_WINDOW_DAYS`). */
  to: Date;
}

export function ingestionWindow(now: Date = new Date()): IngestionWindow {
  return {
    from: new Date(now.getTime() - CALENDAR_LOOKBACK_DAYS * MS_PER_DAY),
    to: new Date(now.getTime() + CALENDAR_WINDOW_DAYS * MS_PER_DAY),
  };
}

/**
 * Si può spostare l'ancora di un mese in quella direzione restando dentro la
 * finestra?
 *
 * Il confronto è fra MESI, non fra istanti: un mese è raggiungibile se
 * INTERSECA la finestra anche solo per un giorno — il mese di `from` e
 * quello di `to` sono raggiungibili, quelli oltre no. Altrimenti, con una
 * finestra che finisce a metà novembre, novembre sarebbe irraggiungibile e
 * metà dei suoi eventi invisibili.
 */
export function canStepMonth(anchor: Date, direction: 1 | -1, now: Date = new Date()): boolean {
  const { from, to } = ingestionWindow(now);
  const next = new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
  return direction === -1
    ? next.getTime() >= startOfMonth(from).getTime()
    : next.getTime() <= startOfMonth(to).getTime();
}

/**
 * Il mese mostrato tocca un bordo della finestra? È ciò che decide se la
 * pagina deve SPIEGARSI, e la spiegazione si mostra al bordo — prima che
 * qualcuno prema una freccia che non risponde, non dopo.
 *
 * `"both"` con le costanti di oggi NON capita (30 + 60 = 90 giorni non
 * stanno in un mese solo, vedi il test omonimo): esiste per il giorno in cui
 * qualcuno stringesse la finestra — senza, questa funzione direbbe `"start"`
 * nascondendo che anche l'avanti è chiuso, e la pagina spiegherebbe metà del
 * motivo per cui non si muove.
 */
export type WindowEdge = "start" | "end" | "both" | null;

export function monthEdge(anchor: Date, now: Date = new Date()): WindowEdge {
  const atStart = !canStepMonth(anchor, -1, now);
  const atEnd = !canStepMonth(anchor, 1, now);
  if (atStart && atEnd) return "both";
  if (atStart) return "start";
  if (atEnd) return "end";
  return null;
}
