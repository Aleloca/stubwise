import { localDayKey } from "@stubwise/shared";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useCalendarEvent,
  useDeleteEvent,
  usePeople,
  useProjects,
  useRetryEventSave,
  useRevertEvent,
  useSessionPersonId,
  useSetEventProject,
} from "../../data/queries";
import { now } from "../../data/dates";
import type {
  CalendarAttendee,
  CalendarEventDetail,
  CalendarScope,
  Project,
} from "../../data/types";
import { inputClass } from "../../tasks-ui/Dialog";
import { itemClass } from "../../tasks-ui/Menu";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useToast } from "../../tasks-ui/Toast";
import { CheckGlyph, CrossGlyph, DisclosureGlyph } from "../claude/conversation/parts";
import { AlertGlyph, VideoGlyph } from "../mail/glyphs";
import { UntrustedHtmlFrame } from "../mail/UntrustedHtmlFrame";
import { CloseIcon, InlineConfirm, MoreIcon, ghostButton, smallSecondary } from "../task/parts";
import { MenuButton, secondaryButton } from "../tasks/controls";
import { eventDayLabel, spanLabel } from "./calendarFormat";
import { SeriesScopeDialog } from "./SeriesScopeDialog";
import { RsvpBar } from "./RsvpBar";
import { useRecurrenceWords } from "./SeriesSidebar";
import { MeetingPrep } from "./MeetingPrep";
import { MeetingSummary } from "./MeetingSummary";

// Il dettaglio di un evento nel pannello (`?event=`, shape calendar.md §6),
// dall'alto: avviso di rifiuto, titolo e orario, ricorrenza, Join Google
// Meet, risposta, progetto, partecipanti, luogo, descrizione (isolata),
// promemoria, casella, la scheda di preparazione o il riassunto di una
// riunione passata (`MeetingPrep` / `MeetingSummary`) e il piede con
// «Open in Google Calendar» e, per l'organizzatore, Edit · Delete. Chi non
// organizza legge chi lo fa e cambia solo la sua risposta.

/** La descrizione si vede fino a 240 px, poi «Show more» (shape §6, punto 8). */
const DESCRIPTION_MAX = 240;
/** Un'altezza per il frame della descrizione, dal testo (il frame non si legge da fuori). */
const descriptionHeight = (text: string) =>
  64 + text.split(/\n/).reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 52)), 0) * 22;

/** Quanti partecipanti si vedono prima di «Show all». */
export const GUESTS_PREVIEW = 8;
/** Oltre questi progetti il menu «Change» ha la ricerca. */
const PROJECT_SEARCH_FROM = 8;

const RANK: Record<string, number> = { accepted: 2, tentative: 3, needsAction: 4, declined: 5 };

/** Un indirizzo lungo con l'ellissi a metà («freelancer…@collaborators.example»). */
export function middleEllipsis(text: string, max = 34): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  return `${text.slice(0, Math.ceil(keep / 2))}…${text.slice(text.length - Math.floor(keep / 2))}`;
}

/** Il testo semplice di una descrizione come HTML da isolare (niente markup dell'autore). */
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const descriptionHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

export function EventDetail({
  eventId,
  onClose,
  onEdit,
  onSeries,
  announce,
}: {
  eventId: string;
  onClose: () => void;
  onEdit: (event: CalendarEventDetail) => void;
  onSeries: (seriesId: string) => void;
  announce: (message: string) => void;
}) {
  const { t } = useTranslation();
  const query = useCalendarEvent(eventId);
  const top = (
    <div className="flex h-12 shrink-0 items-center justify-end px-2">
      <button
        type="button"
        onClick={onClose}
        aria-label={t("calendar.detail.close")}
        title={t("calendar.detail.close")}
        className={`${ghostButton} w-8 justify-center px-0`}
      >
        <CloseIcon />
      </button>
    </div>
  );
  if (query.isPending) {
    return (
      <div aria-busy="true">
        {top}
        <p role="status" className="px-4 text-sm text-ink-muted">
          {t("calendar.detail.loading")}
        </p>
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div data-event-detail={eventId}>
        {top}
        <p role="alert" className="px-4 text-md text-ink">
          {t("calendar.detail.unavailable")}
        </p>
      </div>
    );
  }
  return (
    <div data-event-detail={eventId} className="flex flex-col pb-6">
      {top}
      <Detail
        e={query.data}
        onEdit={onEdit}
        onSeries={onSeries}
        announce={announce}
        onDeleted={onClose}
      />
    </div>
  );
}

