import { formatRecurrence, parseRecurrence } from "@stubwise/shared";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCalendarSeries, useProjects } from "../../data/queries";
import type { CalendarSeriesView } from "../../data/types";
import { DisclosureGlyph } from "../claude/conversation/parts";
import { timeLabel } from "./calendarFormat";

// RECURRING SERIES nella colonna (shape calendar.md §6): richiudibile,
// chiusa di default con il numero di serie; una riga per serie con titolo,
// regola a parole e stato («Off», «On · AUD · …», «Auto»). Elenca TUTTE le
// serie che vedo, anche quelle senza date nella finestra letta. Il clic apre
// la serie nel pannello (`?series=`). Nessuna serie → la sezione non c'è.

/** La regola a parole («Every Monday»), o niente se non sappiamo dirla. */
export function useRecurrenceWords() {
  const { t } = useTranslation();
  return (rule: string): string | null => {
    const parsed = parseRecurrence([rule]);
    return parsed
      ? formatRecurrence(parsed, (key, params) => t(`calendar.recurrence.${key}`, params ?? {}))
      : null;
  };
}

/** Lo stato di una serie a parole: «Off», «On · AUD · milestone 2 days before». */
export function useSeriesState() {
  const { t } = useTranslation();
  const projects = useProjects().data;
  return (s: CalendarSeriesView): string => {
    if (!s.enabled) return t("calendar.series.off");
    const code = projects?.find((p) => p.id === s.projectId)?.code;
    const parts = [t("calendar.series.on")];
    if (code) parts.push(code);
    parts.push(t(`calendar.series.state.${s.action}`, { count: s.leadDays }));
    if (s.auto) parts.push(t("calendar.series.auto"));
    return parts.join(" · ");
  };
}

export function SeriesSidebar() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const openId = useRouterState({
    select: (s) => (s.location.search as { series?: string }).series,
  });
  const series = useCalendarSeries().data ?? [];
  const [open, setOpen] = useState(false);
  const words = useRecurrenceWords();
  const stateOf = useSeriesState();
  const listId = useId();
  if (series.length === 0) return null;
  return (
    <div className="mx-2 mt-3 border-t border-rule pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="heading-group flex h-8 w-full items-center gap-1.5 rounded-md px-2.5 text-left transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
      >
        <DisclosureGlyph open={open} />
        <span className="min-w-0 flex-1">{t("calendar.column.series")}</span>
        <span className="num text-ink-faint">{series.length}</span>
      </button>
      {open && (
        <ul id={listId} className="flex flex-col gap-px pt-1">
          {series.map((s) => {
            const rule = words(s.rule);
            const at = s.nextAt ? timeLabel(s.nextAt, i18n.language) : null;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  data-series-row={s.id}
                  aria-current={openId === s.id ? "true" : undefined}
                  onClick={() =>
                    void navigate({
                      to: "/calendar",
                      search: (prev: Record<string, unknown>) => ({
                        ...prev,
                        series: s.id,
                        event: undefined,
                      }),
                    } as never)
                  }
                  className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-[current=true]:bg-ink/10"
                >
                  <span className="w-full truncate text-sm font-medium text-ink">{s.title}</span>
                  {rule && (
                    <span className="w-full truncate text-xs text-ink-muted">
                      {rule}
                      {at ? ` ${at}` : ""}
                    </span>
                  )}
                  <span
                    className={`w-full truncate text-xs ${s.enabled ? "text-ink" : "text-ink-faint"}`}
                  >
                    {stateOf(s)}
                  </span>
                  {s.occurrencesInWindow === 0 && (
                    <span className="w-full truncate text-xs text-ink-faint">
                      {t("calendar.series.noDates")}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
