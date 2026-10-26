import {
  eventDayKey,
  localDayKey,
  startOfLocalDay,
  timedEventsForDay,
  type CalendarView,
} from "@stubwise/shared";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CalendarEventView } from "../../data/types";
import { BandPopover } from "./BandPopover";
import { DAY_MS, MIN_MS } from "./blockMove";
import { dayHeader, hourLabel, lastAllDayKey, timeLabel, zoneLabel } from "./calendarFormat";
import { outsideWindow, type WindowDays } from "./calendarParams";
import {
  GridBlockBody,
  MailboxRule,
  answerOf,
  answerWordKey,
  blockShape,
  useEventName,
  type ProjectRef,
} from "./EventBlock";
import { MAX_LANES, lanesFor, layoutLanes, type MailboxMark } from "./gridLayout";
import { MonthGrid } from "./MonthGrid";
import { useBlockMove, type GridMove } from "./useBlockMove";
import { itemClass } from "../../tasks-ui/Menu";
import { MoreIcon } from "../task/parts";
import { MenuButton } from "../tasks/controls";

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
  /** Uno spostamento rifiutato (oltre la finestra): la pagina lo dice a vista. */
  onRefuse: (message: string) => void;
  /** «Retry» di un salvataggio fallito, sul blocco. */
  onRetry: (id: string) => void;
  /** «Move to…» dal menu ⋯ del blocco (dialogo data e ora). */
  onMoveTo: (event: CalendarEventView) => void;
}

const minutesInDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** I tre blocchi grigi del caricamento: ora d'inizio e durata in ore. */
const SKELETON: [number, number][] = [
  [9, 1],
  [11, 1.5],
  [14, 1],
];

export type { GridMove };

