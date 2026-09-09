import type { CalendarSeriesAction, CalendarSeriesItem, MailItemStatus } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FilterSelect } from "../components/ticket-filters";
import {
  deleteCalendarSeries,
  getCalendarEvents,
  putCalendarSeries,
  type CalendarEventPage,
  type CalendarFilters,
} from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import {
  calendarEventsQueryOptions,
  calendarKeys,
  calendarSeriesQueryOptions,
  myGoogleAccountsQueryOptions,
  projectsQueryOptions,
} from "../lib/queries";

/**
 * Pagina `/calendar` (fase 7b, Task 9): la superficie che il calendario non
 * ha mai avuto (design §1, §4). Due sezioni: le SERIE ricorrenti riconosciute
 * — spente di default, si accendono qui — e gli APPUNTAMENTI VISTI, l'
 * equivalente calendario della pagina Posta.
 *
 * Le occorrenze passate delle 730 righe del 9 settembre 2026 compaiono qui
 * come una serie spenta, `nextOccurrenceAt: null`: visibile, non un fantasma
 * nel database, ma senza produrre più nulla finché qualcuno non la accende
 * di proposito.
 */
const STATUS_OPTIONS: MailItemStatus[] = ["new", "proposed", "actioned", "ignored", "failed", "cancelled"];

const STATUS_CLASS: Record<MailItemStatus, string> = {
  new: "text-fg-muted",
  classified: "text-sky-400",
  proposed: "text-signal",
  actioned: "text-ok",
  ignored: "text-fg-faint",
  failed: "text-danger",
  cancelled: "text-fg-faint",
};

