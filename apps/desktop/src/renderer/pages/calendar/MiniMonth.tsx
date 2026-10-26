import { localDayKey, monthGridDays, rangeForView, type CalendarView } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCalendarEvents } from "../../data/queries";
import { outsideWindow, viewSpan, type WindowDays } from "./calendarParams";
import { weekdayShort } from "./calendarFormat";
import { Arrow } from "./CalendarToolbar";

// Il mini-mese della colonna (shape calendar.md §6): 7 × 6 celle da 28 px in
// tnum, ‹ › per mese fermi ai bordi della finestra; oggi su un cerchio
// d'inchiostro pieno, l'intervallo della vista in tinta 10%, un punto sotto
// i giorni con eventi. I giorni fuori finestra sono spenti e non si cliccano.

const iso = (d: Date) => d.toISOString();

export function MiniMonth({
  view,
  anchor,
  today,
  win,
  enabled,
  onPick,
}: {
  view: CalendarView;
  anchor: Date;
  today: string;
  win: WindowDays;
  /** Senza account collegato il mini-mese c'è, spento. */
  enabled: boolean;
  onPick: (day: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [shownMonth, setShownMonth] = useState(
    () => new Date(anchor.getFullYear(), anchor.getMonth(), 1),
  );
  // La vista cambia mese: il mini-mese la segue.
  const [followed, setFollowed] = useState(anchor.getTime());
  if (followed !== anchor.getTime()) {
    setFollowed(anchor.getTime());
    setShownMonth(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  }
  const cells = monthGridDays(shownMonth).slice(0, 42);
  const range = rangeForView("month", shownMonth);
  const events = useCalendarEvents({ from: iso(range.from), to: iso(range.to) }, { enabled });
  const busy = new Set<string>();
  for (const e of events.data ?? []) {
    if (e.allDay) {
      for (
        let d = new Date(`${e.startsAt.slice(0, 10)}T12:00:00Z`);
        d.getTime() < Date.parse(e.endsAt);
        d = new Date(d.getTime() + 86_400_000)
      ) {
        busy.add(d.toISOString().slice(0, 10));
      }
    } else {
      busy.add(localDayKey(new Date(e.startsAt)));
    }
  }
  const span = viewSpan(view, anchor);
  const spanFirst = localDayKey(span.first);
  const spanLast = localDayKey(span.last);
  const month = shownMonth.getMonth();
  const prev = new Date(shownMonth.getFullYear(), month - 1, 1);
  const next = new Date(shownMonth.getFullYear(), month + 1, 1);
  const canPrev = enabled && localDayKey(new Date(shownMonth.getFullYear(), month, 0)) >= win.first;
  const canNext = enabled && localDayKey(next) <= win.last;
  const label = new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(
    shownMonth,
  );
  const windowNote = t("calendar.window", {
    from: shortKey(win.first, i18n.language),
    to: shortKey(win.last, i18n.language),
  });
  const arrow =
    "grid size-7 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent";
  return (
    <section
      aria-label={t("calendar.miniMonth")}
      data-mini-month
      className={`px-2 pt-3 pb-2 ${enabled ? "" : "opacity-55"}`}
    >
      <div className="flex items-center gap-1 px-1 pb-1">
        <button
          type="button"
          disabled={!canPrev}
          onClick={() => setShownMonth(prev)}
          aria-label={canPrev || !enabled ? t("calendar.previousMonth") : windowNote}
          title={canPrev || !enabled ? t("calendar.previousMonth") : windowNote}
          className={arrow}
        >
          <Arrow dir={-1} />
        </button>
        <p className="min-w-0 flex-1 text-center text-sm font-semibold text-ink">{label}</p>
        <button
          type="button"
          disabled={!canNext}
          onClick={() => setShownMonth(next)}
          aria-label={canNext || !enabled ? t("calendar.nextMonth") : windowNote}
          title={canNext || !enabled ? t("calendar.nextMonth") : windowNote}
          className={arrow}
        >
          <Arrow dir={1} />
        </button>
      </div>
      <div role="grid" aria-label={label} className="grid grid-cols-7">
        <div role="row" className="contents">
          {cells.slice(0, 7).map((d) => (
            <span
              role="columnheader"
              key={d.getTime()}
              className="grid h-6 place-items-center text-[11px] text-ink-faint"
            >
              {weekdayShort(d, i18n.language).slice(0, i18n.language.startsWith("it") ? 2 : 1)}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, w) => (
          <div role="row" key={w} className="contents">
            {cells.slice(w * 7, w * 7 + 7).map((d) => {
              const key = localDayKey(d);
              const out = outsideWindow(d, win);
              const inView = key >= spanFirst && key <= spanLast;
              const isToday = key === today;
              return (
                <span
                  role="gridcell"
                  key={key}
                  className={`flex h-7 items-center justify-center ${inView ? "bg-ink/10" : ""}`}
                >
                  <button
                    type="button"
                    disabled={!enabled || out}
                    aria-current={isToday ? "date" : undefined}
                    aria-label={`${new Intl.DateTimeFormat(i18n.language, { weekday: "long", month: "long", day: "numeric" }).format(d)}${busy.has(key) ? `, ${t("calendar.hasEvents")}` : ""}`}
                    onClick={() => onPick(key)}
                    className={`num relative grid size-6 place-items-center rounded-full text-xs transition-colors duration-[var(--duration-fast)] ease-out ${isToday ? "bg-ink font-semibold text-ground" : out || d.getMonth() !== month ? "text-ink-faint" : "text-ink hover:bg-ink/10"} disabled:cursor-default`}
                  >
                    {d.getDate()}
                    {busy.has(key) && !out && (
                      <span
                        aria-hidden="true"
                        className={`absolute -bottom-0.5 size-1 rounded-full ${isToday ? "bg-ink" : "bg-ink-muted"}`}
                      />
                    )}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

const shortKey = (key: string, language: string) =>
  new Intl.DateTimeFormat(language, { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${key}T00:00:00Z`),
  );
