import {
  eventDayKey,
  eventsForDay,
  localDayKey,
  monthGridDays,
  startOfLocalDay,
  timedEventsForDay,
  type CalendarView,
} from "@stubwise/shared";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { CalendarEventView } from "../../data/types";
import {
  dayHeader,
  hourLabel,
  lastAllDayKey,
  timeLabel,
  weekdayShort,
  zoneLabel,
} from "./calendarFormat";
import { outsideWindow, type WindowDays } from "./calendarParams";
import {
  EventListRow,
  GridBlockBody,
  MailboxRule,
  answerOf,
  answerWordKey,
  blockShape,
  useEventName,
  type ProjectRef,
} from "./EventBlock";
import { MAX_LANES, MONTH_ROWS, layoutLanes, type MailboxMark } from "./gridLayout";

// La griglia del Calendario (shape calendar.md §6): un registro orario a
// righe sottili. Day e Week sono una griglia oraria (ore 48 px, testate
// sticky, fascia ALL DAY sopra, linea dell'ora corrente in inchiostro); Month
// è 6 × 7 celle. Le posizioni vengono da `@stubwise/shared/calendar-grid`
// (`timedEventsForDay`, `allDayEventsForDay`, `eventsForDay`, `monthGridDays`):
// niente ricalcoli paralleli dei fusi. Trascinare, ridimensionare e spostare
// da tastiera è solo dell'organizzatore; la scrittura la decide la pagina
// (dialogo della serie, salvataggio, «Undo»).

export const HOUR_PX = 48;
/** Un blocco di 15′ o meno: l'altezza minima per una riga (ora + titolo). */
const MIN_BLOCK_PX = 18;
const STEP_MIN = 15;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

export interface GridMove {
  event: CalendarEventView;
  startsAt: string;
  endsAt: string;
}

export interface GridProps {
  view: CalendarView;
  days: Date[];
  events: CalendarEventView[];
  win: WindowDays;
  nowIso: string;
  marks: Map<string, MailboxMark> | null;
  projects: ReadonlyMap<string, ProjectRef>;
  /** Sotto i 60′ il codice progetto si nasconde (area di lavoro stretta). */
  narrow: boolean;
  /** In caricamento: la griglia vera (ore e colonne) con tre blocchi grigi per giorno. */
  loading?: boolean;
  onOpen: (id: string) => void;
  onCreate: (range: { startsAt: string; endsAt: string; allDay: boolean }) => void;
  onMove: (move: GridMove) => void;
  onDayOpen: (day: string) => void;
  announce: (message: string) => void;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const minutesInDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Lo spostamento da tastiera o col puntatore in corso: l'evento e i suoi orari provvisori. */
interface Pending {
  id: string;
  startsAt: string;
  endsAt: string;
  how: "keys" | "pointer";
}

/** Un trascinamento su uno spazio vuoto: il blocco fantasma della riunione nuova. */
interface Draft {
  day: number;
  from: number;
  to: number;
}

/** I tre blocchi grigi del caricamento: ora d'inizio e durata in ore. */
const SKELETON: [number, number][] = [
  [9, 1],
  [11, 1.5],
  [14, 1],
];

export function CalendarGrid(props: GridProps) {
  if (props.view === "month") return <MonthGrid {...props} />;
  return <TimeGrid {...props} />;
}

/** Il nome di un movimento per l'annuncio: «Thursday 10:30 to 11:30». */
function useMoveWords() {
  const { t, i18n } = useTranslation();
  return (startsAt: string, endsAt: string, allDay: boolean) => {
    const start = new Date(startsAt);
    const weekday = new Intl.DateTimeFormat(i18n.language, {
      weekday: "long",
      ...(allDay ? { timeZone: "UTC" } : {}),
    }).format(start);
    if (allDay) return weekday;
    return t("calendar.move.step", {
      day: weekday,
      from: timeLabel(startsAt, i18n.language),
      to: timeLabel(endsAt, i18n.language),
    });
  };
}

function TimeGrid({
  view,
  days,
  events,
  win,
  nowIso,
  marks,
  projects,
  narrow,
  loading = false,
  onOpen,
  onCreate,
  onMove,
  announce,
}: GridProps) {
  const { t, i18n } = useTranslation();
  const name = useEventName();
  const moveWords = useMoveWords();
  const scroller = useRef<HTMLDivElement>(null);
  const columns = useRef<(HTMLDivElement | null)[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [more, setMore] = useState<{
    day: number;
    band: CalendarEventView[];
    topPct: number;
  } | null>(null);
  const now = new Date(nowIso);
  const todayKey = localDayKey(now);
  const todayIndex = days.findIndex((d) => localDayKey(d) === todayKey);
  const maxLanes = view === "day" ? MAX_LANES.day : MAX_LANES.week;

  // All'apertura: le 8, o l'ora corrente − 1 h se le 8 non la lascerebbero in vista.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let hour = 8;
    const nowHour = now.getHours();
    if (todayIndex >= 0 && (nowHour + 1) * HOUR_PX > 8 * HOUR_PX + el.clientHeight)
      hour = nowHour - 1;
    el.scrollTop = hour * HOUR_PX;
    // Solo cambiando vista o intervallo, non a ogni rilettura.
  }, [view, days[0]?.getTime()]);

