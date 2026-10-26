import type { CalendarView, GridEvent, PositionedEvent } from "@stubwise/shared";

// La disposizione dei blocchi nella griglia oraria (shape calendar.md §5,
// [A 2]): eventi che si sovrappongono si affiancano in corsie, al massimo 3
// in Week e 5 in Day e comunque non più strette di 64 px (`lanesFor`, dal
// 26 ott 2026); oltre, una voce «+N» in alto nella fascia apre l'elenco.
// Puro: le posizioni verticali vengono da `timedEventsForDay` di
// `@stubwise/shared`, qui si decide solo il lato.

export const MAX_LANES: Record<Exclude<CalendarView, "month">, number> = { week: 3, day: 5 };

/** La larghezza minima di una corsia: sotto, un blocco non dice più niente. */
export const LANE_MIN_PX = 64;

/**
 * Le corsie che stanno in una colonna larga `columnPx`: una ogni 64 px (tolti
 * i 4 dei margini), almeno una, al massimo il tetto della vista.
 */
export function lanesFor(columnPx: number, view: Exclude<CalendarView, "month">): number {
  const fit = Math.floor((columnPx - 4) / LANE_MIN_PX);
  return Math.min(MAX_LANES[view], Math.max(1, fit));
}

/** Righe per cella nella vista Month, prima di «+N more». */
export const MONTH_ROWS = 3;

export type Placed<T extends GridEvent> =
  | { kind: "event"; item: PositionedEvent<T>; lane: number; lanes: number }
  | {
      kind: "more";
      lane: number;
      lanes: number;
      /** In alto nella fascia (il suo primo inizio). */
      topPct: number;
      heightPct: number;
      /**
       * Con una corsia sola non c'è una corsia per «+N»: si sovrappone in
       * alto a destra del blocco che resta.
       */
      overlay: boolean;
      /** Gli eventi che non hanno corsia. */
      hidden: T[];
      /** Tutta la fascia sovrapposta, per l'elenco del popover. */
      band: T[];
    };

const endOf = (p: PositionedEvent<GridEvent>) => p.topPct + p.heightPct;

/** Le fasce: gruppi di eventi che si toccano, a catena. */
function bands<T extends GridEvent>(items: PositionedEvent<T>[]): PositionedEvent<T>[][] {
  const out: PositionedEvent<T>[][] = [];
  let current: PositionedEvent<T>[] = [];
  let reach = -1;
  for (const item of items) {
    if (current.length > 0 && item.topPct >= reach) {
      out.push(current);
      current = [];
      reach = -1;
    }
    current.push(item);
    reach = Math.max(reach, endOf(item));
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Corsie per i blocchi di un giorno (già ordinati per inizio): ogni evento
 * prende la prima corsia libera della sua fascia. Se la fascia ne chiede più
 * di `max`, le prime `max − 1` restano e il resto va in «+N» (con `max` 1
 * resta la prima corsia, e «+N» le si sovrappone).
 */
export function layoutLanes<T extends GridEvent>(
  items: PositionedEvent<T>[],
  max: number,
): Placed<T>[] {
  const placed: Placed<T>[] = [];
  for (const band of bands(items)) {
    const laneEnds: number[] = [];
    const lanesOf = band.map((item) => {
      let lane = laneEnds.findIndex((end) => end <= item.topPct);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = endOf(item);
      return lane;
    });
    const needed = laneEnds.length;
    if (needed <= max) {
      band.forEach((item, i) =>
        placed.push({ kind: "event", item, lane: lanesOf[i]!, lanes: needed }),
      );
      continue;
    }
    const overlay = max === 1;
    const kept = overlay ? 1 : max - 1;
    const hidden: PositionedEvent<T>[] = [];
    band.forEach((item, i) => {
      if (lanesOf[i]! < kept) placed.push({ kind: "event", item, lane: lanesOf[i]!, lanes: max });
      else hidden.push(item);
    });
    const top = band[0]!.topPct;
    placed.push({
      kind: "more",
      lane: max - 1,
      lanes: max,
      topPct: top,
      heightPct: Math.max(...band.map(endOf)) - top,
      overlay,
      hidden: hidden.map((h) => h.event),
      band: band.map((b) => b.event),
    });
  }
  return placed;
}

/** Il segno di una casella: un filetto d'inchiostro con un suo disegno. */
export type MailboxMark = "solid" | "dashed" | "dotted" | "double";
const MARKS: MailboxMark[] = ["solid", "dashed", "dotted", "double"];

/**
 * [A 1] Solo con DUE o più caselle ognuna ha un segno fisso, nell'ordine di
 * collegamento. Lo shape lascia la scelta fra una tavolozza nuova (da
 * verificare a 30° dai reparti) e l'inchiostro con un disegno: qui il
 * disegno, così il colore resta dei reparti e degli stati. Il nome della
 * casella è comunque sempre nel tooltip e nel nome accessibile.
 */
export function mailboxMarks(emails: readonly string[]): Map<string, MailboxMark> | null {
  if (emails.length < 2) return null;
  return new Map(emails.map((e, i) => [e, MARKS[i % MARKS.length]!]));
}