function Detail({
  e,
  onEdit,
  onSeries,
  announce,
  onDeleted,
}: {
  e: CalendarEventDetail;
  onEdit: (event: CalendarEventDetail) => void;
  onSeries: (seriesId: string) => void;
  announce: (message: string) => void;
  onDeleted: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const me = useSessionPersonId();
  const people = usePeople().data;
  const projects = useProjects().data;
  const retry = useRetryEventSave();
  const revert = useRevertEvent();
  const remove = useDeleteEvent();
  const words = useRecurrenceWords();
  const rsvpRef = useRef<HTMLDivElement>(null);
  const [allGuests, setAllGuests] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteScope, setDeleteScope] = useState(false);
  const [moreWays, setMoreWays] = useState(false);
  const [moreText, setMoreText] = useState(false);

  const dayWords = {
    today: t("calendar.today"),
    tomorrow: t("calendar.tomorrow"),
    yesterday: t("calendar.yesterday"),
  };
  const when = e.allDay
    ? `${t("calendar.allDay")} · ${spanLabel(e, i18n.language)}`
    : `${eventDayLabel(e, todayKey(), i18n.language, dayWords)} · ${spanLabel(e, i18n.language)}`;
  const project = e.projectId ? projects?.find((p) => p.id === e.projectId) : undefined;
  const past = Date.parse(e.endsAt) <= Date.parse(now());
  const organizer = e.attendees.find((a) => a.organizer);
  const invited = e.myResponse !== null && !e.isOrganizer;
  const dateLabel = new Intl.DateTimeFormat(i18n.language, {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(e.allDay ? { timeZone: "UTC" } : {}),
  }).format(new Date(e.startsAt));
  const notice = (key: string) => toast.show(t(key));

  const doDelete = (scope: CalendarScope) =>
    remove.mutate(
      { id: e.id, scope },
      {
        onSuccess: () => {
          announce(t("calendar.detail.deleted", { title: e.title }));
          onDeleted();
        },
        onError: () => toast.error(t("calendar.detail.deleteFailed")),
      },
    );

  return (
    <>
      {e.myResponse === "declined" && (
        <p className="mx-4 mb-3 flex flex-wrap items-center gap-x-1.5 border-l border-rule-strong pl-3 text-sm text-ink">
          {t("calendar.detail.declined")} ·
          <button
            type="button"
            onClick={() => rsvpRef.current?.querySelector<HTMLElement>("[aria-pressed]")?.focus()}
            className="rounded-sm font-medium underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {t("calendar.detail.changeAnswer")}
          </button>
        </p>
      )}

      <header className="flex flex-col gap-1 px-4 pb-4">
        <h2
          tabIndex={-1}
          data-panel-title={`event:${e.id}`}
          className={`text-xl font-semibold text-ink outline-none ${e.myResponse === "declined" ? "line-through decoration-1" : ""}`}
        >
          {e.title}
        </h2>
        <p className="num text-md text-ink">{when}</p>
        {e.series && (
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-ink-muted">
            {words(e.series.rule) ?? t("calendar.detail.recurring")}
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => onSeries(e.series!.id)}
              className="rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
            >
              {t("calendar.detail.seriesSettings")}
            </button>
          </p>
        )}
      </header>

      {e.save?.state === "failed" && (
        <div
          role="alert"
          className="mx-4 mb-3 flex flex-col gap-2 border-l border-critical py-1 pl-3 text-sm"
        >
          <p className="flex items-start gap-1.5 text-ink">
            <span className="mt-0.5 text-critical">
              <AlertGlyph size={14} />
            </span>
            {t(
              e.save.error === "rejected" ? "calendar.save.rejected" : "calendar.save.unreachable",
            )}
          </p>
          <div className="flex gap-2">
            <button type="button" className={smallSecondary} onClick={() => retry.mutate(e.id)}>
              {t("calendar.save.retry")}
            </button>
            <button type="button" className={smallSecondary} onClick={() => revert.mutate(e.id)}>
              {t("calendar.save.undo")}
            </button>
          </div>
        </div>
      )}
      {e.save?.state === "saving" && (
        <p role="status" className="mx-4 mb-3 text-xs text-ink-muted">
          {t("calendar.save.saving")}
        </p>
      )}

      {e.meetUrl && (
        <div className="flex flex-col gap-1.5 px-4 pb-4">
          <button
            type="button"
            onClick={() => notice("calendar.meetNotice")}
            className={`${secondaryButton} h-9 w-full justify-center`}
          >
            <VideoGlyph />
            {t("calendar.detail.joinMeet")}
          </button>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
            <span className="min-w-0 truncate">{e.meetUrl.replace(/^https:\/\//, "")}</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(e.meetUrl!).catch(() => undefined);
                toast.show(t("calendar.detail.linkCopied"));
              }}
              className="shrink-0 rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
            >
              {t("calendar.detail.copyLink")}
            </button>
          </p>
          <button
            type="button"
            aria-expanded={moreWays}
            onClick={() => setMoreWays((v) => !v)}
            className="flex items-center gap-1 self-start rounded-sm text-xs font-medium text-ink-muted hover:text-ink"
          >
            <DisclosureGlyph open={moreWays} />
            {t("calendar.detail.moreWays")}
          </button>
          {moreWays && (
            <p className="num pl-4 text-xs text-ink-muted">
              {t("calendar.detail.phone", { number: "+39 02 3046 4417", pin: pinOf(e.meetUrl) })}
            </p>
          )}
        </div>
      )}

      {invited && (
        <div className="border-t border-rule px-4 py-3">
          <RsvpBar event={e} barRef={rsvpRef} announce={announce} dateLabel={dateLabel} />
        </div>
      )}

      <ProjectRow e={e} project={project} projects={projects ?? []} me={me} />

      <Guests
        attendees={e.attendees}
        me={me}
        people={people}
        all={allGuests}
        onShowAll={() => setAllGuests(true)}
      />

      {e.location && (
        <Row label={t("calendar.detail.where")}>
          {/\d/.test(e.location) ? (
            <button
              type="button"
              onClick={() => notice("calendar.mapNotice")}
              className="text-left text-sm text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
            >
              {e.location}
            </button>
          ) : (
            <span className="text-sm text-ink">{e.location}</span>
          )}
        </Row>
      )}

      {e.description && (
        <Row label={t("calendar.detail.description")}>
          <UntrustedHtmlFrame
            html={descriptionHtml(e.description)}
            title={t("calendar.detail.descriptionFrame", { title: e.title })}
            height={
              moreText
                ? descriptionHeight(e.description)
                : Math.min(DESCRIPTION_MAX, descriptionHeight(e.description))
            }
          />
          {descriptionHeight(e.description) > DESCRIPTION_MAX && (
            <button
              type="button"
              onClick={() => setMoreText((v) => !v)}
              className={`${ghostButton} self-start`}
            >
              {moreText ? t("calendar.detail.showLess") : t("calendar.detail.showMore")}
            </button>
          )}
        </Row>
      )}

      <Row label={t("calendar.detail.reminders")}>
        <span className="text-sm text-ink">
          {e.reminders === "default"
            ? t("calendar.detail.remindersDefault")
            : e.reminders
                .map((r) => t(`calendar.detail.reminder.${r.method}`, { count: r.minutes }))
                .join(" · ")}
        </span>
      </Row>

      {e.calendarEmail && (
        <p className="px-4 pt-1 pb-3 text-xs text-ink-muted">
          {t("calendar.inMailbox", { email: e.calendarEmail })}
        </p>
      )}

      {/* Evento passato [A 1]: riassunto e task nate. Il riassunto lo decide
          il livello dati — solo chi ha partecipato, membro o no del progetto,
          come in Posta —, le task chi le vede. Evento futuro o in corso: la
          scheda di preparazione, solo per un membro del progetto dell'evento. */}
      {past ? (
        <MeetingSummary eventId={e.id} projectCode={project?.code ?? null} />
      ) : (
        e.hasPrep && project && <MeetingPrep eventId={e.id} project={project} />
      )}

      <footer className="mt-2 flex flex-col gap-3 border-t border-rule px-4 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => notice("calendar.googleNotice")}
            className={ghostButton}
          >
            {t("calendar.detail.openInGoogle")}
            <span aria-hidden="true">↗</span>
          </button>
          {e.isOrganizer && (
            <span className="ml-auto flex items-center gap-1">
              <button type="button" className={smallSecondary} onClick={() => onEdit(e)}>
                {t("calendar.detail.edit")}
              </button>
              <MenuButton
                menuLabel={t("calendar.detail.more")}
                ariaLabel={t("calendar.detail.more")}
                align="right"
                placement="above"
                className="grid size-7 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10"
                label={<MoreIcon />}
              >
                {(close) => (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={`${itemClass} text-critical`}
                    onClick={() => {
                      close();
                      if (e.seriesId) setDeleteScope(true);
                      else setConfirmDelete(true);
                    }}
                  >
                    {t("calendar.detail.delete")}
                  </button>
                )}
              </MenuButton>
            </span>
          )}
        </div>
        {!e.isOrganizer && organizer && (
          <p className="text-xs text-ink-muted">
            {t("calendar.detail.organizedBy", { name: organizer.name || organizer.email })}
          </p>
        )}
        {confirmDelete && (
          <InlineConfirm
            message={t("calendar.detail.deleteConfirm")}
            confirm={t("calendar.detail.delete")}
            cancelLabel={t("calendar.cancel")}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => {
              setConfirmDelete(false);
              doDelete("one");
            }}
          />
        )}
      </footer>
      {deleteScope && (
        <SeriesScopeDialog
          action="delete"
          dateLabel={dateLabel}
          onCancel={() => setDeleteScope(false)}
          onConfirm={(scope) => {
            setDeleteScope(false);
            doDelete(scope);
          }}
        />
      )}
    </>
  );
}

