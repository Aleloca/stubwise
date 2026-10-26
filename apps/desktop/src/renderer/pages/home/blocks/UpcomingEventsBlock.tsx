import { eventDayKey, localDayKey } from "@stubwise/shared";
import { Link } from "@tanstack/react-router";
import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../../data/dates";
import {
  useCalendars,
  useGoogleAccount,
  useProjects,
  useSessionPersonId,
  useUpcomingEvents,
} from "../../../data/queries";
import type { CalendarEventView } from "../../../data/types";
import { useToast } from "../../../tasks-ui/Toast";
import { timeLabel } from "../../calendar/calendarFormat";
import {
  PrepMark,
  answerOf,
  hasPrep,
  useEventName,
  type ProjectRef,
} from "../../calendar/EventBlock";
import { VideoGlyph } from "../../mail/glyphs";
import { ghostButton, smallSecondary } from "../../task/parts";
import { BlockSection, queryState, rowKeys } from "./BlockSection";
import { ExpiredLine, NotConnected, UpdatedAgo } from "./ImportantMailBlock";

/** Quante righe mostra il blocco prima di «Show all N» (shape meeting-prep.md §6). */
export const UPCOMING_CAP = 8;
/** «Join» sulla riga per l'evento in corso o che inizia entro 10 minuti [A 7]. */
const JOIN_BEFORE_MS = 10 * 60_000;

/**
 * «Upcoming» (shape meeting-prep.md §6): gli eventi da adesso a fine di
 * domani (`listUpcomingEvents`, senza quelli che ho rifiutato), in TODAY e
 * TOMORROW; in ogni giorno prima i «tutto il giorno», poi per ora. Una riga
 * porta al Calendario sul giorno, in Day, col pannello dell'evento e la sua
 * scheda di preparazione [A 8].
 */
