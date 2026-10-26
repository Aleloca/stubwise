import {
  eventDayKey,
  localDayKey,
  rangeForView,
  stepAnchor,
  weekDays,
  startOfLocalDay,
  type CalendarView,
} from "@stubwise/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../data/dates";
import {
  calendarReadWindow,
  useCalendarEvent,
  useCalendarEvents,
  useCalendars,
  useGoogleAccount,
  useMoveEvent,
  useProjects,
} from "../../data/queries";
import { onBeforePersonaChange } from "../../data/session";
import type { CalendarEventDetail, CalendarScope } from "../../data/types";
import { DOCKED_PANEL_QUERY, DetailPanel } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { hasModKey } from "../../platform/platform";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton } from "../claude/conversation/parts";
import { TrapFocus } from "../chat/ThreadPanel";
import { openGoogleAccount } from "../drive/GoogleAccountCard";
import { typing } from "../tasks/useTaskKeys";
import { CalendarGrid, type GridMove } from "./CalendarGrid";
import { calendarSyncPhase, CalendarSyncRow, useHiddenCalendars } from "./CalendarColumn";
import { rangeLabel, shortDate, timeLabel } from "./calendarFormat";
import {
  calendarSearch,
  canStep,
  clampDay,
  resolveCalendar,
  touchesEdge,
  viewSpan,
  windowDays,
  type CalendarSearch,
} from "./calendarParams";
import { CalendarToolbar } from "./CalendarToolbar";
import { EventDetail } from "./EventDetail";
import { EventEditor, type EditorStart } from "./EventEditor";
import { mailboxMarks } from "./gridLayout";
import { SeriesScopeDialog } from "./SeriesScopeDialog";
import { SeriesSettings } from "./SeriesSettings";
import type { ProjectRef } from "./EventBlock";

// La destinazione «Calendar» (shape calendar.md): la testata con
// l'intervallo e i comandi, la griglia (Day, Week predefinita, Month) e il
// pannello di dettaglio di un evento (`?event=`) o di una serie
// (`?series=`), tutto nell'indirizzo (`#/calendar?view&date&event&series`).
// Un evento aperto dall'esterno senza `date` porta il Calendario sul suo
// giorno in Day [A 11]. Cambiare persona rimonta la pagina (router): qui si
// chiudono il pannello e il dialogo della persona di prima.

/** L'area di lavoro larga: «New meeting» per intero e il codice nei blocchi brevi. */
const WIDE_QUERY = "(min-width: 1200px)";

type Editing = { start: EditorStart; event?: CalendarEventDetail } | null;

