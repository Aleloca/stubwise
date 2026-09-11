import type { CalendarEventItem } from "@stubwise/shared";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { accountColorForIndex } from "../lib/account-colors";
import {
  addDays,
  localDayKey,
  monthGridDays,
  rangeForView,
  startOfWeek,
  stepAnchor,
  type CalendarView,
} from "../lib/calendar-grid";
import { calendarRangeQueryOptions, myGoogleAccountsQueryOptions, projectsQueryOptions } from "../lib/queries";
import { CalendarDetailPanel } from "../components/calendar-detail-panel";
import { CalendarEmptyState, CalendarGridView } from "../components/calendar-grid-view";
import { CalendarSeriesSidebar } from "../components/calendar-series-sidebar";

/**
 * Pagina `/calendar` (fase 9, Task 6/7, design §4): una griglia vera —
 * giorno/settimana/mese — al posto dell'elenco piatto della 7b. Il piano
 * chiedeva esplicitamente due cose sullo stato vuoto e sui fusi: entrambe
 * vivono nei moduli che questa pagina compone (`calendar-grid.ts` per i
 * fusi, `CalendarEmptyState` per il vuoto che spiega).
 *
 * La configurazione delle serie ricorrenti (la 7b) si raggiunge dal
 * pannello di dettaglio, guardando un appuntamento che appartiene a una
 * serie (`calendar-detail-panel.tsx`, design §3) — MA (fix di review, fase
 * 9 Task 2) anche da `CalendarSeriesSidebar`, richiudibile nella colonna
 * sinistra: senza, una serie senza occorrenze nella finestra visibile
 * ([-30gg, +60gg]) non sarebbe raggiungibile da nessuna vista, e peggio,
 * non sarebbe SPEGNIBILE se accesa con `auto: true`.
 */
const VIEWS: CalendarView[] = ["day", "week", "month"];

export function CalendarPage() {
  const { t } = useTranslation();
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: accounts } = useSuspenseQuery(myGoogleAccountsQueryOptions);
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);

  const { from, to } = useMemo(() => rangeForView(view, anchor), [view, anchor]);
  const rangeQuery = useQuery(
    calendarRangeQueryOptions({ from: from.toISOString(), to: to.toISOString(), ...(account ? { account } : {}) }),
  );
  const events = rangeQuery.data?.items ?? [];
  const selected = events.find((event) => event.id === selectedId) ?? null;

  const colorByAccount = useMemo(() => {
    const map = new Map<string, number>();
    accounts.forEach((a, i) => map.set(a.id, i));
    return (event: CalendarEventItem) => accountColorForIndex(map.get(event.accountId) ?? 0);
  }, [accounts]);

  return (
    <div className="page flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden lg:h-[calc(100vh-4rem)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold">{t("calendar:title")}</h1>
          <p className="mt-0.5 font-mono text-[11px] text-fg-faint">{rangeLabel(view, anchor)}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-sm border border-line-strong">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={v === view}
                className={`min-h-9 px-3 font-mono text-[11px] tracking-[0.1em] uppercase transition-colors ${
                  v === view ? "bg-signal text-ink-950" : "text-fg-muted hover:bg-ink-850 hover:text-fg"
                }`}
              >
                {t(`calendar:view.${v}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setAnchor(new Date())}
            className="inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
          >
            {t("calendar:view.today")}
          </button>
          <div className="flex overflow-hidden rounded-sm border border-line-strong">
            <button
              type="button"
              aria-label={t("calendar:view.previous")}
              onClick={() => setAnchor((a) => stepAnchor(view, a, -1))}
              className="min-h-9 px-2.5 text-fg-muted transition-colors hover:bg-ink-850 hover:text-fg"
            >
              ←
            </button>
            <button
              type="button"
              aria-label={t("calendar:view.next")}
              onClick={() => setAnchor((a) => stepAnchor(view, a, 1))}
              className="min-h-9 border-l border-line-strong px-2.5 text-fg-muted transition-colors hover:bg-ink-850 hover:text-fg"
            >
              →
            </button>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[200px_1fr_360px]">
        <aside className="hidden min-h-0 flex-col gap-6 overflow-y-auto border-r border-line p-4 lg:flex">
          <section>
            <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
              {t("calendar:accounts.heading")}
            </p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {accounts.map((a, i) => {
                const color = accountColorForIndex(i);
                const isSelected = account === a.id;
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => setAccount(isSelected ? undefined : a.id)}
                      className={`flex w-full min-h-8 items-center gap-2 rounded-sm px-1.5 text-left font-mono text-[11px] transition-colors ${
                        isSelected ? "bg-ink-850 text-fg" : "text-fg-muted hover:bg-ink-850/60 hover:text-fg"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: color.solid }}
                      />
                      <span className="truncate">{a.email}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <MiniCalendar anchor={anchor} onSelect={setAnchor} />

          <CalendarSeriesSidebar projects={projects} />
        </aside>

        <main className="min-h-0 min-w-0 overflow-hidden">
          {rangeQuery.isPending ? (
            <div aria-hidden="true" className="m-4 h-full rounded-sm border border-dashed border-line-strong" />
          ) : rangeQuery.isError ? (
            <p className="grid h-full place-items-center text-sm text-fg-muted">{t("calendar:events.loadError")}</p>
          ) : events.length === 0 ? (
            <CalendarEmptyState />
          ) : (
            <CalendarGridView
              view={view}
              anchor={anchor}
              events={events}
              colorFor={colorByAccount}
              selectedId={selectedId}
              onSelect={(event) => setSelectedId(event.id)}
            />
          )}
        </main>

        <aside className="hidden min-h-0 overflow-y-auto border-l border-line p-4 lg:block">
          {selected === null ? (
            <p className="text-sm text-fg-muted">{t("calendar:detail.selectPrompt")}</p>
          ) : (
            <CalendarDetailPanel event={selected} projects={projects} />
          )}
        </aside>
      </div>
    </div>
  );
}

