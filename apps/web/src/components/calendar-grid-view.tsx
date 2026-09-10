import type { CalendarEventItem } from "@stubwise/shared";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { AccountColor } from "../lib/account-colors";
import {
  allDayEventsForDay,
  eventsForDay,
  localDayKey,
  monthGridDays,
  timedEventsForDay,
  weekDays,
  type CalendarView,
} from "../lib/calendar-grid";

const HOURS = Array.from({ length: 24 }, (_, i) => i);

/**
 * La griglia giorno/settimana/mese (fase 9, Task 6, design §4). Puramente di
 * presentazione: tutta la logica di posizionamento sta in
 * `lib/calendar-grid.ts` (testata a sé, vedi il suo docblock sui fusi).
 *
 * Un evento è un blocco cliccabile che seleziona l'appuntamento nel pannello
 * di dettaglio a destra — non naviga altrove, la griglia resta al suo posto.
 */
export function CalendarGridView({
  view,
  anchor,
  events,
  colorFor,
  selectedId,
  onSelect,
}: {
  view: CalendarView;
  anchor: Date;
  events: CalendarEventItem[];
  colorFor: (event: CalendarEventItem) => AccountColor;
  selectedId: string | null;
  onSelect: (event: CalendarEventItem) => void;
}) {
  if (view === "month") {
    return <MonthGrid anchor={anchor} events={events} colorFor={colorFor} selectedId={selectedId} onSelect={onSelect} />;
  }
  const days = view === "day" ? [anchor] : weekDays(anchor);
  return <TimeGrid days={days} events={events} colorFor={colorFor} selectedId={selectedId} onSelect={onSelect} />;
}

const WEEKDAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { day: "numeric" });

function isToday(day: Date): boolean {
  return localDayKey(day) === localDayKey(new Date());
}