export function CalendarPage() {
  const { t } = useTranslation();
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<MailItemStatus | undefined>(undefined);

  const { data: accounts } = useSuspenseQuery(myGoogleAccountsQueryOptions);
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const seriesQuery = useQuery(calendarSeriesQueryOptions(account));

  const filters: CalendarFilters = {
    ...(account ? { account } : {}),
    ...(status ? { status } : {}),
  };
  const eventsQuery = useQuery(calendarEventsQueryOptions(filters));
  const events = eventsQuery.data?.items ?? [];

  return (
    <div className="page mx-auto w-full max-w-4xl">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("calendar:title")}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t("calendar:subtitle")}</p>
      </header>

      <div className="mt-6 flex flex-wrap gap-4">
        <FilterSelect
          id="calendar-filter-account"
          label={t("mail:filters.account")}
          emptyLabel={t("mail:filters.allAccounts")}
          value={account}
          options={accounts.map((a) => ({ value: a.id, label: a.email }))}
          onChange={setAccount}
        />
      </div>

      <section className="mt-8">
        <h2 className="font-mono text-[12px] tracking-[0.14em] text-fg-muted uppercase">
          {t("calendar:series.heading")}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">{t("calendar:series.subtitle")}</p>

        <div className="mt-3">
          {seriesQuery.isPending ? (
            <div aria-hidden="true" className="h-16 rounded-sm border border-dashed border-line-strong" />
          ) : seriesQuery.data === undefined || seriesQuery.data.items.length === 0 ? (
            <p className="rounded-sm border border-dashed border-line-strong px-4 py-8 text-center font-mono text-[12px] text-fg-faint">
              {t("calendar:series.empty")}
            </p>
          ) : (
            <div className="rounded-sm border border-line bg-ink-900">
              {seriesQuery.data.items.map((series) => (
                <SeriesRow
                  key={`${series.accountId}-${series.recurringEventId}`}
                  series={series}
                  projects={projects}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-[12px] tracking-[0.14em] text-fg-muted uppercase">
            {t("calendar:events.heading")}
          </h2>
          <FilterSelect
            id="calendar-filter-status"
            label={t("mail:filters.status")}
            emptyLabel={t("mail:filters.allStatuses")}
            value={status}
            options={STATUS_OPTIONS.map((s) => ({ value: s, label: t(`mail:status.${s}`) }))}
            onChange={(value) => setStatus(value as MailItemStatus | undefined)}
          />
        </div>

        <div className="mt-3">
          {eventsQuery.isPending ? (
            <div aria-hidden="true" className="h-24 rounded-sm border border-dashed border-line-strong" />
          ) : eventsQuery.isError ? (
            <p className="rounded-sm border border-dashed border-line-strong px-4 py-12 text-center text-sm text-fg-muted">
              {t("calendar:events.loadError")}
            </p>
          ) : events.length === 0 ? (
            <p className="rounded-sm border border-dashed border-line-strong px-4 py-12 text-center font-mono text-[12px] text-fg-faint">
              {t("calendar:events.empty")}
            </p>
          ) : (
            <div className="rounded-sm border border-line bg-ink-900">
              {events.map((event) => (
                <article key={event.id} className="border-b border-line px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-faint">
                    {event.projectName !== null && (
                      <span className="rounded-sm border border-signal-dim/50 bg-ink-850 px-1.5 py-0.5 text-signal">
                        {event.projectName}
                      </span>
                    )}
                    <span className={STATUS_CLASS[event.status]}>{t(`mail:status.${event.status}`)}</span>
                    <time dateTime={event.startsAt} title={event.startsAt}>
                      {formatRelativeTime(event.startsAt)}
                    </time>
                  </div>
                  <p className="mt-1.5 text-sm text-fg">
                    <span className="text-fg-muted">{event.organizer ?? t("inbox:google.unknownSender")}</span>
                    {event.title !== null && event.title !== "" && <span> — {event.title}</span>}
                  </p>
                  {event.error !== null && (
                    <p className="mt-1 font-mono text-[11px] text-danger">{event.error}</p>
                  )}
                  {event.url !== null && (
                    <a
                      href={event.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
                    >
                      {t("mail:open")}
                    </a>
                  )}
                </article>
              ))}
            </div>
          )}

          {eventsQuery.data?.nextCursor != null && <LoadMoreEvents filters={filters} />}
        </div>
      </section>
    </div>
  );
}

const ACTIONS: CalendarSeriesAction[] = ["milestone", "backlog_item", "reminder"];
const LEAD_DAYS_MIN = 0;
const LEAD_DAYS_MAX = 30;

interface SeriesRowProps {
  series: CalendarSeriesItem;
  projects: { id: string; name: string }[];
}

/**
 * Una serie, con la sua configurazione — o il pannello per configurarla.
 * Riusa il pattern «toggle + numero» di `project-form.tsx` (toggle + cadenza
 * del pulse): stesso stile visivo, stessa filosofia di salvataggio esplicito
 * (un bottone «Salva», non un PUT a ogni tasto).
 */
function SeriesRow({ series, projects }: SeriesRowProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(series.enabled);
  const [projectId, setProjectId] = useState<string | undefined>(series.projectId ?? undefined);
  const [action, setAction] = useState<CalendarSeriesAction>(series.action);
  const [leadDays, setLeadDays] = useState(String(series.leadDays));
  const [auto, setAuto] = useState(series.auto);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: calendarKeys.series() });

  const save = useMutation({
    mutationFn: () => {
      if (enabled && !projectId) throw new Error("project_required");
      return putCalendarSeries(series.recurringEventId, {
        accountId: series.accountId,
        enabled,
        projectId: enabled ? (projectId ?? null) : null,
        action,
        leadDays: Number(leadDays),
        auto,
      });
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      setEditing(false);
      invalidate();
    },
    onError: (err) =>
      setError(
        err instanceof Error && err.message === "project_required"
          ? t("calendar:series.projectRequired")
          : t("calendar:series.saveError"),
      ),
  });

  const disable = useMutation({
    mutationFn: () => deleteCalendarSeries(series.recurringEventId, series.accountId),
    onSuccess: () => {
      setEnabled(false);
      invalidate();
    },
  });

  return (
    <article className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm text-fg">{series.title ?? t("mail:noSubject")}</p>
          <p data-testid="series-meta" className="mt-0.5 font-mono text-[11px] text-fg-faint">
            {t("calendar:series.occurrenceCount", { count: series.occurrenceCount })}
            {series.nextOccurrenceAt !== null && (
              <>
                {" · "}
                {t("calendar:series.next", { when: formatRelativeTime(series.nextOccurrenceAt) })}
              </>
            )}
            {series.nextOccurrenceAt === null && ` · ${t("calendar:series.noneUpcoming")}`}
          </p>
        </div>
        <span
          className={`rounded-sm border px-1.5 py-0.5 font-mono text-[11px] ${
            series.enabled
              ? "border-signal-dim/50 bg-ink-850 text-signal"
              : "border-line bg-ink-850 text-fg-faint"
          }`}
        >
          {series.enabled ? t("calendar:series.on") : t("calendar:series.off")}
        </span>
      </div>

      {!editing ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-2 inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
        >
          {series.enabled ? t("calendar:series.configure") : t("calendar:series.enable")}
        </button>
      ) : (
        <div className="mt-3 flex flex-col gap-3 rounded-sm border border-line bg-ink-950/40 p-3">
          <div className="flex items-center gap-2.5">
            <input
              id={`series-enabled-${series.recurringEventId}`}
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="h-4 w-4 shrink-0 accent-signal"
            />
            <label
              htmlFor={`series-enabled-${series.recurringEventId}`}
              className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
            >
              {t("calendar:series.enableLabel")}
            </label>
          </div>
          <p className="font-mono text-[11px] text-fg-faint">{t("calendar:series.offByDefaultHint")}</p>

          <FilterSelect
            id={`series-project-${series.recurringEventId}`}
            label={t("calendar:series.project")}
            emptyLabel={t("mail:filters.allProjects")}
            value={projectId}
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
            onChange={setProjectId}
          />

          <FilterSelect
            id={`series-action-${series.recurringEventId}`}
            label={t("calendar:series.action")}
            value={action}
            options={ACTIONS.map((a) => ({ value: a, label: t(`calendar:series.actionOption.${a}`) }))}
            onChange={(value) => setAction((value as CalendarSeriesAction | undefined) ?? "milestone")}
          />

          <div className="flex items-center gap-2.5">
            <label
              htmlFor={`series-lead-${series.recurringEventId}`}
              className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
            >
              {t("calendar:series.leadDays")}
            </label>
            <input
              id={`series-lead-${series.recurringEventId}`}
              type="number"
              min={LEAD_DAYS_MIN}
              max={LEAD_DAYS_MAX}
              step={1}
              value={leadDays}
              onChange={(event) => setLeadDays(event.target.value)}
              className="w-20 rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 font-mono text-[13px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
            />
          </div>

          <div className="flex items-center gap-2.5">
            <input
              id={`series-auto-${series.recurringEventId}`}
              type="checkbox"
              checked={auto}
              onChange={(event) => setAuto(event.target.checked)}
              className="h-4 w-4 shrink-0 accent-signal"
            />
            <label
              htmlFor={`series-auto-${series.recurringEventId}`}
              className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
            >
              {t("calendar:series.autoLabel")}
            </label>
          </div>
          <p className="font-mono text-[11px] text-fg-faint">{t("calendar:series.autoHint")}</p>

          {error !== null && (
            <p role="alert" className="font-mono text-[11px] text-danger">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate()}
              className="inline-flex min-h-9 items-center rounded-sm bg-signal px-3 font-mono text-[11px] tracking-[0.12em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:opacity-50"
            >
              {save.isPending ? t("common:saving") : t("common:save")}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
            >
              {t("common:cancel")}
            </button>
            {series.enabled && (
              <button
                type="button"
                disabled={disable.isPending}
                onClick={() => disable.mutate()}
                className="inline-flex min-h-9 items-center rounded-sm border border-danger/50 px-3 font-mono text-[11px] tracking-[0.12em] text-danger uppercase transition-colors hover:border-danger disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("calendar:series.disable")}
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function LoadMoreEvents({ filters }: { filters: CalendarFilters }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    const key = calendarKeys.eventsList(filters);
    const current = queryClient.getQueryData<CalendarEventPage>(key);
    if (!current?.nextCursor) return;
    setLoading(true);
    try {
      const next = await getCalendarEvents(filters, current.nextCursor);
      queryClient.setQueryData<CalendarEventPage>(key, (page) => {
        if (!page) return next;
        const seen = new Set(page.items.map((row) => row.id));
        return {
          items: [...page.items, ...next.items.filter((row) => !seen.has(row.id))],
          nextCursor: next.nextCursor,
        };
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-6 grid place-items-center">
      <button
        type="button"
        disabled={loading}
        onClick={() => void handleClick()}
        className="inline-flex min-h-11 items-center rounded-sm border border-line-strong px-4 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:opacity-50 sm:min-h-9"
      >
        {loading ? t("mail:loadingMore") : t("mail:loadMore")}
      </button>
    </div>
  );
}
