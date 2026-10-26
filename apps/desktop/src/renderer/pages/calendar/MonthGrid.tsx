import { eventsForDay, localDayKey, monthGridDays } from "@stubwise/shared";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { CalendarEventView } from "../../data/types";
import { BandPopover } from "./BandPopover";
import { timeLabel, weekdayShort } from "./calendarFormat";
import { outsideWindow } from "./calendarParams";
import type { GridProps } from "./CalendarGrid";
import { MailboxRule, answerOf, blockShape, useEventName, type ProjectRef } from "./EventBlock";
import { MONTH_ROWS, type MailboxMark } from "./gridLayout";
import { AlertGlyph } from "../mail/glyphs";

// La vista Month del Calendario (shape calendar.md §6): 6 × 7 celle, per
// cella 3 righe e «+N more»; il numero del giorno porta in Day.

/** La vista Month: 6 × 7 celle; per cella 3 righe e «+N more». */
export function MonthGrid({
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

/**
 * Una riga di 20 px del mese: «09:30 AUD Standup» (tutto il giorno senza
 * ora). La risposta per forma come nella griglia oraria — contorno per chi
 * non ha risposto, contorno e tinta lieve con «Maybe» per il forse, barrato
 * per il rifiuto — e il salvataggio fallito con icona e parola.
 */
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
  const { t, i18n } = useTranslation();
  const answer = answerOf(e);
  const label = name(e, project, withMailbox);
  const failed = e.save?.state === "failed";
  const outlined = e.allDay || answer === "needsAction" || answer === "tentative" || failed;
  return (
    <button
      type="button"
      data-event-block={e.id}
      aria-label={label}
      title={label}
      onClick={onOpen}
      className={`relative flex h-5 min-w-0 items-center gap-1 rounded-sm px-1 text-left text-xs transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 ${outlined ? `border ${blockShape(e)}` : ""}`}
    >
      {mark && <MailboxRule mark={mark} />}
      {failed && (
        <span className="shrink-0 text-critical">
          <AlertGlyph />
        </span>
      )}
      {!e.allDay && (
        <span className="num shrink-0 text-ink-muted">{timeLabel(e.startsAt, i18n.language)}</span>
      )}
      {project && <span className="num shrink-0 font-semibold text-ink">{project.code}</span>}
      <span
        className={`min-w-0 truncate ${answer === "declined" ? "text-ink-faint line-through" : "text-ink"}`}
      >
        {e.title}
      </span>
      {failed ? (
        <span className="ml-auto shrink-0 text-critical">{t("calendar.save.failed")}</span>
      ) : (
        answer === "tentative" && (
          <span className="ml-auto shrink-0 text-ink-muted">{t("calendar.answer.maybe")}</span>
        )
      )}
    </button>
  );
}
