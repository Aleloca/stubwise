import { localDayKey } from "@stubwise/shared";
import type { CalendarEvent } from "../../data/types";
import { lastAllDayKey } from "./calendarFormat";
import type { WindowDays } from "./calendarParams";

// Lo spostamento di un blocco del Calendario, PURO (shape calendar.md §6):
// lo stato provvisorio (l'evento preso e i suoi orari, il blocco fantasma di
// una riunione disegnata) e i conti — passi di 15′ e di un giorno, la fine
// che si allunga, il trascinamento, il disegno — senza React né DOM. Lo usa
// `useBlockMove`, che ci collega tastiera e puntatore.

export const STEP_MIN = 15;
export const MIN_MS = 60_000;
export const DAY_MS = 86_400_000;

export const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** L'evento preso (da tastiera o col puntatore) con gli orari provvisori. */
export interface Pending {
  id: string;
  startsAt: string;
  endsAt: string;
  how: "keys" | "pointer";
}

/** Una riunione disegnata su uno spazio vuoto: il giorno e i minuti dall'inizio del giorno. */
export interface Draft {
  day: number;
  from: number;
  to: number;
}

export interface MoveState {
  pending: Pending | null;
  draft: Draft | null;
}

export type MoveAction =
  | { type: "pick"; pending: Pending }
  | { type: "times"; startsAt: string; endsAt: string }
  | { type: "draft"; draft: Draft | null }
  | { type: "clear" };

export const IDLE: MoveState = { pending: null, draft: null };

export function moveReducer(state: MoveState, action: MoveAction): MoveState {
  switch (action.type) {
    case "pick":
      return { ...state, pending: action.pending };
    case "times":
      return state.pending
        ? {
            ...state,
            pending: { ...state.pending, startsAt: action.startsAt, endsAt: action.endsAt },
          }
        : state;
    case "draft":
      return { ...state, draft: action.draft };
    case "clear":
      return IDLE;
  }
}

type Times = Pick<CalendarEvent, "startsAt" | "endsAt">;

/**
 * Un passo da tastiera: ↑/↓ ±15′, ←/→ ±1 giorno, Shift+↑/↓ la fine ±15′
 * (mai meno di 15′). Un «tutto il giorno» si sposta solo fra i giorni:
 * `null` per i tasti che non lo muovono.
 */
export function keyStep(times: Times, key: string, shift: boolean, allDay: boolean): Times | null {
  const arrows: Record<string, [number, number]> = {
    ArrowUp: [-STEP_MIN, 0],
    ArrowDown: [STEP_MIN, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  };
  const step = arrows[key];
  if (!step) return null;
  const start = Date.parse(times.startsAt);
  const end = Date.parse(times.endsAt);
  if (step[0] !== 0) {
    if (allDay) return null;
    if (shift)
      return {
        startsAt: times.startsAt,
        endsAt: iso(Math.max(start + STEP_MIN * MIN_MS, end + step[0] * MIN_MS)),
      };
    return { startsAt: iso(start + step[0] * MIN_MS), endsAt: iso(end + step[0] * MIN_MS) };
  }
  return { startsAt: iso(start + step[1] * DAY_MS), endsAt: iso(end + step[1] * DAY_MS) };
}

/** Lo scarto verticale di un trascinamento, a passi di 15′. */
export const snapMinutes = (dy: number, hourPx: number) =>
  Math.round(((dy / hourPx) * 60) / STEP_MIN) * STEP_MIN;

/**
 * Gli orari provvisori di un trascinamento: spostare (anche fra giorni; un
 * «tutto il giorno» solo fra giorni) o ridimensionare (la fine, mai sotto 15′).
 */
export function dragTimes(
  kind: "move" | "resize",
  e: Times & Pick<CalendarEvent, "allDay">,
  deltaMin: number,
  dayDelta: number,
): Times {
  const start = Date.parse(e.startsAt);
  const end = Date.parse(e.endsAt);
  if (kind === "resize") {
    return {
      startsAt: e.startsAt,
      endsAt: iso(Math.max(start + STEP_MIN * MIN_MS, end + deltaMin * MIN_MS)),
    };
  }
  const shift = (e.allDay ? 0 : deltaMin * MIN_MS) + dayDelta * DAY_MS;
  return { startsAt: iso(start + shift), endsAt: iso(end + shift) };
}

/** I minuti del blocco disegnato, dal punto d'àncora a quello del puntatore (almeno 15′). */
export function drawRange(anchorMin: number, m: number): { from: number; to: number } {
  const from = Math.min(anchorMin, m);
  const to = Math.max(anchorMin + STEP_MIN, m + (m >= anchorMin ? STEP_MIN : 0));
  return { from, to: Math.min(to, 24 * 60) };
}

/** Gli orari stanno dentro la finestra letta ([A 8]: niente oltre il bordo). */
export function inWindowSpan(times: Times, allDay: boolean, win: WindowDays): boolean {
  const first = allDay ? times.startsAt.slice(0, 10) : localDayKey(new Date(times.startsAt));
  const last = allDay ? lastAllDayKey(times) : localDayKey(new Date(Date.parse(times.endsAt) - 1));
  return first >= win.first && last <= win.last;
}
