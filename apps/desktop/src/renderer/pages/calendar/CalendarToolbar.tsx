import type { CalendarView } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { shortcutLabel } from "../../platform/platform";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { CALENDAR_VIEWS } from "./calendarParams";

// La testata dell'area di lavoro (shape calendar.md §3): h1 «Calendar»,
// l'intervallo in tnum, poi Today · ‹ › · Day | Week | Month · New meeting.
// ‹ › si spengono solo quando l'intervallo accanto cadrebbe tutto fuori
// dalla finestra letta, e lo dicono (tooltip e nome accessibile, [A 3]).

const arrowButton =
  "grid size-8 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent";

export function CalendarToolbar({
  view,
  range,
  canPrev,
  canNext,
  windowNote,
  compact,
  onToday,
  onStep,
  onView,
  onNew,
}: {
  view: CalendarView;
  range: string;
  canPrev: boolean;
  canNext: boolean;
  /** «Stubwise reads your calendar from Sep 23 to Dec 22». */
  windowNote: string;
  /** Area di lavoro stretta: «New meeting» diventa «New». */
  compact: boolean;
  onToday: () => void;
  onStep: (dir: 1 | -1) => void;
  onView: (view: CalendarView) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const keyOf: Record<CalendarView, string> = { day: "D", week: "W", month: "M" };
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-6 pb-3">
      <div className="flex min-w-0 flex-1 items-baseline gap-4">
        <h1 className="shrink-0 text-2xl font-semibold text-ink">{t("nav.calendar")}</h1>
        <p
          aria-live="polite"
          data-calendar-range
          className="num min-w-0 truncate text-md text-ink-muted"
        >
          {range}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onToday}
          title={`${t("calendar.today")} (T)`}
          className={secondaryButton}
        >
          {t("calendar.today")}
        </button>
        <div className="flex items-center">
          <button
            type="button"
            disabled={!canPrev}
            onClick={() => onStep(-1)}
            aria-label={canPrev ? t("calendar.previous") : windowNote}
            title={canPrev ? `${t("calendar.previous")} (K)` : windowNote}
            className={arrowButton}
          >
            <Arrow dir={-1} />
          </button>
          <button
            type="button"
            disabled={!canNext}
            onClick={() => onStep(1)}
            aria-label={canNext ? t("calendar.next") : windowNote}
            title={canNext ? `${t("calendar.next")} (J)` : windowNote}
            className={arrowButton}
          >
            <Arrow dir={1} />
          </button>
        </div>
        <div
          role="radiogroup"
          aria-label={t("calendar.views")}
          className="flex h-8 items-center rounded-md border border-rule-strong p-0.5"
        >
          {CALENDAR_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={view === v}
              onClick={() => onView(v)}
              title={`${t(`calendar.view.${v}`)} (${keyOf[v]})`}
              className={`h-full rounded-[4px] px-2.5 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${view === v ? "bg-ink/10 font-semibold text-ink" : "text-ink-muted hover:text-ink"}`}
            >
              {t(`calendar.view.${v}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onNew}
          aria-label={t("calendar.newMeeting")}
          title={`${t("calendar.newMeeting")} (${shortcutLabel(["mod", "N"])})`}
          className={primaryButton}
        >
          {compact ? t("calendar.new") : t("calendar.newMeeting")}
        </button>
      </div>
    </header>
  );
}

export function Arrow({ dir }: { dir: 1 | -1 }) {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d={dir === -1 ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
