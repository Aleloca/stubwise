import type { CalendarAttendeeResponseStatus, CalendarEventItem, CalendarSeriesAction } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteCalendarSeries, putCalendarSeries } from "../lib/api";
import { calendarKeys, calendarSeriesQueryOptions } from "../lib/queries";
import { FilterSelect } from "./ticket-filters";

/**
 * Il pannello di dettaglio a destra (fase 9, Task 7, design §3): titolo,
 * quando, partecipanti CON lo stato di risposta, «apri in Google Calendar».
 * Nessuna chiamata in più per i dati dell'evento: `GET /range` (Task 3) li
 * porta già tutti — è lo stesso motivo per cui quella rotta li ha.
 *
 * Se l'evento appartiene a una serie (`recurringEventId !== null`), la
 * configurazione della 7b si raggiunge DA QUI (design §3) — non più da un
 * elenco separato: si accende una serie stando davanti all'appuntamento che
 * si sta guardando.
 */
export function CalendarDetailPanel({
  event,
  projects,
}: {
  event: CalendarEventItem;
  projects: { id: string; name: string }[];
}) {
  const { t } = useTranslation();
  const whenLabel = formatEventWhen(event, t);

  return (
    <article>
      <header className="border-b border-line pb-4">
        <h1 className="text-lg font-semibold break-words">
          {event.title !== null && event.title !== "" ? event.title : <span className="text-fg-faint">{t("mail:noSubject")}</span>}
        </h1>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">{whenLabel}</p>
        {event.organizer !== null && (
          <p className="mt-1 font-mono text-[11px] text-fg-muted">{event.organizer}</p>
        )}
        {(event.eventUrl ?? event.url) !== null && (
          <a
            href={(event.eventUrl ?? event.url)!}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-9 items-center rounded-sm border border-line-strong px-3 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
          >
            {t("calendar:detail.openInGoogle")}
          </a>
        )}
      </header>

      {event.attendees.length > 0 && (
        <section className="mt-4">
          <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
            {t("calendar:detail.attendees")}
          </p>
          <ul className="mt-2 space-y-1">
            {event.attendees.map((attendee) => (
              <li key={attendee.email} className="flex items-center justify-between gap-2 font-mono text-[12px]">
                <span className="min-w-0 truncate text-fg-muted">{attendee.email}</span>
                <AttendeeStatusBadge status={attendee.responseStatus} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {event.error !== null && (
        <p className="mt-4 font-mono text-[11px] text-danger">{event.error}</p>
      )}

      {event.recurringEventId !== null && (
        <section className="mt-6 border-t border-line pt-4">
          <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
            {t("calendar:series.heading")}
          </p>
          <SeriesConfig
            // Fix di review (bloccante, trovato dalla review Stubwise sulla
            // PR): senza `key`, selezionare un evento della serie A e poi uno
            // della serie B riusa la STESSA istanza — il flag `initialized`
            // dentro `SeriesConfig` scatta una volta sola, quindi lo stato
            // locale resta quello di A mentre `recurringEventId` è già B, e
            // «Salva» scriverebbe la configurazione di A (compreso
            // `auto: true`) sulla serie B. La `key` forza React a smontare e
            // rimontare `SeriesConfig` da zero a ogni cambio di serie, così
            // lo stato locale nasce sempre insieme alla serie a cui si
            // riferisce — esattamente come già fa `SeriesSidebarRow` in
            // `calendar-series-sidebar.tsx`, keyata per la stessa coppia.
            key={`${event.accountId}-${event.recurringEventId}`}
            accountId={event.accountId}
            recurringEventId={event.recurringEventId}
            projects={projects}
          />
        </section>
      )}
    </article>
  );
}

const ATTENDEE_STATUS_CLASS: Record<CalendarAttendeeResponseStatus, string> = {
  accepted: "text-ok",
  declined: "text-danger",
  tentative: "text-signal",
  needsAction: "text-fg-faint",
};

function AttendeeStatusBadge({ status }: { status: CalendarAttendeeResponseStatus | null }) {
  const { t } = useTranslation();
  if (status === null) return <span className="text-fg-faint">{t("calendar:attendeeStatus.unknown")}</span>;
  return <span className={ATTENDEE_STATUS_CLASS[status]}>{t(`calendar:attendeeStatus.${status}`)}</span>;
}

/**
 * "Quando" leggibile: un istante solo per un evento senza `endsAt`, un
 * intervallo altrimenti; "tutto il giorno" (senza orario, che sarebbe
 * fuorviante — vedi il docblock di `calendar-grid.ts` sul perché è fissato
 * a mezzanotte UTC) per un evento `allDay`.
 */
function formatEventWhen(event: CalendarEventItem, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const start = new Date(event.startsAt);
  if (event.allDay) {
    // Giorno UTC (vedi calendar-grid.ts): è la data che Google intendeva.
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    return t("calendar:detail.allDayOn", { date: day.toLocaleDateString(undefined, { dateStyle: "full" } as never) });
  }
  const dateLabel = start.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" } as never);
  if (!event.endsAt) return dateLabel;
  const end = new Date(event.endsAt);
  const sameDay = start.toDateString() === end.toDateString();
  const endLabel = sameDay
    ? end.toLocaleTimeString(undefined, { timeStyle: "short" } as never)
    : end.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" } as never);
  return `${dateLabel} – ${endLabel}`;
}

const ACTIONS: CalendarSeriesAction[] = ["milestone", "backlog_item", "reminder"];
const LEAD_DAYS_MIN = 0;
const LEAD_DAYS_MAX = 30;

/**
 * La configurazione di una serie, spostata qui dall'elenco separato della
 * 7b (design §3, fase 9 Task 7). Stesso comportamento: un `PUT` esplicito
 * («Salva»), mai un salvataggio a ogni tasto.
 *
 * Esportato (fix di review, fase 9 Task 2): raggiungibile anche dal
 * pannello «Serie ricorrenti» nella sidebar (`calendar-series-sidebar.tsx`),
 * per una serie che non ha nessuna occorrenza nella finestra visibile della
 * griglia — altrimenti non sarebbe configurabile da nessuna parte, e
 * peggio: non sarebbe SPEGNIBILE se accesa con `auto: true`.
 */
export function SeriesConfig({
  accountId,
  recurringEventId,
  projects,
}: {
  accountId: string;
  recurringEventId: string;
  projects: { id: string; name: string }[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const seriesQuery = useQuery(calendarSeriesQueryOptions(accountId));
  const series = seriesQuery.data?.items.find((item) => item.recurringEventId === recurringEventId);

  const [enabled, setEnabled] = useState(series?.enabled ?? false);
  const [projectId, setProjectId] = useState<string | undefined>(series?.projectId ?? undefined);
  const [action, setAction] = useState<CalendarSeriesAction>(series?.action ?? "milestone");
  const [leadDays, setLeadDays] = useState(String(series?.leadDays ?? 2));
  const [auto, setAuto] = useState(series?.auto ?? false);
  const [error, setError] = useState<string | null>(null);
  // La serie appena arrivata dalla query inizializza i campi una volta sola
  // (evita di sovrascrivere ciò che l'utente sta digitando a ogni refetch).
  const [initialized, setInitialized] = useState(false);
  if (!initialized && series !== undefined) {
    setEnabled(series.enabled);
    setProjectId(series.projectId ?? undefined);
    setAction(series.action);
    setLeadDays(String(series.leadDays));
    setAuto(series.auto);
    setInitialized(true);
  }

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: calendarKeys.series() });

  const save = useMutation({
    mutationFn: () => {
      if (enabled && !projectId) throw new Error("project_required");
      return putCalendarSeries(recurringEventId, {
        accountId,
        enabled,
        projectId: enabled ? (projectId ?? null) : null,
        action,
        leadDays: Number(leadDays),
        auto,
      });
    },
    onMutate: () => setError(null),
    onSuccess: () => invalidate(),
    onError: (err) =>
      setError(
        err instanceof Error && err.message === "project_required"
          ? t("calendar:series.projectRequired")
          : t("calendar:series.saveError"),
      ),
  });

  const disable = useMutation({
    mutationFn: () => deleteCalendarSeries(recurringEventId, accountId),
    onSuccess: () => {
      setEnabled(false);
      invalidate();
    },
  });

  if (seriesQuery.isPending) {
    return <div aria-hidden="true" className="mt-2 h-16 rounded-sm border border-dashed border-line-strong" />;
  }

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-sm border border-line bg-ink-950/40 p-3">
      <div className="flex items-center gap-2.5">
        <input
          id={`series-enabled-${recurringEventId}`}
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 shrink-0 accent-signal"
        />
        <label
          htmlFor={`series-enabled-${recurringEventId}`}
          className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
        >
          {t("calendar:series.enableLabel")}
        </label>
      </div>
      <p className="font-mono text-[11px] text-fg-faint">{t("calendar:series.offByDefaultHint")}</p>

      <FilterSelect
        id={`series-project-${recurringEventId}`}
        label={t("calendar:series.project")}
        emptyLabel={t("mail:filters.allProjects")}
        value={projectId}
        options={projects.map((project) => ({ value: project.id, label: project.name }))}
        onChange={setProjectId}
      />

      <FilterSelect
        id={`series-action-${recurringEventId}`}
        label={t("calendar:series.action")}
        value={action}
        options={ACTIONS.map((a) => ({ value: a, label: t(`calendar:series.actionOption.${a}`) }))}
        onChange={(value) => setAction((value as CalendarSeriesAction | undefined) ?? "milestone")}
      />

      <div className="flex items-center gap-2.5">
        <label
          htmlFor={`series-lead-${recurringEventId}`}
          className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
        >
          {t("calendar:series.leadDays")}
        </label>
        <input
          id={`series-lead-${recurringEventId}`}
          type="number"
          min={LEAD_DAYS_MIN}
          max={LEAD_DAYS_MAX}
          step={1}
          value={leadDays}
          onChange={(e) => setLeadDays(e.target.value)}
          className="w-20 rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 font-mono text-[13px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        />
      </div>

      <div className="flex items-center gap-2.5">
        <input
          id={`series-auto-${recurringEventId}`}
          type="checkbox"
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
          className="h-4 w-4 shrink-0 accent-signal"
        />
        <label
          htmlFor={`series-auto-${recurringEventId}`}
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
        {enabled && (
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
  );
}