  // Mentre si sposta da tastiera il blocco cambia posto (e magari colonna): il fuoco lo segue.
  useLayoutEffect(() => {
    if (!pending || pending.how !== "keys") return;
    const el = document.querySelector<HTMLElement>(
      `[data-event-block="${CSS.escape(pending.id)}"]`,
    );
    if (el && document.activeElement !== el) el.focus({ preventScroll: false });
  }, [pending]);

  const shown = events.map((e) =>
    pending && e.id === pending.id
      ? { ...e, startsAt: pending.startsAt, endsAt: pending.endsAt }
      : e,
  );
  const allDay = shown.filter((e) => e.allDay);

  const inWindow = (startsAt: string, endsAt: string, isAllDay: boolean) => {
    const first = isAllDay ? startsAt.slice(0, 10) : localDayKey(new Date(startsAt));
    const last = isAllDay
      ? lastAllDayKey({ endsAt })
      : localDayKey(new Date(Date.parse(endsAt) - 1));
    return first >= win.first && last <= win.last;
  };

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
        setPending({
          id: ev.id,
          startsAt: original.startsAt,
          endsAt: original.endsAt,
          how: "keys",
        });
        announce(t("calendar.move.picked", { title: original.title }));
        return;
      }
      const p = pending;
      setPending(null);
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
        setPending(null);
        announce(t("calendar.move.cancelled"));
        return;
      }
      const arrows: Record<string, [number, number]> = {
        ArrowUp: [-STEP_MIN, 0],
        ArrowDown: [STEP_MIN, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      };
      const step = arrows[e.key];
      if (!step) return;
      e.preventDefault();
      const start = Date.parse(pending.startsAt);
      const end = Date.parse(pending.endsAt);
      let nextStart = start;
      let nextEnd = end;
      if (e.shiftKey && step[0] !== 0 && !original.allDay) {
        nextEnd = Math.max(start + STEP_MIN * MIN_MS, end + step[0] * MIN_MS);
      } else if (step[0] !== 0) {
        if (original.allDay) return;
        nextStart += step[0] * MIN_MS;
        nextEnd += step[0] * MIN_MS;
      } else {
        nextStart += step[1] * DAY_MS;
        nextEnd += step[1] * DAY_MS;
      }
      if (!inWindow(iso(nextStart), iso(nextEnd), original.allDay)) {
        announce(t("calendar.editor.outsideWindow", { date: shortDay(win.last, i18n.language) }));
        return;
      }
      setPending({ ...pending, startsAt: iso(nextStart), endsAt: iso(nextEnd) });
      announce(moveWords(iso(nextStart), iso(nextEnd), original.allDay));
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
  const gesture = useRef<{
    kind: "move" | "resize" | "draw";
    pointerId: number;
    x: number;
    y: number;
    day: number;
    event?: CalendarEventView;
    started: boolean;
    anchorMin?: number;
  } | null>(null);

  const justDragged = useRef(false);
  const dayAt = (clientX: number): number => {
    const rects = columns.current.map((c) => c?.getBoundingClientRect());
    const i = rects.findIndex((r) => r && clientX >= r.left && clientX < r.right);
    return i === -1 ? -1 : i;
  };
  const minuteAt = (day: number, clientY: number): number => {
    const r = columns.current[day]?.getBoundingClientRect();
    if (!r) return 0;
    const m = ((clientY - r.top) / HOUR_PX) * 60;
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
    const m = minuteAt(day, e.clientY);
    gesture.current = {
      kind: "draw",
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      day,
      started: false,
      anchorMin: m,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (!g.started && Math.abs(e.clientY - g.y) < 4 && Math.abs(e.clientX - g.x) < 4) return;
    g.started = true;
    if (g.kind === "draw") {
      const m = minuteAt(g.day, e.clientY);
      const from = Math.min(g.anchorMin!, m);
      const to = Math.max(g.anchorMin! + STEP_MIN, m + (m >= g.anchorMin! ? STEP_MIN : 0));
      setDraft({ day: g.day, from, to: Math.min(to, 24 * 60) });
      return;
    }
    const ev = g.event!;
    const deltaMin = Math.round((((e.clientY - g.y) / HOUR_PX) * 60) / STEP_MIN) * STEP_MIN;
    const start = Date.parse(ev.startsAt);
    const end = Date.parse(ev.endsAt);
    if (g.kind === "resize") {
      setPending({
        id: ev.id,
        startsAt: ev.startsAt,
        endsAt: iso(Math.max(start + STEP_MIN * MIN_MS, end + deltaMin * MIN_MS)),
        how: "pointer",
      });
      return;
    }
    const target = dayAt(e.clientX);
    const dayDelta = target === -1 ? 0 : target - g.day;
    const shift = (ev.allDay ? 0 : deltaMin * MIN_MS) + dayDelta * DAY_MS;
    setPending({
      id: ev.id,
      startsAt: iso(start + shift),
      endsAt: iso(end + shift),
      how: "pointer",
    });
  }

  function onPointerUp(e: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (g.kind === "draw") {
      const day = days[g.day]!;
      const from = g.started && draft ? draft.from : g.anchorMin!;
      const to = g.started && draft ? draft.to : Math.min(24 * 60, from + 30);
      setDraft(null);
      const base = startOfLocalDay(day).getTime();
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
    setPending(null);
    if (!p || (p.startsAt === ev.startsAt && p.endsAt === ev.endsAt)) return;
    if (!inWindow(p.startsAt, p.endsAt, ev.allDay)) {
      announce(t("calendar.editor.outsideWindow", { date: shortDay(win.last, i18n.language) }));
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
      setPending(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending]);

  const gridCols = { gridTemplateColumns: `48px repeat(${days.length}, minmax(0, 1fr))` };
  const firstKey = localDayKey(days[0]!);
  const lastKey = localDayKey(days.at(-1)!);

  const blockProps = (ev: CalendarEventView, day: number) => {
    const original = events.find((x) => x.id === ev.id)!;
    const project = ev.projectId ? projects.get(ev.projectId) : undefined;
    const label = name(original, project, marks !== null);
    return {
      "data-event-block": ev.id,
      "data-moving": pending?.id === ev.id ? "" : undefined,
      "aria-label": label,
      title: label,
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

  return (
    <div
      role="grid"
      aria-label={t("calendar.grid.label")}
      aria-busy={loading || undefined}
      data-calendar-grid={view}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Testate dei giorni (sticky) e fascia ALL DAY. */}
      <div className="shrink-0 border-b border-rule">
        <div role="row" className="grid" style={gridCols}>
          <div
            role="columnheader"
            className="flex items-end justify-end pr-2 pb-1.5 text-xs text-ink-muted"
          >
            <span title={t("calendar.grid.zone")}>
              {zoneLabel(new Date(startOfLocalDay(days[0]!).getTime() + 12 * 3_600_000))}
            </span>
          </div>
          {days.map((d) => {
            const isToday = localDayKey(d) === todayKey;
            const h = dayHeader(d, i18n.language);
            return (
              <div
                role="columnheader"
                key={d.getTime()}
                aria-label={`${new Intl.DateTimeFormat(i18n.language, { weekday: "long", month: "long", day: "numeric" }).format(d)}${isToday ? `, ${t("calendar.today")}` : ""}`}
                className={`flex min-w-0 flex-wrap items-baseline gap-x-1.5 border-l border-rule px-2 pt-2 pb-1.5 ${outsideWindow(d, win) ? "text-ink-faint" : "text-ink"}`}
              >
                <span className="text-xs text-ink-muted">{h.weekday}</span>
                <span
                  className={`num grid min-w-6 place-items-center rounded-full px-1 text-sm font-semibold ${isToday ? "bg-ink text-ground" : ""}`}
                >
                  {h.day}
                </span>
                {isToday && <span className="text-xs font-semibold">{t("calendar.today")}</span>}
              </div>
            );
          })}
        </div>
        <div role="row" className="grid" style={gridCols}>
          <div
            role="rowheader"
            className="flex items-start justify-end pt-1.5 pr-2 text-[11px] whitespace-nowrap text-ink-muted"
          >
            {t("calendar.allDay")}
          </div>
          <div
            role="gridcell"
            className="relative grid min-h-8 content-start gap-y-0.5 py-1"
            style={{
              gridColumn: `2 / span ${days.length}`,
              gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
            }}
          >
            {days.map((d, i) => (
              <span
                key={d.getTime()}
                aria-hidden="true"
                style={{ left: `${(i / days.length) * 100}%`, width: `${100 / days.length}%` }}
                className={`pointer-events-none absolute inset-y-0 border-l border-rule ${outsideWindow(d, win) ? "calendar-hatch" : ""}`}
              />
            ))}
            {allDay.map((ev, row) => {
              const first = ev.startsAt.slice(0, 10) < firstKey ? firstKey : eventDayKey(ev);
              const last = lastAllDayKey(ev) > lastKey ? lastKey : lastAllDayKey(ev);
              const start = days.findIndex((d) => localDayKey(d) === first);
              const end = days.findIndex((d) => localDayKey(d) === last);
              if (start === -1 || end === -1) return null;
              const project = ev.projectId ? projects.get(ev.projectId) : undefined;
              const answer = answerOf(ev);
              const word = answerWordKey(answer);
              const mark = marks && ev.calendarEmail ? marks.get(ev.calendarEmail) : undefined;
              return (
                <button
                  key={ev.id}
                  type="button"
                  {...blockProps(ev, start)}
                  style={{ gridColumn: `${start + 1} / ${end + 2}`, gridRow: row + 1 }}
                  className={`relative mx-1 flex h-6 min-w-0 items-center gap-1.5 rounded-md border px-2 text-left text-xs transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-out ${blockShape(ev)} ${ev.isOrganizer ? "cursor-move" : ""} ${pending?.id === ev.id ? "ring-1 ring-ink" : ""}`}
                >
                  {mark && <MailboxRule mark={mark} />}
                  {project && (
                    <span className="num shrink-0 font-semibold text-ink">{project.code}</span>
                  )}
                  <span
                    className={`min-w-0 truncate ${answer === "declined" ? "text-ink-faint line-through" : "font-semibold text-ink"}`}
                  >
                    {ev.title}
                  </span>
                  {word && <span className="shrink-0 text-ink-muted">{t(word)}</span>}
                  {ev.save?.state === "saving" && (
                    <span className="shrink-0 text-ink-muted">{t("calendar.save.saving")}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Il registro orario. */}
      <div ref={scroller} data-calendar-scroll className="relative min-h-0 flex-1 overflow-y-auto">
        <div role="row" className="grid" style={{ ...gridCols, height: 24 * HOUR_PX }}>
          <div role="rowheader" aria-label={t("calendar.grid.hours")} className="relative">
            {Array.from({ length: 23 }, (_, h) => (
              <span
                key={h}
                hidden={todayIndex >= 0 && Math.abs(minutesInDay(now) - (h + 1) * 60) < 20}
                style={{ top: (h + 1) * HOUR_PX - 7 }}
                className="num absolute right-2 text-xs whitespace-nowrap text-ink-faint"
              >
                {hourLabel(h + 1, i18n.language)}
              </span>
            ))}
            {todayIndex >= 0 && (
              <span
                style={{ top: (minutesInDay(now) / 60) * HOUR_PX - 8 }}
                className="num absolute right-1 rounded-sm bg-ground px-0.5 text-[11px] font-semibold whitespace-nowrap text-ink"
              >
                {timeLabel(now, i18n.language)}
              </span>
            )}
          </div>
          {days.map((d, i) => {
            const placed = layoutLanes(timedEventsForDay(shown, d), maxLanes);
            const out = outsideWindow(d, win);
            const dayStart = startOfLocalDay(d).getTime();
            return (
              <div
                role="gridcell"
                key={d.getTime()}
                data-day-column={localDayKey(d)}
                data-outside={out ? "" : undefined}
                ref={(el) => {
                  columns.current[i] = el;
                }}
                onPointerDown={(e) => onColumnPointerDown(e, i)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                className={`calendar-hours relative border-l border-rule ${out ? "calendar-hatch" : "cursor-cell"}`}
              >
                {placed.map((p) => {
                  if (p.kind === "more") {
                    return (
                      <button
                        key={`more-${p.topPct}`}
                        type="button"
                        data-more={p.hidden.length}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => setMore({ day: i, band: p.band, topPct: p.topPct })}
                        aria-haspopup="dialog"
                        style={{
                          top: `${p.topPct}%`,
                          height: `${p.heightPct}%`,
                          left: `calc(${(p.lane / p.lanes) * 100}% + 2px)`,
                          width: `calc(${100 / p.lanes}% - 4px)`,
                        }}
                        className="absolute flex items-start rounded-md border border-dashed border-rule-strong bg-surface px-1.5 py-1 text-left text-xs font-semibold text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
                      >
                        {t("calendar.block.more", { count: p.hidden.length })}
                      </button>
                    );
                  }
                  const ev = p.item.event;
                  const original = events.find((x) => x.id === ev.id)!;
                  const start = Date.parse(ev.startsAt);
                  const end = Date.parse(ev.endsAt);
                  const fromPrevious = start < dayStart;
                  const continues = end > dayStart + DAY_MS;
                  const minutes =
                    (Math.min(end, dayStart + DAY_MS) - Math.max(start, dayStart)) / MIN_MS;
                  const project = ev.projectId ? projects.get(ev.projectId) : undefined;
                  const mark = marks && ev.calendarEmail ? marks.get(ev.calendarEmail) : undefined;
                  const moving = pending?.id === ev.id;
                  return (
                    <div
                      key={`${ev.id}-${i}`}
                      style={{
                        top: `${p.item.topPct}%`,
                        height: `${p.item.heightPct}%`,
                        minHeight: MIN_BLOCK_PX,
                        left: `calc(${(p.lane / p.lanes) * 100}% + 2px)`,
                        width: `calc(${100 / p.lanes}% - 4px)`,
                      }}
                      className="group absolute"
                    >
                      <button
                        type="button"
                        {...blockProps(ev, i)}
                        className={`relative flex h-full w-full min-w-0 flex-col items-stretch overflow-hidden border px-1.5 ${minutes <= 20 ? "py-px" : "py-0.5"} text-left text-ink transition-[background-color,box-shadow,top] duration-[var(--duration-fast)] ease-out ${blockShape(ev)} ${fromPrevious ? "rounded-t-none rounded-b-md" : continues ? "rounded-t-md rounded-b-none" : "rounded-md"} ${original.isOrganizer ? "cursor-move" : ""} ${moving ? "z-10 ring-1 ring-ink" : ""}`}
                      >
                        {mark && <MailboxRule mark={mark} />}
                        {moving && (
                          <span className="num text-xs font-semibold text-ink">
                            {timeLabel(ev.startsAt, i18n.language)} –{" "}
                            {timeLabel(ev.endsAt, i18n.language)}
                          </span>
                        )}
                        <GridBlockBody
                          e={ev}
                          heightPx={Math.max(MIN_BLOCK_PX, (minutes / 60) * HOUR_PX)}
                          project={project}
                          past={end < Date.parse(nowIso)}
                          roomy={view === "day"}
                          continues={continues}
                          fromPrevious={fromPrevious}
                          hideCode={narrow && minutes < 60}
                          titleFirst={p.lanes >= 3 && view === "week"}
                        />
                      </button>
                      {original.isOrganizer && !continues && (
                        <span
                          aria-hidden="true"
                          data-resize-handle
                          onPointerDown={(e) => onBlockPointerDown(e, ev, "resize", i)}
                          onPointerMove={onPointerMove}
                          onPointerUp={onPointerUp}
                          className="absolute inset-x-2 bottom-0 h-1.5 cursor-ns-resize after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ink/0 after:transition-colors group-hover:after:bg-ink/40"
                        />
                      )}
                    </div>
                  );
                })}
                {loading &&
                  SKELETON.map(([h, len]) => (
                    <span
                      key={h}
                      aria-hidden="true"
                      style={{ top: h * HOUR_PX + 2, height: len * HOUR_PX - 4 }}
                      className="skeleton-breathe absolute inset-x-1 rounded-md bg-ink/8"
                    />
                  ))}
                {draft && draft.day === i && (
                  <div
                    aria-hidden="true"
                    style={{
                      top: (draft.from / 60) * HOUR_PX,
                      height: ((draft.to - draft.from) / 60) * HOUR_PX,
                    }}
                    className="pointer-events-none absolute inset-x-0.5 rounded-md border border-ink bg-ink/10 px-1.5 py-1 text-xs font-semibold text-ink"
                  >
                    <span className="num">
                      {timeLabel(new Date(dayStart + draft.from * MIN_MS), i18n.language)} –{" "}
                      {timeLabel(new Date(dayStart + draft.to * MIN_MS), i18n.language)}
                    </span>
                  </div>
                )}
                {i === todayIndex && (
                  <div
                    aria-hidden="true"
                    data-now-line
                    style={{ top: (minutesInDay(now) / 60) * HOUR_PX }}
                    className="pointer-events-none absolute inset-x-0 z-20 h-px bg-ink"
                  >
                    <span className="absolute -top-[2.5px] -left-[3px] size-1.5 rounded-full bg-ink" />
                  </div>
                )}
                {more && more.day === i && (
                  <BandPopover
                    band={more.band}
                    topPct={more.topPct}
                    side={days.length > 1 && i >= days.length / 2 ? "right" : "left"}
                    projects={projects}
                    withMailbox={marks !== null}
                    onOpen={(id) => {
                      setMore(null);
                      onOpen(id);
                    }}
                    onClose={() => setMore(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const shortDay = (key: string, language: string) =>
  new Intl.DateTimeFormat(language, { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${key}T00:00:00Z`),
  );

/** L'elenco di una fascia sovrapposta («+N more»): ora, codice, titolo, risposta. */
function BandPopover({
  band,
  topPct,
  projects,
  withMailbox,
  onOpen,
  onClose,
  title,
  side = "left",
}: {
  side?: "left" | "right";
  band: CalendarEventView[];
  topPct?: number;
  projects: ReadonlyMap<string, ProjectRef>;
  withMailbox: boolean;
  onOpen: (id: string) => void;
  onClose: () => void;
  title?: string;
}) {
  const { t } = useTranslation();
  const name = useEventName();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title ?? t("calendar.block.band", { count: band.length })}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      style={topPct !== undefined ? { top: `${topPct}%` } : undefined}
      className={`menu-enter absolute ${side === "right" ? "right-1" : "left-1"} z-30 flex max-h-80 w-72 max-w-[min(18rem,80vw)] flex-col overflow-y-auto rounded-lg border border-rule-strong bg-surface p-1.5 shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]`}
    >
      {title && <p className="px-2 pt-1 pb-1.5 text-xs font-semibold text-ink-muted">{title}</p>}
      {band.map((e) => {
        const project = e.projectId ? projects.get(e.projectId) : undefined;
        return (
          <EventListRow
            key={e.id}
            e={e}
            project={project}
            name={name(e, project, withMailbox)}
            onOpen={() => onOpen(e.id)}
          />
        );
      })}
    </div>
  );
}

/** La vista Month: 6 × 7 celle; per cella 3 righe e «+N more». */
function MonthGrid({
  days: [anchor],
  events,
  win,
  nowIso,
  marks,
  projects,
  onOpen,
  onDayOpen,
}: GridProps) {
  const { t, i18n } = useTranslation();
  const name = useEventName();
  const cells = monthGridDays(anchor!);
  const month = anchor!.getMonth();
  const todayKey = localDayKey(new Date(nowIso));
  const [more, setMore] = useState<string | null>(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  return (
    <div
      role="grid"
      aria-label={t("calendar.grid.label")}
      data-calendar-grid="month"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div role="row" className="grid shrink-0 grid-cols-7 border-b border-rule">
        {weeks[0]!.map((d) => (
          <div role="columnheader" key={d.getTime()} className="px-2 py-1.5 text-xs text-ink-muted">
            {weekdayShort(d, i18n.language)}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-fr overflow-y-auto">
        {weeks.map((week) => (
          <div
            role="row"
            key={week[0]!.getTime()}
            className="grid min-h-[112px] grid-cols-7 border-b border-rule"
          >
            {week.map((d) => {
              const key = localDayKey(d);
              const dayEvents = eventsForDay(events, d).sort(
                (a, b) =>
                  Number(b.allDay) - Number(a.allDay) || a.startsAt.localeCompare(b.startsAt),
              );
              const out = outsideWindow(d, win);
              const isToday = key === todayKey;
              const shownRows =
                dayEvents.length > MONTH_ROWS ? dayEvents.slice(0, MONTH_ROWS - 1) : dayEvents;
              const rest = dayEvents.length - shownRows.length;
              return (
                <div
                  role="gridcell"
                  key={key}
                  data-day-cell={key}
                  data-outside={out ? "" : undefined}
                  className={`relative flex min-w-0 flex-col gap-px border-l border-rule px-1 pt-1 pb-1.5 first:border-l-0 ${out ? "calendar-hatch" : ""}`}
                >
                  <button
                    type="button"
                    disabled={out}
                    onClick={() => onDayOpen(key)}
                    aria-label={`${new Intl.DateTimeFormat(i18n.language, { weekday: "long", month: "long", day: "numeric" }).format(d)}${isToday ? `, ${t("calendar.today")}` : ""}`}
                    className={`num mb-0.5 grid size-6 place-items-center self-start rounded-full text-xs font-semibold transition-colors duration-[var(--duration-fast)] ease-out ${isToday ? "bg-ink text-ground" : d.getMonth() === month && !out ? "text-ink hover:bg-ink/6" : "text-ink-faint"}`}
                  >
                    {d.getDate()}
                  </button>
                  {!out &&
                    shownRows.map((e) => (
                      <MonthRow
                        key={e.id}
                        e={e}
                        project={e.projectId ? projects.get(e.projectId) : undefined}
                        name={name}
                        withMailbox={marks !== null}
                        mark={marks && e.calendarEmail ? marks.get(e.calendarEmail) : undefined}
                        onOpen={() => onOpen(e.id)}
                      />
                    ))}
                  {!out && rest > 0 && (
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      onClick={() => setMore(key)}
                      className="h-5 rounded-sm px-1 text-left text-xs font-semibold text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
                    >
                      {t("calendar.block.more", { count: rest })}
                    </button>
                  )}
                  {more === key && (
                    <BandPopover
                      band={dayEvents}
                      side={d.getDay() === 0 || d.getDay() >= 4 ? "right" : "left"}
                      projects={projects}
                      withMailbox={marks !== null}
                      title={new Intl.DateTimeFormat(i18n.language, {
                        weekday: "long",
                        month: "short",
                        day: "numeric",
                      }).format(d)}
                      onOpen={(id) => {
                        setMore(null);
                        onOpen(id);
                      }}
                      onClose={() => setMore(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Una riga di 20 px del mese: «09:30 AUD Standup» (tutto il giorno senza ora). */
function MonthRow({
  e,
  project,
  name,
  withMailbox,
  mark,
  onOpen,
}: {
  e: CalendarEventView;
  project: ProjectRef | undefined;
  name: ReturnType<typeof useEventName>;
  withMailbox: boolean;
  mark: MailboxMark | undefined;
  onOpen: () => void;
}): ReactNode {
  const { i18n } = useTranslation();
  const answer = answerOf(e);
  const label = name(e, project, withMailbox);
  return (
    <button
      type="button"
      data-event-block={e.id}
      aria-label={label}
      title={label}
      onClick={onOpen}
      className={`relative flex h-5 min-w-0 items-center gap-1 rounded-sm px-1 text-left text-xs transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 ${e.allDay ? `border ${blockShape(e)}` : ""} ${e.save?.state === "failed" ? "text-critical" : ""}`}
    >
      {mark && <MailboxRule mark={mark} />}
      {!e.allDay && (
        <span className="num shrink-0 text-ink-muted">{timeLabel(e.startsAt, i18n.language)}</span>
      )}
      {project && <span className="num shrink-0 font-semibold text-ink">{project.code}</span>}
      <span
        className={`min-w-0 truncate ${answer === "declined" ? "text-ink-faint line-through" : answer === "needsAction" ? "text-ink underline decoration-dotted underline-offset-2" : "text-ink"}`}
      >
        {e.title}
      </span>
    </button>
  );
}