export function UpcomingEventsBlock() {
  const { t } = useTranslation();
  const account = useGoogleAccount();
  const connected = !!account.data;
  const events = useUpcomingEvents();
  const calendars = useCalendars();
  const projectsData = useProjects().data;
  const projects = useMemo(
    () => new Map<string, ProjectRef>((projectsData ?? []).map((p) => [p.id, p])),
    [projectsData],
  );
  const today = localDayKey(new Date(now()));
  const baseId = useId();
  const title = t("home.blocks.upcomingEvents");
  const action = (
    <Link to="/calendar" className={ghostButton}>
      {t("home.upcoming.open")}
    </Link>
  );

  if (account.isSuccess && !connected) {
    return (
      <BlockSection title={title} action={action} state={{ status: "ready" }}>
        <NotConnected text={t("home.upcoming.connect")} />
      </BlockSection>
    );
  }

  const list = events.data ?? [];
  const days = groupByDay(list, today);
  const expired = calendars.data?.find((c) => c.expired);
  const stale = calendars.data?.find((c) => c.stale && !c.expired);
  const state = queryState([account, events, calendars], {
    when: list.length === 0 && !expired,
    text: t("home.upcoming.empty"),
  });
  let left = UPCOMING_CAP;
  return (
    <BlockSection
      title={title}
      count={list.length}
      meta={stale ? <UpdatedAgo at={stale.syncedAt} /> : undefined}
      action={action}
      state={state}
    >
      {/* J/K fra le righe dei due giorni, col fuoco nel blocco. */}
      <div onKeyDown={rowKeys("[data-upcoming-event] > a")}>
        {days.map(({ day, items }) => {
          const shown = items.slice(0, Math.max(0, left));
          left -= shown.length;
          if (shown.length === 0) return null;
          const headingId = `${baseId}-${day}`;
          return (
            <div key={day} role="group" aria-labelledby={headingId}>
              <h3 id={headingId} className="heading-group border-t border-rule px-4 pt-3 pb-1.5">
                {day === today ? t("calendar.today") : t("calendar.tomorrow")}
              </h3>
              <ul>
                {shown.map((e) => (
                  <EventRow
                    key={e.id}
                    event={e}
                    day={day}
                    project={e.projectId ? projects.get(e.projectId) : undefined}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {expired && <ExpiredLine />}
      {list.length > UPCOMING_CAP && (
        <Link
          to="/calendar"
          search={{ view: "day", date: today } as never}
          className={`${ghostButton} mt-1 ml-2`}
        >
          {t("home.upcoming.showAll", { count: list.length })}
        </Link>
      )}
    </BlockSection>
  );
}

/**
 * Gli eventi per giorno: un evento cominciato prima di oggi (in corso, o un
 * «tutto il giorno» di più giorni) sta in oggi. In ogni giorno i «tutto il
 * giorno» in testa, poi per ora d'inizio.
 */
function groupByDay(
  events: readonly CalendarEventView[],
  today: string,
): { day: string; items: CalendarEventView[] }[] {
  const byDay = new Map<string, CalendarEventView[]>();
  for (const e of events) {
    const key = eventDayKey(e);
    const day = key < today ? today : key;
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, items]) => ({
      day,
      items: [...items].sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) ||
          a.startsAt.localeCompare(b.startsAt) ||
          a.id.localeCompare(b.id),
      ),
    }));
}

/**
 * Una riga da 44px: orario (o «All day»; in corso «Now · until 16:00») ·
 * codice del progetto · titolo · segni a destra — scheda di preparazione,
 * «Not answered», Meet — e «Join» per l'evento in corso o imminente.
 */
function EventRow({
  event: e,
  day,
  project,
}: {
  event: CalendarEventView;
  day: string;
  project: ProjectRef | undefined;
}) {
  const { t, i18n } = useTranslation();
  const me = useSessionPersonId();
  const toast = useToast();
  const name = useEventName();
  const at = Date.parse(now());
  const ongoing = !e.allDay && Date.parse(e.startsAt) <= at && Date.parse(e.endsAt) > at;
  const joinable =
    !!e.meetUrl && !e.allDay && (ongoing || Date.parse(e.startsAt) - at <= JOIN_BEFORE_MS);
  const notAnswered = answerOf(e) === "needsAction";
  const when = e.allDay
    ? t("calendar.allDay")
    : ongoing
      ? t("home.upcoming.now", { time: timeLabel(e.endsAt, i18n.language) })
      : `${timeLabel(e.startsAt, i18n.language)} – ${timeLabel(e.endsAt, i18n.language)}`;
  return (
    <li
      data-upcoming-event={e.id}
      className="relative flex h-11 min-w-0 items-center gap-3 border-b border-rule pr-3 pl-4 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
    >
      <span
        className={`num w-32 shrink-0 truncate text-sm ${ongoing ? "font-semibold text-ink" : "text-ink-muted"}`}
      >
        {when}
      </span>
      {/* La colonna del codice c'è anche vuota: i titoli restano allineati. */}
      <span
        title={project ? `${project.code} ${project.name}` : undefined}
        className="num w-10 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink"
      >
        {project?.code}
      </span>
      <Link
        to="/calendar"
        search={{ view: "day", date: day, event: e.id } as never}
        aria-label={name(e, project, false)}
        title={e.title}
        className="min-w-0 flex-1 truncate text-md text-ink outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
      >
        {e.title}
      </Link>
      {hasPrep(e, project, me) && <PrepMark />}
      {notAnswered && (
        <span className="shrink-0 text-xs text-ink-muted">{t("calendar.answer.notAnswered")}</span>
      )}
      {e.meetUrl && (
        <span title={t("calendar.meet")} className="flex shrink-0 text-ink-muted">
          <VideoGlyph size={14} />
        </span>
      )}
      {joinable && (
        <button
          type="button"
          aria-label={t("home.upcoming.joinLabel", { title: e.title })}
          className={`${smallSecondary} relative z-10`}
          onClick={() => toast.show(t("calendar.meetNotice"))}
        >
          {t("home.upcoming.join")}
        </button>
      )}
    </li>
  );
}
