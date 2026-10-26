import { startOfLocalDay } from "@stubwise/shared";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
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
  day: number;
  event?: CalendarEventView;
  started: boolean;
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
}: {
  events: CalendarEventView[];
  days: Date[];
  win: WindowDays;
  hourPx: number;
  announce: (message: string) => void;
  onOpen: (id: string) => void;
  onMove: (move: GridMove) => void;
  onCreate: (range: { startsAt: string; endsAt: string; allDay: boolean }) => void;
}) {
  const { t, i18n } = useTranslation();
  const moveWords = useMoveWords();
  const [state, dispatch] = useReducer(moveReducer, IDLE);
  const { pending, draft } = state;
  const columns = useRef<(HTMLDivElement | null)[]>([]);
  const gesture = useRef<Gesture | null>(null);
  const justDragged = useRef(false);

  // Mentre si sposta da tastiera il blocco cambia posto (e magari colonna): il fuoco lo segue.
  useLayoutEffect(() => {
    if (!pending || pending.how !== "keys") return;
    const el = document.querySelector<HTMLElement>(
      `[data-event-block="${CSS.escape(pending.id)}"]`,
    );
    if (el && document.activeElement !== el) el.focus({ preventScroll: false });
  }, [pending]);

  const outside = () =>
    announce(t("calendar.editor.outsideWindow", { date: shortDay(win.last, i18n.language) }));

  // --- tastiera -------------------------------------------------------------
  function onBlockKey(e: ReactKeyboardEvent<HTMLElement>, ev: CalendarEventView) {
    const original = events.find((x) => x.id === ev.id)!;
    if (e.key === " ") {
      e.preventDefault();
      if (!pending) {
        if (!original.isOrganizer) {
          const organizer = original.attendees.find((a) => a.organizer)?.name ?? "";
          announce(t("calendar.move.cantMove", { name: organizer }));
          return;
        }
        dispatch({
          type: "pick",
          pending: { id: ev.id, startsAt: original.startsAt, endsAt: original.endsAt, how: "keys" },
        });
        announce(t("calendar.move.picked", { title: original.title }));
        return;
      }
      const p = pending;
      dispatch({ type: "clear" });
      if (p.startsAt !== original.startsAt || p.endsAt !== original.endsAt) {
        onMove({ event: original, startsAt: p.startsAt, endsAt: p.endsAt });
      } else {
        announce(t("calendar.move.dropped"));
      }
      return;
    }
    if (pending && pending.id === ev.id) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dispatch({ type: "clear" });
        announce(t("calendar.move.cancelled"));
        return;
      }
      if (!e.key.startsWith("Arrow")) return;
      e.preventDefault();
      const next = keyStep(pending, e.key, e.shiftKey, original.allDay);
      if (!next) return;
      if (!inWindowSpan(next, original.allDay, win)) {
        outside();
        return;
      }
      dispatch({ type: "times", ...next });
      announce(moveWords(next.startsAt, next.endsAt, original.allDay));
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

  // --- puntatore: spostare, ridimensionare, disegnare ---------------------------
  const dayAt = (clientX: number): number => {
    const rects = columns.current.map((c) => c?.getBoundingClientRect());
    return rects.findIndex((r) => r && clientX >= r.left && clientX < r.right);
  };
  const minuteAt = (day: number, clientY: number): number => {
    const r = columns.current[day]?.getBoundingClientRect();
    if (!r) return 0;
    const m = ((clientY - r.top) / hourPx) * 60;
    return Math.max(0, Math.min(24 * 60, Math.floor(m / STEP_MIN) * STEP_MIN));
  };

  function onBlockPointerDown(
    e: ReactPointerEvent<HTMLElement>,
    ev: CalendarEventView,
    kind: "move" | "resize",
    day: number,
  ) {
    if (e.button !== 0) return;
    const original = events.find((x) => x.id === ev.id)!;
    if (!original.isOrganizer || (kind === "resize" && original.allDay)) return;
    e.stopPropagation();
    gesture.current = {
      kind,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      day,
      event: original,
      started: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onColumnPointerDown(e: ReactPointerEvent<HTMLDivElement>, day: number) {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    if (outsideWindow(days[day]!, win)) return;
    gesture.current = {
      kind: "draw",
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      day,
      started: false,
      anchorMin: minuteAt(day, e.clientY),
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
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
      g.kind === "resize" || target === -1 ? 0 : target - g.day,
    );
    dispatch({ type: "pick", pending: { id: ev.id, ...next, how: "pointer" } });
  }

  function onPointerUp(e: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (g.kind === "draw") {
      const base = startOfLocalDay(days[g.day]!).getTime();
      const from = g.started && draft ? draft.from : g.anchorMin!;
      const to = g.started && draft ? draft.to : Math.min(24 * 60, from + 30);
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
    justDragged.current = true;
    const p = pending;
    dispatch({ type: "clear" });
    if (!p || (p.startsAt === ev.startsAt && p.endsAt === ev.endsAt)) return;
    if (!inWindowSpan(p, ev.allDay, win)) {
      outside();
      return;
    }
    onMove({ event: ev, startsAt: p.startsAt, endsAt: p.endsAt });
  }

  // Esc durante un trascinamento lo annulla.
  useEffect(() => {
    if (!pending || pending.how !== "pointer") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      gesture.current = null;
      dispatch({ type: "clear" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending]);

  /** Le proprietà di un blocco (griglia oraria e fascia ALL DAY). */
  const blockProps = (ev: CalendarEventView, day: number) => {
    const original = events.find((x) => x.id === ev.id)!;
    return {
      "data-event-block": ev.id,
      "data-moving": pending?.id === ev.id ? "" : undefined,
      onClick: () => {
        if (justDragged.current) {
          justDragged.current = false;
          return;
        }
        if (!pending) onOpen(ev.id);
      },
      onKeyDown: (k: ReactKeyboardEvent<HTMLElement>) => onBlockKey(k, ev),
      onKeyUp: (k: ReactKeyboardEvent<HTMLElement>) => {
        if (k.key === " ") k.preventDefault();
      },
      onPointerDown: original.isOrganizer
        ? (p: ReactPointerEvent<HTMLElement>) => onBlockPointerDown(p, ev, "move", day)
        : undefined,
      onPointerMove,
      onPointerUp: original.isOrganizer ? onPointerUp : undefined,
    };
  };

  /** La maniglia in basso di un blocco (ridimensionare). */
  const resizeProps = (ev: CalendarEventView, day: number) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => onBlockPointerDown(e, ev, "resize", day),
    onPointerMove,
    onPointerUp,
  });

  /** Una colonna del giorno (disegnare una riunione). */
  const columnProps = (day: number) => ({
    ref: (el: HTMLDivElement | null) => {
      columns.current[day] = el;
    },
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => onColumnPointerDown(e, day),
    onPointerMove,
    onPointerUp,
  });

  /** Gli eventi da disegnare, con quello preso nella posizione provvisoria. */
  const shown = events.map((e) =>
    pending && e.id === pending.id
      ? { ...e, startsAt: pending.startsAt, endsAt: pending.endsAt }
      : e,
  );

  return { pending, draft, shown, blockProps, resizeProps, columnProps };
}