export function CalendarPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const search = useSearch({ strict: false }) as CalendarSearch;
  const account = useGoogleAccount();
  const connected = !!account.data;
  const wide = useMediaQuery(WIDE_QUERY);
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const win = useMemo(() => windowDays(calendarReadWindow()), []);
  const nowIso = now();
  const today = localDayKey(new Date(nowIso));
  const { view, date, anchor } = resolveCalendar(search, today, win);
  const range = rangeForView(view, anchor);
  const events = useCalendarEvents(
    { from: range.from.toISOString(), to: range.to.toISOString() },
    { enabled: connected },
  );
  const calendars = useCalendars();
  const [hidden] = useHiddenCalendars();
  const projectsData = useProjects().data;
  const move = useMoveEvent();
  const [editing, setEditing] = useState<Editing>(null);
  const [scopeFor, setScopeFor] = useState<GridMove | null>(null);
  const [message, setMessage] = useState("");

  const announce = useCallback((text: string) => {
    // Lo stesso testo due volte di fila si annuncia comunque.
    setMessage("");
    requestAnimationFrame(() => setMessage(text));
  }, []);

  const setSearch = useCallback(
    (patch: Partial<CalendarSearch>, replace = false) =>
      void navigate({
        to: "/calendar",
        search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
        replace,
      } as never),
    [navigate],
  );
  const go = (next: { view: CalendarView; date: string }) => setSearch(calendarSearch(next, today));

  // Cambio di persona: il pannello della persona di prima non resta aperto.
  const setSearchRef = useRef(setSearch);
  setSearchRef.current = setSearch;
  useEffect(
    () =>
      onBeforePersonaChange(() =>
        setSearchRef.current({ event: undefined, series: undefined }, true),
      ),
    [],
  );

  // Una data fuori finestra nell'indirizzo torna al giorno di bordo più vicino.
  useEffect(() => {
    if (search.date && search.date !== date) setSearch(calendarSearch({ view, date }, today), true);
  }, [search.date, date, view, today, setSearch]);

  // [A 11] Un evento aperto da fuori (Home, Posta, ⌘K) senza giorno: Day sul suo giorno.
  const opened = useCalendarEvent(connected && search.event ? search.event : null);
  useEffect(() => {
    if (!search.event || search.date || !opened.data) return;
    setSearch(calendarSearch({ view: "day", date: eventDayKey(opened.data) }, today), true);
    // Una volta per evento aperto.
  }, [search.event, search.date, opened.data?.id]);

  const projects = useMemo(
    () => new Map<string, ProjectRef>((projectsData ?? []).map((p) => [p.id, p])),
    [projectsData],
  );
  const myCalendars = connected ? (calendars.data ?? []) : [];
  const marks = mailboxMarks(myCalendars.map((c) => c.email));
  const shown = useMemo(
    () =>
      (events.data ?? []).filter((e) => !marks || !e.calendarEmail || !hidden.has(e.calendarEmail)),
    [events.data, marks, hidden],
  );

  const span = viewSpan(view, anchor);
  const days =
    view === "week" ? weekDays(anchor) : view === "day" ? [startOfLocalDay(anchor)] : [anchor];
  const canPrev = canStep(view, anchor, -1, win);
  const canNext = canStep(view, anchor, 1, win);
  const windowNote = t("calendar.window", {
    from: shortDate(win.first, i18n.language),
    to: shortDate(win.last, i18n.language),
  });
  const step = (dir: 1 | -1) => {
    if (dir === -1 ? !canPrev : !canNext) return;
    const next = stepAnchor(view, anchor, dir);
    // Il passo può uscire dalla finestra di qualche giorno (una settimana che la tocca): resta dentro.
    go({ view, date: clampDay(localDayKey(next), win) });
  };

  const openEvent = useCallback(
    (id: string) => setSearch({ event: id, series: undefined }),
    [setSearch],
  );
  const closePanel = useCallback(() => {
    const id = search.event;
    setSearch({ event: undefined, series: undefined });
    if (id) {
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-event-block="${CSS.escape(id)}"]`)
          ?.focus({ preventScroll: true }),
      );
    }
  }, [search.event, setSearch]);

  const newMeeting = useCallback(
    (start?: EditorStart) => {
      if (start) {
        setEditing({ start });
        return;
      }
      // Dal bottone: il primo quarto d'ora pieno dopo adesso, oggi; o le 9 del giorno mostrato.
      const base =
        date === today ? Date.parse(nowIso) : startOfLocalDay(anchor).getTime() + 9 * 3_600_000;
      const startMs = Math.ceil(base / 900_000) * 900_000;
      setEditing({
        start: {
          startsAt: new Date(startMs).toISOString(),
          endsAt: new Date(startMs + 30 * 60_000).toISOString(),
          allDay: false,
        },
      });
    },
    [anchor, date, nowIso, today],
  );

  // --- spostare (puntatore e tastiera), con lo scope e «Undo» ------------------------
  const doMove = (m: GridMove, scope: CalendarScope) => {
    const before = { startsAt: m.event.startsAt, endsAt: m.event.endsAt };
    move.mutate(
      { id: m.event.id, startsAt: m.startsAt, endsAt: m.endsAt, scope },
      { onError: () => toast.error(t("calendar.move.failed")) },
    );
    const when = m.event.allDay
      ? new Intl.DateTimeFormat(i18n.language, { weekday: "short", timeZone: "UTC" }).format(
          new Date(m.startsAt),
        )
      : `${new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(new Date(m.startsAt))} ${timeLabel(m.startsAt, i18n.language)}`;
    const text = t("calendar.move.moved", { when });
    announce(text);
    toast.show(text, {
      action: {
        label: t("calendar.move.undo"),
        run: () => move.mutate({ id: m.event.id, ...before, scope }),
      },
    });
  };
  const onMove = (m: GridMove) => {
    if (m.event.seriesId) setScopeFor(m);
    else doMove(m, "one");
  };

  // --- scorciatoie [A 9] -----------------------------------------------------------
  const keys = useRef({ step, go, view, date, today, newMeeting });
  keys.current = { step, go, view, date, today, newMeeting };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || typing(e.target)) return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      const k = keys.current;
      if (hasModKey(e)) {
        if (e.key.toLowerCase() === "n" && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          k.newMeeting();
        }
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      const views: Record<string, CalendarView> = { d: "day", w: "week", m: "month" };
      if (key === "t") k.go({ view: k.view, date: k.today });
      else if (key === "j") k.step(1);
      else if (key === "k") k.step(-1);
      else if (views[key]) k.go({ view: views[key]!, date: k.date });
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (account.isPending) return <section className="h-full" aria-busy="true" />;
  if (!connected) return <ConnectGoogle />;

  const problem = myCalendars.find(
    (c) => calendarSyncPhase(c) !== "ok" && calendarSyncPhase(c) !== "syncing",
  );
  const expired = myCalendars.find((c) => c.expired);
  const edge = touchesEdge(view, anchor, win);
  const empty = events.isSuccess && shown.length === 0;
  const panelOpen = !!(search.event || search.series);
  const mode = docked ? "docked" : "overlay";

  return (
    <section data-calendar-page className="flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <CalendarToolbar
          view={view}
          range={rangeLabel(view, span.first, span.last, i18n.language)}
          canPrev={canPrev}
          canNext={canNext}
          windowNote={windowNote}
          compact={!wide}
          onToday={() => go({ view, date: today })}
          onStep={step}
          onView={(v) => go({ view: v, date })}
          onNew={() => newMeeting()}
        />
        {(problem || expired) && (
          <div className="flex shrink-0 flex-col gap-0.5 px-6 pb-2">
            {problem && <CalendarSyncRow calendar={problem} inline />}
            {expired && (
              <p className="text-xs text-ink-muted">
                {t("calendar.sync.showing", {
                  date: shortDate(
                    (account.data?.status === "expired"
                      ? account.data.since
                      : expired.syncedAt
                    ).slice(0, 10),
                    i18n.language,
                  ),
                })}
              </p>
            )}
          </div>
        )}
        {edge && (
          <p
            data-window-edge={edge}
            className="flex shrink-0 flex-wrap items-center gap-x-1.5 px-6 pb-2 text-xs text-ink-muted"
          >
            {edge === "start"
              ? t("calendar.edge.before", { date: shortDate(win.first, i18n.language) })
              : t("calendar.edge.after", { date: shortDate(win.last, i18n.language) })}
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => toast.show(t("calendar.googleNotice"))}
              className="rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
            >
              {t("calendar.detail.openInGoogle")}
            </button>
          </p>
        )}
        <div
          key={view}
          className="calendar-view-enter relative flex min-h-0 flex-1 flex-col border-t border-rule"
        >
          {events.isError ? (
            <PageError message={t("calendar.loadFailed")} onRetry={() => void events.refetch()} />
          ) : (
            <>
              <CalendarGrid
                view={view}
                days={days}
                events={shown}
                loading={events.isPending}
                win={win}
                nowIso={nowIso}
                marks={marks}
                projects={projects}
                narrow={!wide}
                onOpen={openEvent}
                onCreate={(r) => newMeeting(r)}
                onMove={onMove}
                onDayOpen={(day) => go({ view: "day", date: day })}
                announce={announce}
              />
              {empty && (
                <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-md text-ink-faint">
                  {t(`calendar.empty.${view}`)}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {panelOpen && (
        <>
          {mode === "overlay" && (
            <div
              aria-hidden="true"
              className="palette-backdrop fixed inset-0 z-30 bg-[var(--scrim)]"
              onClick={closePanel}
            />
          )}
          <DetailPanel
            mode={mode}
            label={search.series ? t("calendar.series.panel") : t("calendar.detail.label")}
            onClose={closePanel}
            modal
          >
            <TrapFocus active={mode === "overlay"}>
              {search.series ? (
                <SeriesSettings key={search.series} seriesId={search.series} onClose={closePanel} />
              ) : (
                <EventDetail
                  key={search.event}
                  eventId={search.event!}
                  onClose={closePanel}
                  onEdit={(e) =>
                    setEditing({
                      start: { startsAt: e.startsAt, endsAt: e.endsAt, allDay: e.allDay },
                      event: e,
                    })
                  }
                  onSeries={(id) => setSearch({ series: id, event: undefined })}
                  announce={announce}
                />
              )}
            </TrapFocus>
          </DetailPanel>
        </>
      )}

      {editing && (
        <EventEditor
          start={editing.start}
          event={editing.event}
          win={win}
          onClose={() => setEditing(null)}
          onSaved={announce}
        />
      )}
      {scopeFor && (
        <SeriesScopeDialog
          action="move"
          dateLabel={new Intl.DateTimeFormat(i18n.language, {
            weekday: "long",
            month: "short",
            day: "numeric",
          }).format(new Date(scopeFor.event.startsAt))}
          onCancel={() => {
            setScopeFor(null);
            announce(t("calendar.move.cancelled"));
          }}
          onConfirm={(scope) => {
            const m = scopeFor;
            setScopeFor(null);
            doMove(m, scope);
          }}
        />
      )}
      <p role="status" aria-live="polite" data-calendar-announcer className="sr-only">
        {message}
      </p>
    </section>
  );
}

/** Senza account Google: nessuna griglia, la pagina lo dice con «Connect Google account» (area 5). */
function ConnectGoogle() {
  const { t } = useTranslation();
  return (
    <section className="flex h-full flex-col">
      <header className="shrink-0 px-6 pt-6">
        <h1 className="text-2xl font-semibold text-ink">{t("nav.calendar")}</h1>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-24 text-center">
        <h2 className="text-xl font-semibold text-ink">{t("calendar.connect.title")}</h2>
        <p className="max-w-[52ch] text-md text-ink-muted">{t("calendar.connect.body")}</p>
        <button type="button" className={primaryButton} onClick={() => openGoogleAccount()}>
          {t("calendar.connect.button")}
        </button>
      </div>
    </section>
  );
}