export function CalendarGrid(props: GridProps) {
  if (props.view === "month") return <MonthGrid {...props} />;
  return <TimeGrid {...props} />;
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
  onRefuse,
  onRetry,
  onMoveTo,
}: GridProps) {
  const { t, i18n } = useTranslation();
  const name = useEventName();
  const scroller = useRef<HTMLDivElement>(null);
  const {
    pending,
    draft,
    shown,
    blockProps: moveProps,
    resizeProps,
    columnProps,
  } = useBlockMove({
    events,
    days,
    win,
    hourPx: HOUR_PX,
    announce,
    onOpen,
    onMove,
    onCreate,
    onRefuse,
  });
  const [more, setMore] = useState<{
    day: number;
    band: CalendarEventView[];
    topPct: number;
  } | null>(null);
  const now = new Date(nowIso);
  const todayKey = localDayKey(now);
  const todayIndex = days.findIndex((d) => localDayKey(d) === todayKey);
  // Le corsie secondo la larghezza della colonna ([A 2], 26 ott 2026), non
  // della finestra: con il pannello aperto o una finestra stretta una
  // colonna di Week scende sotto i 100 px. Senza misura (nessun layout),
  // il tetto della vista.
  const tv = view === "day" ? "day" : "week";
  const [colPx, setColPx] = useState(0);
  // Si osserva lo scorrimento, che resta lo stesso cambiando settimana (le
  // colonne invece rinascono, una per data); a ogni misura si legge la
  // colonna di adesso.
  useLayoutEffect(() => {
    const host = scroller.current;
    if (!host) return;
    const measure = () => {
      const col = host.querySelector<HTMLElement>("[data-day-column]");
      setColPx(col ? col.getBoundingClientRect().width : 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [view, days.length, days[0]?.getTime()]);
  const maxLanes = colPx > 0 ? lanesFor(colPx, tv) : MAX_LANES[tv];
  /** Un blocco più stretto di questo legge il solo titolo (shape §5, revisione del 26 ott). */
  const compactBelow = 140;

  // All'apertura: le 8, o l'ora corrente − 1 h se le 8 non la lascerebbero in vista.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let hour = 8;
    const nowHour = now.getHours();
    if (todayIndex >= 0 && (nowHour + 1) * HOUR_PX > 8 * HOUR_PX + el.clientHeight)
      hour = nowHour - 1;
    // Qualche pixel prima dell'ora, perché la sua etichetta (a cavallo della riga) resti intera.
    el.scrollTop = Math.max(0, hour * HOUR_PX - 12);
    // Solo cambiando vista o intervallo, non a ogni rilettura.
  }, [view, days[0]?.getTime()]);

  const allDay = shown.filter((e) => e.allDay);

  const gridCols = { gridTemplateColumns: `48px repeat(${days.length}, minmax(0, 1fr))` };
  const firstKey = localDayKey(days[0]!);
  const lastKey = localDayKey(days.at(-1)!);

  const blockProps = (ev: CalendarEventView, day: number) => {
    const original = events.find((x) => x.id === ev.id)!;
    const project = ev.projectId ? projects.get(ev.projectId) : undefined;
    const label = name(original, project, marks !== null);
    return { ...moveProps(ev, day), "aria-label": label, title: label };
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
            className="flex items-start justify-end pt-1.5 pr-1.5 text-right text-[11px] leading-tight break-words hyphens-auto text-ink-muted"
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
                {...columnProps(i)}
                className={`calendar-hours relative border-l border-rule ${out ? "calendar-hatch" : "cursor-cell"}`}
              >
                {placed.map((p) => {
                  if (p.kind === "more") {
                    // Un gettone di 20 px in alto nella fascia: nella sua corsia,
                    // o sopra l'unico blocco rimasto, in alto a destra.
                    const label = t("calendar.block.more", { count: p.hidden.length });
                    return (
                      <button
                        key={`more-${p.topPct}`}
                        type="button"
                        data-more={p.hidden.length}
                        data-more-overlay={p.overlay ? "" : undefined}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => setMore({ day: i, band: p.band, topPct: p.topPct })}
                        aria-haspopup="dialog"
                        aria-label={label}
                        title={label}
                        style={
                          p.overlay
                            ? { top: `calc(${p.topPct}% + 2px)`, right: 4 }
                            : {
                                top: `${p.topPct}%`,
                                left: `calc(${(p.lane / p.lanes) * 100}% + 2px)`,
                                maxWidth: `calc(${100 / p.lanes}% - 4px)`,
                              }
                        }
                        className="num absolute z-10 flex h-5 min-w-7 items-center justify-center rounded-md border border-rule-strong bg-surface px-1.5 text-xs font-semibold text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
                      >
                        +{p.hidden.length}
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
                          compact={colPx > 0 && colPx / p.lanes < compactBelow}
                        />
                      </button>
                      {ev.save?.state === "failed" && (
                        <button
                          type="button"
                          data-block-retry
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => onRetry(ev.id)}
                          aria-label={`${t("calendar.save.retry")}: ${ev.title}`}
                          className="absolute right-1 bottom-1 z-10 rounded-sm bg-surface px-1 text-xs font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
                        >
                          {t("calendar.save.retry")}
                        </button>
                      )}
                      {original.isOrganizer && !moving && minutes >= 30 && (
                        <span
                          className="absolute top-0.5 right-0.5 z-10 opacity-0 transition-opacity duration-[var(--duration-fast)] group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100"
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          <MenuButton
                            menuLabel={t("calendar.block.actions", { title: ev.title })}
                            ariaLabel={t("calendar.block.actions", { title: ev.title })}
                            align="right"
                            className="grid size-5 place-items-center rounded-sm bg-surface text-ink-muted hover:text-ink aria-expanded:text-ink"
                            label={<MoreIcon />}
                          >
                            {(close) => (
                              <button
                                type="button"
                                role="menuitem"
                                tabIndex={-1}
                                className={itemClass}
                                onClick={() => {
                                  close();
                                  onMoveTo(original);
                                }}
                              >
                                {t("calendar.moveTo.item")}
                              </button>
                            )}
                          </MenuButton>
                        </span>
                      )}
                      {original.isOrganizer && !continues && (
                        <span
                          aria-hidden="true"
                          data-resize-handle
                          {...resizeProps(ev, i)}
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
