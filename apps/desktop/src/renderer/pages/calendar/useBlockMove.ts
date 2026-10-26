import { startOfLocalDay } from "@stubwise/shared";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { CalendarEventView } from "../../data/types";
import {
  IDLE,
  MIN_MS,
  STEP_MIN,
  dragTimes,
  drawRange,
  inWindowSpan,
  iso,
  keyStep,
  moveReducer,
  snapMinutes,
} from "./blockMove";
import { timeLabel } from "./calendarFormat";
import { outsideWindow, type WindowDays } from "./calendarParams";

// Tastiera e puntatore sui blocchi della griglia oraria (shape calendar.md
// §6): Space prende, frecce spostano, Space lascia, Esc annulla; col
// puntatore si sposta, si ridimensiona e si disegna una riunione nuova. Lo
// stato provvisorio e i conti sono in `blockMove.ts`; qui ci sono gli eventi
// del DOM e gli annunci. Solo l'organizzatore sposta.

export interface GridMove {
  event: CalendarEventView;
  startsAt: string;
  endsAt: string;
}

const shortDay = (key: string, language: string) =>
  new Intl.DateTimeFormat(language, { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${key}T00:00:00Z`),
  );

/** Il nome di un movimento per l'annuncio: «Thursday 10:30 to 11:30». */
function useMoveWords() {
  const { t, i18n } = useTranslation();
  return (startsAt: string, endsAt: string, allDay: boolean) => {
    const weekday = new Intl.DateTimeFormat(i18n.language, {
      weekday: "long",
      ...(allDay ? { timeZone: "UTC" } : {}),
    }).format(new Date(startsAt));
    if (allDay) return weekday;
    return t("calendar.move.step", {
      day: weekday,
      from: timeLabel(startsAt, i18n.language),
      to: timeLabel(endsAt, i18n.language),
    });
  };
}

interface Gesture {
  kind: "move" | "resize" | "draw";
  pointerId: number;
  x: number;
  y: number;
  /** La colonna sotto il puntatore alla presa (non il primo giorno di una barra lunga). */
  day: number;
  event?: CalendarEventView;
  started: boolean;
  /** Esc a metà: il rilascio non fa nulla, e il clic che lo segue non apre. */
  cancelled: boolean;
  anchorMin?: number;
}

export function useBlockMove({
  events,
  days,
  win,
  hourPx,
  announce,
  onOpen,
  onMove,
  onCreate,
  onRefuse,
}: {
  events: CalendarEventView[];
  days: Date[];
  win: WindowDays;
  hourPx: number;
  announce: (message: string) => void;
  onOpen: (id: string) => void;
  onMove: (move: GridMove) => void;
  onCreate: (range: { startsAt: string; endsAt: string; allDay: boolean }) => void;
  /** Uno spostamento rifiutato (oltre la finestra): la pagina lo dice a vista. */
  onRefuse: (message: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const moveWords = useMoveWords();
  const [state, dispatch] = useReducer(moveReducer, IDLE);
  const { pending, draft } = state;
  const columns = useRef<(HTMLDivElement | null)[]>([]);
  const gesture = useRef<Gesture | null>(null);
  // Il clic che segue un trascinamento (o un Esc a metà) non apre il dettaglio.
  const suppressClick = useRef(false);
  // I gestori sulla finestra leggono lo stato corrente, non quello della presa.
  const latest = useRef({ state, events, days });
  latest.current = { state, events, days };

  // Mentre si sposta da tastiera il blocco cambia posto (e magari colonna): il fuoco lo segue.
  useLayoutEffect(() => {
    if (!pending || pending.how !== "keys") return;
    const el = document.querySelector<HTMLElement>(
      `[data-event-block="${CSS.escape(pending.id)}"]`,
    );
    if (el && document.activeElement !== el) el.focus({ preventScroll: false });
  }, [pending]);

  const refuse = () =>
    onRefuse(t("calendar.editor.outsideWindow", { date: shortDay(win.last, i18n.language) }));
  const cancelKeys = () => {
    dispatch({ type: "clear" });
    announce(t("calendar.move.cancelled"));
  };

  // --- tastiera -------------------------------------------------------------
  function onBlockKey(e: ReactKeyboardEvent<HTMLElement>, ev: CalendarEventView) {
    const focused = events.find((x) => x.id === ev.id)!;
    if (e.key === " ") {
      e.preventDefault();
      if (!pending) {
        if (!focused.isOrganizer) {
          const organizer = focused.attendees.find((a) => a.organizer)?.name ?? "";
          announce(t("calendar.move.cantMove", { name: organizer }));
          return;
        }
        dispatch({
          type: "pick",
          pending: { id: ev.id, startsAt: focused.startsAt, endsAt: focused.endsAt, how: "keys" },
        });
        announce(t("calendar.move.picked", { title: focused.title }));
        return;
      }
      // Si lascia l'evento PRESO (per id), qualunque blocco abbia il fuoco.
      const p = pending;
      const moving = events.find((x) => x.id === p.id);
      dispatch({ type: "clear" });
      if (moving && (p.startsAt !== moving.startsAt || p.endsAt !== moving.endsAt)) {
        onMove({ event: moving, startsAt: p.startsAt, endsAt: p.endsAt });
      } else {
        announce(t("calendar.move.dropped"));
      }
      return;
    }
    if (pending && e.key === "Escape") {
      // Esc da qualunque blocco lascia la presa.
      e.preventDefault();
      e.stopPropagation();
      cancelKeys();
      return;
    }
    if (pending && pending.id === ev.id) {
      if (!e.key.startsWith("Arrow")) return;
      e.preventDefault();
      const next = keyStep(pending, e.key, e.shiftKey, focused.allDay);
      if (!next) return;
      if (!inWindowSpan(next, focused.allDay, win)) {
        refuse();
        return;
      }
      dispatch({ type: "times", ...next });
      announce(moveWords(next.startsAt, next.endsAt, focused.allDay));
      return;
    }
    // ↑/↓ fra i blocchi dello stesso giorno.
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const column = (e.currentTarget as HTMLElement).closest("[data-day-column]");
      const blocks = [...(column?.querySelectorAll<HTMLElement>("[data-event-block]") ?? [])];
      const at = blocks.indexOf(e.currentTarget as HTMLElement);
      const next = blocks[at + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  }

  /**
   * Il fuoco esce dal blocco preso verso un altro elemento: la presa si
   * annulla. Un blocco che si rimonta altrove (stesso id) non conta, né la
   * finestra che perde il fuoco (`relatedTarget` vuoto).
   */
  function onBlockBlur(e: ReactFocusEvent<HTMLElement>, ev: CalendarEventView) {
    if (!pending || pending.how !== "keys" || pending.id !== ev.id) return;
    const to = e.relatedTarget as HTMLElement | null;
    if (!to || to.closest(`[data-event-block="${CSS.escape(ev.id)}"]`)) return;
    cancelKeys();
  }

  // --- puntatore: spostare, ridimensionare, disegnare ---------------------------
  const dayAt = (clientX: number): number => {
    const rects = latest.current.days.map((_, i) => columns.current[i]?.getBoundingClientRect());
    return rects.findIndex((r) => r && r.width > 0 && clientX >= r.left && clientX < r.right);
  };
  const minuteAt = (day: number, clientY: number): number => {
    const r = columns.current[day]?.getBoundingClientRect();
    if (!r) return 0;
    const m = ((clientY - r.top) / hourPx) * 60;
    return Math.max(0, Math.min(24 * 60, Math.floor(m / STEP_MIN) * STEP_MIN));
  };

  function move(e: PointerEvent) {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId || g.cancelled) return;
    if (!g.started && Math.abs(e.clientY - g.y) < 4 && Math.abs(e.clientX - g.x) < 4) return;
    g.started = true;
    if (g.kind === "draw") {
      dispatch({
        type: "draft",
        draft: { day: g.day, ...drawRange(g.anchorMin!, minuteAt(g.day, e.clientY)) },
      });
      return;
    }
    const ev = g.event!;
    const target = dayAt(e.clientX);
    const next = dragTimes(
      g.kind,
      ev,
      snapMinutes(e.clientY - g.y, hourPx),
      g.kind === "resize" || target === -1 || g.day === -1 ? 0 : target - g.day,
    );
    dispatch({ type: "pick", pending: { id: ev.id, ...next, how: "pointer" } });
  }

  function up(e: PointerEvent) {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    endGesture();
    const { pending: p, draft: d } = latest.current.state;
    if (g.cancelled) {
      suppressNextClick();
      return;
    }
    if (g.kind === "draw") {
      const base = startOfLocalDay(latest.current.days[g.day]!).getTime();
      const from = g.started && d ? d.from : g.anchorMin!;
      const to = g.started && d ? d.to : Math.min(24 * 60, from + 30);
      dispatch({ type: "draft", draft: null });
      onCreate({
        startsAt: iso(base + from * MIN_MS),
        endsAt: iso(base + to * MIN_MS),
        allDay: false,
      });
      return;
    }
    const ev = g.event!;
    // Un clic semplice apre (lo fa `onClick`); dopo un trascinamento il clic si ignora.
    if (!g.started) return;
    suppressNextClick();
    dispatch({ type: "clear" });
    if (!p || (p.startsAt === ev.startsAt && p.endsAt === ev.endsAt)) return;
    if (!inWindowSpan(p, ev.allDay, win)) {
      refuse();
      return;
    }
    onMove({ event: ev, startsAt: p.startsAt, endsAt: p.endsAt });
  }

  /** Il clic che il browser manda subito dopo il rilascio si ignora; quello dopo no. */
  function suppressNextClick() {
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  }

  function onKeyDuringGesture(e: KeyboardEvent) {
    const g = gesture.current;
    if (e.key !== "Escape" || !g || g.cancelled) return;
    e.preventDefault();
    e.stopPropagation();
    g.cancelled = true;
    dispatch({ type: "clear" });
  }

  // I gestori sulla finestra per tutto il gesto: un rilascio fuori dalla
  // griglia (o fuori dalla finestra) lo chiude comunque.
  const handlers = useRef({ move, up, key: onKeyDuringGesture });
  handlers.current = { move, up, key: onKeyDuringGesture };
  const listeners = useRef({
    move: (e: PointerEvent) => handlers.current.move(e),
    up: (e: PointerEvent) => handlers.current.up(e),
    key: (e: KeyboardEvent) => handlers.current.key(e),
  });
  function startGesture(g: Gesture) {
    endGesture();
    suppressClick.current = false;
    gesture.current = g;
    const l = listeners.current;
    window.addEventListener("pointermove", l.move);
    window.addEventListener("pointerup", l.up);
    window.addEventListener("pointercancel", l.up);
    window.addEventListener("keydown", l.key, true);
  }
  function endGesture() {
    gesture.current = null;
    const l = listeners.current;
    window.removeEventListener("pointermove", l.move);
    window.removeEventListener("pointerup", l.up);
    window.removeEventListener("pointercancel", l.up);
    window.removeEventListener("keydown", l.key, true);
  }
  useEffect(() => endGesture, []);

  function onBlockPointerDown(
    e: ReactPointerEvent<HTMLElement>,
    ev: CalendarEventView,
    kind: "move" | "resize",
    day: number,
  ) {
    if (e.button !== 0) return;
    suppressClick.current = false;
    const original = events.find((x) => x.id === ev.id)!;
    if (!original.isOrganizer || (kind === "resize" && original.allDay)) return;
    e.stopPropagation();
    const under = dayAt(e.clientX);
    startGesture({
      kind,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      day: under === -1 ? day : under,
      event: original,
      started: false,
      cancelled: false,
    });
  }

  function onColumnPointerDown(e: ReactPointerEvent<HTMLDivElement>, day: number) {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    if (outsideWindow(days[day]!, win)) return;
    startGesture({
      kind: "draw",
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      day,
      started: false,
      cancelled: false,
      anchorMin: minuteAt(day, e.clientY),
    });
  }

  /** Le proprietà di un blocco (griglia oraria e fascia ALL DAY). */
  const blockProps = (ev: CalendarEventView, day: number) => {
    const original = events.find((x) => x.id === ev.id)!;
    return {
      "data-event-block": ev.id,
      "data-moving": pending?.id === ev.id ? "" : undefined,
      onClick: () => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        if (!pending) onOpen(ev.id);
      },
      onKeyDown: (k: ReactKeyboardEvent<HTMLElement>) => onBlockKey(k, ev),
      onKeyUp: (k: ReactKeyboardEvent<HTMLElement>) => {
        if (k.key === " ") k.preventDefault();
      },
      onBlur: (f: ReactFocusEvent<HTMLElement>) => onBlockBlur(f, ev),
      onPointerDown: original.isOrganizer
        ? (p: ReactPointerEvent<HTMLElement>) => onBlockPointerDown(p, ev, "move", day)
        : undefined,
    };
  };

  /** La maniglia in basso di un blocco (ridimensionare). */
  const resizeProps = (ev: CalendarEventView, day: number) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => onBlockPointerDown(e, ev, "resize", day),
  });

  /** Una colonna del giorno (disegnare una riunione). */
  const columnProps = (day: number) => ({
    ref: (el: HTMLDivElement | null) => {
      columns.current[day] = el;
    },
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => onColumnPointerDown(e, day),
  });

  /** Gli eventi da disegnare, con quello preso nella posizione provvisoria. */
  const shown = events.map((e) =>
    pending && e.id === pending.id
      ? { ...e, startsAt: pending.startsAt, endsAt: pending.endsAt }
      : e,
  );

  return { pending, draft, shown, blockProps, resizeProps, columnProps };
}