/** Il giorno di oggi del prototipo (locale): le parole «Today»/«Tomorrow». */
const todayKey = () => localDayKey(new Date(now()));

/** Un PIN finto ma stabile per «More ways to join». */
function pinOf(url: string): string {
  let h = 0;
  for (const c of url) h = (h * 31 + c.charCodeAt(0)) % 1_000_000_000;
  const s = String(h).padStart(9, "0");
  return `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}#`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-rule px-4 py-3">
      <h3 className="heading-group">{label}</h3>
      {children}
    </section>
  );
}

/**
 * Il progetto dell'evento [A 5]: codice + nome, chi l'ha deciso, «Change» →
 * i progetti di cui sono membro (ricerca oltre 8) e «No project». La scelta
 * vale per tutti quelli che vedono l'evento. Un progetto che non vedo non
 * compare (per me è «No project»).
 */
function ProjectRow({
  e,
  project,
  projects,
  me,
}: {
  e: CalendarEventDetail;
  project: Project | undefined;
  projects: Project[];
  me: string;
}) {
  const { t } = useTranslation();
  const setProject = useSetEventProject();
  const toast = useToast();
  const [q, setQ] = useState("");
  const mine = useMemo(() => projects.filter((p) => p.memberIds.includes(me)), [projects, me]);
  const shown = mine.filter(
    (p) => !q.trim() || `${p.code} ${p.name}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const choose = (projectId: string | null) =>
    setProject.mutate(
      { id: e.id, projectId },
      { onError: () => toast.error(t("calendar.detail.projectFailed")) },
    );
  return (
    <Row label={t("calendar.detail.project")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {project ? (
          <span className="min-w-0 text-sm text-ink">
            <span className="num mr-1.5 font-semibold tracking-[0.02em]">{project.code}</span>
            {project.name}
          </span>
        ) : (
          <span className="text-sm text-ink-muted">{t("calendar.detail.noProject")}</span>
        )}
        {project && (
          <span className="text-xs text-ink-muted">
            {e.projectBy === "manual"
              ? t("calendar.detail.setManually")
              : t("calendar.detail.suggested")}
          </span>
        )}
        <MenuButton
          menuLabel={t("calendar.detail.chooseProject")}
          align="right"
          wrapperClassName="ml-auto inline-flex"
          className={ghostButton}
          label={project ? t("calendar.detail.change") : t("calendar.detail.choose")}
        >
          {(close) => (
            <>
              {mine.length > PROJECT_SEARCH_FROM && (
                <input
                  value={q}
                  onChange={(ev) => setQ(ev.target.value)}
                  role="menuitem"
                  aria-label={t("calendar.detail.searchProjects")}
                  placeholder={t("calendar.detail.searchProjects")}
                  className={`${inputClass} mb-1 h-8 text-sm`}
                />
              )}
              {shown.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={p.id === e.projectId}
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    choose(p.id);
                  }}
                >
                  <span className="num w-9 shrink-0 text-xs font-semibold">{p.code}</span>
                  <span className="min-w-0 truncate">{p.name}</span>
                </button>
              ))}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={e.projectId === null}
                tabIndex={-1}
                className={`${itemClass} border-t border-rule`}
                onClick={() => {
                  close();
                  choose(null);
                }}
              >
                {t("calendar.detail.noProject")}
              </button>
            </>
          )}
        </MenuButton>
      </div>
    </Row>
  );
}

const responseKey: Record<string, string> = {
  accepted: "calendar.answer.yes",
  tentative: "calendar.answer.maybeShort",
  declined: "calendar.answer.no",
  needsAction: "calendar.answer.noReply",
};

function ResponseGlyph({ response }: { response: CalendarAttendee["response"] }) {
  if (response === "accepted") return <CheckGlyph size={12} />;
  if (response === "declined") return <CrossGlyph size={12} />;
  if (response === "tentative") {
    return (
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path
          d="M6 6a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.5V10M8 12.5v.01"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * Partecipanti: il riassunto in cifre, poi organizzatore, io, sì, forse,
 * nessuna risposta, no; la risposta a parole e con un glifo per forma, mai
 * solo colore. I primi 8, poi «Show all N».
 */
function Guests({
  attendees,
  me,
  people,
  all,
  onShowAll,
}: {
  attendees: CalendarAttendee[];
  me: string;
  people: ReturnType<typeof usePeople>["data"];
  all: boolean;
  onShowAll: () => void;
}) {
  const { t } = useTranslation();
  if (attendees.length === 0) return null;
  const sorted = [...attendees].sort((a, b) => {
    const r = (x: CalendarAttendee) =>
      x.organizer ? 0 : x.personId === me ? 1 : RANK[x.response]!;
    return r(a) - r(b) || a.name.localeCompare(b.name);
  });
  const count = (r: string) => attendees.filter((a) => a.response === r).length;
  const summary = [
    t("calendar.detail.guests", { count: attendees.length }),
    t("calendar.detail.yesCount", { count: count("accepted") }),
    count("tentative") ? t("calendar.detail.maybeCount", { count: count("tentative") }) : null,
    count("declined") ? t("calendar.detail.noCount", { count: count("declined") }) : null,
    count("needsAction")
      ? t("calendar.detail.noReplyCount", { count: count("needsAction") })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const shown = all ? sorted : sorted.slice(0, GUESTS_PREVIEW);
  return (
    <Row label={t("calendar.detail.participants")}>
      <p className="num text-sm text-ink">{summary}</p>
      <ul className="flex flex-col gap-0.5" data-guests>
        {shown.map((a) => {
          const person = a.personId ? people?.find((p) => p.id === a.personId) : undefined;
          const name = a.personId
            ? a.name
            : middleEllipsis(a.name && a.name !== a.email ? a.name : a.email);
          return (
            <li key={a.email} className="flex min-h-7 min-w-0 items-center gap-2 text-sm">
              {person ? (
                <Avatar person={person} />
              ) : (
                <span
                  aria-hidden="true"
                  className="grid size-[22px] shrink-0 place-items-center rounded-full border border-rule-strong text-[10px] text-ink-muted"
                >
                  @
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-ink" title={a.email}>
                {name}
                {a.organizer && (
                  <span className="ml-1.5 text-xs text-ink-muted">
                    {t("calendar.detail.organizer")}
                  </span>
                )}
                {a.personId === me && (
                  <span className="ml-1.5 text-xs text-ink-muted">{t("calendar.detail.you")}</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-ink-muted">
                <ResponseGlyph response={a.response} />
                {t(responseKey[a.response]!)}
              </span>
            </li>
          );
        })}
      </ul>
      {!all && attendees.length > GUESTS_PREVIEW && (
        <button type="button" onClick={onShowAll} className={`${ghostButton} self-start`}>
          {t("calendar.detail.showAll", { count: attendees.length })}
        </button>
      )}
    </Row>
  );
}