/** Vista giorno/settimana: colonna oraria 0-24h, con una riga a parte per gli eventi «tutto il giorno». */
function TimeGrid({
  days,
  events,
  colorFor,
  selectedId,
  onSelect,
}: {
  days: Date[];
  events: CalendarEventItem[];
  colorFor: (event: CalendarEventItem) => AccountColor;
  selectedId: string | null;
  onSelect: (event: CalendarEventItem) => void;
}) {
  const allDayRows = days.map((day) => allDayEventsForDay(events, day));
  const hasAnyAllDay = allDayRows.some((row) => row.length > 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        className="grid border-b border-line"
        style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}
      >
        <div />
        {days.map((day) => (
          <div key={localDayKey(day)} className="border-l border-line px-2 py-1.5 text-center">
            <p className="font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase">
              {WEEKDAY_FORMAT.format(day)}
            </p>
            <p className={`text-sm ${isToday(day) ? "font-semibold text-signal" : "text-fg"}`}>
              {DAY_FORMAT.format(day)}
            </p>
          </div>
        ))}
      </div>

      {hasAnyAllDay && (
        <div
          className="grid border-b border-line"
          style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}
        >
          <div className="px-1.5 py-1 text-right font-mono text-[9px] text-fg-faint">{"⋯"}</div>
          {allDayRows.map((row, i) => (
            <div key={localDayKey(days[i]!)} className="flex flex-col gap-1 border-l border-line p-1">
              {row.map((event) => (
                <EventPill key={event.id} event={event} color={colorFor(event)} selected={event.id === selectedId} onSelect={onSelect} />
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div>
            {HOURS.map((hour) => (
              <div key={hour} className="h-12 border-b border-line/60 pr-1.5 text-right font-mono text-[9px] text-fg-faint">
                {hour === 0 ? "" : `${String(hour).padStart(2, "0")}:00`}
              </div>
            ))}
          </div>
          {days.map((day) => {
            const positioned = timedEventsForDay(events, day);
            return (
              <div key={localDayKey(day)} className="relative border-l border-line">
                {HOURS.map((hour) => (
                  <div key={hour} className="h-12 border-b border-line/60" />
                ))}
                {positioned.map(({ event, topPct, heightPct }) => (
                  <button
                    key={event.id}
                    type="button"
                    onClick={() => onSelect(event)}
                    style={{
                      top: `${topPct}%`,
                      height: `${heightPct}%`,
                      borderColor: colorFor(event).border,
                      background: colorFor(event).background,
                    }}
                    className={`absolute inset-x-0.5 overflow-hidden rounded-sm border px-1 py-0.5 text-left font-mono text-[10px] leading-tight text-fg transition-[filter] hover:brightness-125 ${
                      event.id === selectedId ? "ring-1 ring-signal" : ""
                    }`}
                  >
                    <span className="truncate">{eventLabel(event)}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Vista mese: celle a griglia con al massimo qualche evento in linea, il resto un contatore. */
const MAX_PILLS_PER_CELL = 3;

function MonthGrid({
  anchor,
  events,
  colorFor,
  selectedId,
  onSelect,
}: {
  anchor: Date;
  events: CalendarEventItem[];
  colorFor: (event: CalendarEventItem) => AccountColor;
  selectedId: string | null;
  onSelect: (event: CalendarEventItem) => void;
}) {
  const days = monthGridDays(anchor);
  const currentMonth = anchor.getMonth();

  return (
    <div className="grid h-full grid-cols-7 grid-rows-[auto_repeat(6,1fr)] overflow-hidden border-b border-line">
      {days.slice(0, 7).map((day) => (
        <div key={localDayKey(day)} className="border-b border-l border-line px-2 py-1.5 text-center first:border-l-0">
          <p className="font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase">{WEEKDAY_FORMAT.format(day)}</p>
        </div>
      ))}
      {days.map((day, i) => {
        const dayEvents = eventsForDay(events, day);
        const shown = dayEvents.slice(0, MAX_PILLS_PER_CELL);
        const rest = dayEvents.length - shown.length;
        const inMonth = day.getMonth() === currentMonth;
        return (
          <div
            key={localDayKey(day)}
            className={`flex min-h-0 flex-col gap-0.5 overflow-hidden border-l border-line p-1 ${i % 7 === 0 ? "border-l-0" : ""} ${inMonth ? "" : "bg-ink-950/30"}`}
          >
            <p className={`font-mono text-[10px] ${isToday(day) ? "font-semibold text-signal" : inMonth ? "text-fg-muted" : "text-fg-faint"}`}>
              {DAY_FORMAT.format(day)}
            </p>
            {shown.map((event) => (
              <EventPill key={event.id} event={event} color={colorFor(event)} selected={event.id === selectedId} onSelect={onSelect} compact />
            ))}
            {rest > 0 && <p className="font-mono text-[9px] text-fg-faint">+{rest}</p>}
          </div>
        );
      })}
    </div>
  );
}

function EventPill({
  event,
  color,
  selected,
  onSelect,
  compact,
}: {
  event: CalendarEventItem;
  color: AccountColor;
  selected: boolean;
  onSelect: (event: CalendarEventItem) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(event)}
      style={{ borderColor: color.border, background: color.background }}
      className={`truncate rounded-sm border px-1 text-left font-mono text-[10px] text-fg transition-[filter] hover:brightness-125 ${
        compact ? "py-0" : "py-0.5"
      } ${selected ? "ring-1 ring-signal" : ""}`}
    >
      {eventLabel(event)}
    </button>
  );
}

function eventLabel(event: CalendarEventItem): string {
  if (event.title !== null && event.title !== "") return event.title;
  return event.organizer ?? "—";
}

/**
 * Lo stato vuoto (design, non negoziabile): la griglia è sparsa PER
 * COSTRUZIONE (solo gli appuntamenti che combaciano con le regole di
 * smistamento di un progetto entrano qui), quindi una vista senza eventi
 * deve dirlo — mai sembrare rotta.
 */
export function CalendarEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="font-mono text-[12px] tracking-[0.12em] text-fg-faint uppercase">{t("calendar:empty.heading")}</p>
      <p className="max-w-sm text-sm text-fg-muted">{t("calendar:empty.body")}</p>
      <Link
        to="/projects"
        className="mt-1 inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
      >
        {t("calendar:empty.linkHint")}
      </Link>
    </div>
  );
}