const WEEK_RANGE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const DAY_FULL_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

function rangeLabel(view: CalendarView, anchor: Date): string {
  if (view === "day") return DAY_FULL_FORMAT.format(anchor);
  if (view === "month") return MONTH_FORMAT.format(anchor);
  const start = startOfWeek(anchor);
  const end = addDays(start, 6);
  return `${WEEK_RANGE_FORMAT.format(start)} – ${WEEK_RANGE_FORMAT.format(end)}`;
}

/** Mini-calendario nella colonna sinistra: naviga per mese, un click su un giorno sposta l'anchor della vista principale lì. */
function MiniCalendar({ anchor, onSelect }: { anchor: Date; onSelect: (day: Date) => void }) {
  const [visibleMonth, setVisibleMonth] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const days = monthGridDays(visibleMonth);
  const anchorKey = localDayKey(anchor);
  const todayKey = localDayKey(new Date());

  return (
    <section>
      <div className="flex items-center justify-between">
        <p className="font-mono text-[11px] text-fg-muted">{MONTH_FORMAT.format(visibleMonth)}</p>
        <div className="flex gap-0.5">
          <button
            type="button"
            onClick={() => setVisibleMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
            className="grid h-6 w-6 place-items-center rounded-sm text-fg-faint hover:bg-ink-850 hover:text-fg"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => setVisibleMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            className="grid h-6 w-6 place-items-center rounded-sm text-fg-faint hover:bg-ink-850 hover:text-fg"
          >
            →
          </button>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-7 gap-0.5">
        {days.map((day) => {
          const key = localDayKey(day);
          const inMonth = day.getMonth() === visibleMonth.getMonth();
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(day)}
              className={`grid h-6 w-6 place-items-center rounded-full font-mono text-[10px] transition-colors ${
                key === anchorKey
                  ? "bg-signal text-ink-950"
                  : key === todayKey
                    ? "text-signal"
                    : inMonth
                      ? "text-fg-muted hover:bg-ink-850"
                      : "text-fg-faint/50 hover:bg-ink-850"
              }`}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </section>
  );
}
