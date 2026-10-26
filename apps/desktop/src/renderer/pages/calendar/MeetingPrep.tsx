import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../data/dates";
import { useMeetingPrep, usePeople, useProjectStatuses, useTasks } from "../../data/queries";
import type {
  FilterCriteria,
  MailThreadRow,
  MeetingPrep as Prep,
  Project,
  RecentMeeting,
  StatusFamily,
  Task,
} from "../../data/types";
import { DeptStrip } from "../../layout/DeptStrip";
import type { StallNames } from "../../tasks-ui/StallMark";
import { DueDate } from "../../tasks-ui/TaskRow";
import { useToast } from "../../tasks-ui/Toast";
import { queryState } from "../home/blocks/BlockSection";
import { AlertGlyph, ImportantGlyph } from "../mail/glyphs";
import { participantsLabel, DueLabel } from "../mail/ThreadRow";
import { whenLabel } from "../mail/format";
import { GeneratedTag } from "../overview/BriefCard";
import { TasksLink, numberLink, shiftDate } from "../overview/links";
import { MilestoneRow } from "../overview/ProgressSection";
import { pulseParts } from "../overview/pulseLine";
import { PulseText } from "../overview/PulseText";
import { STALLED, StalledRow } from "../overview/StalledSection";
import { ghostButton } from "../task/parts";
import { MeetingTaskList, SheetSection, useOpenTaskFromEvent } from "./meetingParts";

// La scheda di preparazione (shape meeting-prep.md §3–§6): dentro il
// dettaglio di un evento FUTURO o in corso, per un membro del suo progetto.
// Un promemoria a tre voci, sempre nello stesso ordine — Recent email · Last
// meetings · Project status — composto da dati, senza AI: il solo testo
// generato è il riassunto già scritto dalla trascrizione, e lo dice. Le
// email sono quelle di chi guarda (due persone alla stessa riunione vedono
// schede diverse); lo stato del progetto sono le stesse letture e le stesse
// righe dell'Overview. Ogni sezione ha i suoi stati.

/** Le ferme più vecchie nella scheda, poi «Show all» → Overview (shape §5). */
const STALLED_CAP = 3;

/** «Overdue» nelle Tasks: aperte con la scadenza prima di oggi (la regola di `isOverdue`). */
// Le Tasks non hanno un criterio «in ritardo»: nel prototipo un periodo con inizio arbitrario.
const OVERDUE: FilterCriteria = {
  families: ["todo", "active"],
  period: { field: "due", kind: "absolute", from: "2000-01-01", to: shiftDate(TODAY, -1) },
};
const IN_PROGRESS: FilterCriteria = { families: ["active"] };

export function MeetingPrep({ eventId, project }: { eventId: string; project: Project }) {
  const { t, i18n } = useTranslation();
  const prep = useMeetingPrep(eventId);
  const id = useId();
  // Evento passato, progetto non più mio: la scheda non c'è (il livello dati decide).
  if (prep.data === null) return null;
  const data = prep.data;
  return (
    <section
      aria-labelledby={id}
      data-meeting-prep={eventId}
      className="mt-1 flex flex-col border-t border-rule pt-3 pb-1"
    >
      <div className="flex flex-col gap-1 px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 id={id} className="heading-group shrink-0">
            {t("calendar.prep.title")}
          </h3>
          <Link
            to="/p/$code/$section"
            params={{ code: project.code, section: "overview" }}
            className={`${numberLink} min-w-0 truncate text-sm`}
          >
            <span className="num mr-1.5 font-semibold tracking-[0.02em]">{project.code}</span>
            {project.name}
          </Link>
        </div>
        {data && (
          <p className="text-sm text-ink-muted">
            <PulseText parts={pulseParts(data.pulse, t, i18n.language)} projectCode={project.code} />
          </p>
        )}
      </div>
      <RecentEmail prep={prep} code={project.code} />
      <LastMeetings prep={prep} project={project} eventId={eventId} />
      <ProjectStatus prep={prep} project={project} eventId={eventId} />
      <Link
        to="/p/$code/$section"
        params={{ code: project.code, section: "overview" }}
        className={`${ghostButton} mt-3 ml-2 self-start`}
      >
        {t("calendar.prep.openOverview", { code: project.code })}
        <span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}

type PrepQuery = ReturnType<typeof useMeetingPrep>;

/** La scheda come `data` di una query (mai `null` qui: chi la mostra l'ha già escluso). */
const prepOf = (q: PrepQuery): Prep | undefined => q.data ?? undefined;

// --- Recent email ---------------------------------------------------------------

function RecentEmail({ prep, code }: { prep: PrepQuery; code: string }) {
  const { t } = useTranslation();
  const rows = prepOf(prep)?.recentMail ?? [];
  return (
    <SheetSection
      title={t("calendar.prep.recentMail")}
      count={rows.length}
      state={queryState([prep], { when: rows.length === 0, text: t("calendar.prep.noMail", { code }) })}
    >
      <ul aria-label={t("calendar.prep.recentMail")} className="@container flex flex-col">
        {rows.map((row) => (
          <MailRow key={row.threadId} row={row} />
        ))}
      </ul>
    </SheetSection>
  );
}

/**
 * Una conversazione su una riga: punto non letto · mittenti · oggetto ·
 * importanza alta (glifo e parola, mai solo colore) · scadenza · data. Sotto
 * i 480 px resta un solo metadato a destra: la scadenza prima della data.
 */
function MailRow({ row }: { row: MailThreadRow }) {
  const { t, i18n } = useTranslation();
  const unread = row.unread > 0;
  return (
    <li>
      <Link
        to="/mail/$threadId"
        params={{ threadId: row.threadId }}
        title={row.subject}
        className="flex h-9 min-w-0 items-center gap-2 pr-4 pl-4 text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
      >
        <span className="flex w-2 shrink-0 justify-center">
          {unread && (
            <>
              <span aria-hidden="true" className="size-2 rounded-full bg-ink" />
              <span className="sr-only">{t("mail.row.unread")}</span>
            </>
          )}
        </span>
        <span
          className={`max-w-[38%] shrink-0 truncate text-ink ${unread ? "font-semibold" : "font-medium"}`}
        >
          {participantsLabel(row)}
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-muted">{row.subject}</span>
        {row.importance === "high" && (
          <span className="flex shrink-0 items-center text-ink" title={t("calendar.prep.important")}>
            <ImportantGlyph size={12} />
            <span className="sr-only">{t("calendar.prep.important")}</span>
          </span>
        )}
        {row.dueDate && (
          <span className="shrink-0 text-xs whitespace-nowrap">
            <DueLabel date={row.dueDate} />
          </span>
        )}
        <span
          className={`num shrink-0 text-xs text-ink-muted ${row.dueDate ? "@max-[480px]:hidden" : ""}`}
        >
          {whenLabel(row.lastAt, i18n.language)}
        </span>
      </Link>
    </li>
  );
}

// --- Last meetings ----------------------------------------------------------------

function LastMeetings({
  prep,
  project,
  eventId,
}: {
  prep: PrepQuery;
  project: Project;
  eventId: string;
}) {
  const { t } = useTranslation();
  const meetings = prepOf(prep)?.recentMeetings ?? [];
  return (
    <SheetSection
      title={t("calendar.prep.lastMeetings")}
      state={queryState([prep], {
        when: meetings.length === 0,
        text: t("calendar.prep.noMeetings", { code: project.code }),
      })}
    >
      <ul aria-label={t("calendar.prep.lastMeetings")} className="flex flex-col gap-1">
        {meetings.map((m) => (
          <MeetingItem key={m.eventId} meeting={m} project={project} eventId={eventId} />
        ))}
      </ul>
    </SheetSection>
  );
}

/**
 * Una riunione precedente: titolo (apre l'evento solo se lo vedo) e data;
 * per chi c'era il riassunto con «Generated text»; poi le cose da fare nate
 * lì. Chi non c'era non trova nulla che dica che un riassunto esiste [A 2].
 */
function MeetingItem({
  meeting: m,
  project,
  eventId,
}: {
  meeting: RecentMeeting;
  project: Project;
  eventId: string;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const date = new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }).format(
    new Date(m.at),
  );
  return (
    <li data-recent-meeting={m.eventId} className="flex flex-col gap-1.5 pb-1">
      <div className="flex min-w-0 items-baseline gap-2 px-4 pt-1">
        {m.canOpen ? (
          <button
            type="button"
            onClick={() =>
              void navigate({
                to: ".",
                search: (prev: Record<string, unknown>) => ({ ...prev, event: m.eventId }),
              } as never)
            }
            className="min-w-0 truncate rounded-sm text-left text-sm font-medium text-ink underline-offset-4 decoration-ink/40 hover:underline"
          >
            {m.title}
          </button>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium text-ink">{m.title}</span>
        )}
        <span className="num shrink-0 text-xs text-ink-muted">{date}</span>
      </div>
      {m.summary && <SummaryExcerpt text={m.summary} />}
      {m.doc === "reading" && (
        <p className="px-4 text-sm text-ink-muted">{t("calendar.summary.reading")}</p>
      )}
      {m.doc === "unreachable" && <TranscriptUnreachable />}
      <MeetingTaskList
        tasks={m.tasks}
        projectCode={project.code}
        eventId={eventId}
        label={t("calendar.prep.meetingTasks", { title: m.title })}
        empty={
          m.doc === "unreachable" ? t("calendar.prep.noTasksYet") : t("calendar.prep.noTasks")
        }
      />
    </li>
  );
}

/** Tre righe del riassunto, poi «Read more» che espande sul posto (200 ms, niente con meno movimento). */
function SummaryExcerpt({ text }: { text: string }) {
  const { t } = useTranslation();
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text]);
  return (
    <div className="flex flex-col items-start gap-1 px-4">
      <span className="flex items-center gap-2">
        <span className="text-xs text-ink-muted">{t("calendar.prep.summary")}</span>
        <GeneratedTag />
      </span>
      <p
        id={id}
        ref={ref}
        className={`overflow-hidden text-sm text-ink transition-[max-height] duration-200 ease-out motion-reduce:transition-none ${open ? "max-h-[40rem]" : "max-h-[54px]"}`}
      >
        {text}
      </p>
      {(long || open) && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="rounded-sm text-xs font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
        >
          {open ? t("calendar.prep.readLess") : t("calendar.prep.readMore")}
        </button>
      )}
    </div>
  );
}

/** Il documento della trascrizione non si apre: lo dice, e «Open in Google Docs» (avviso del prototipo). */
export function TranscriptUnreachable() {
  const { t } = useTranslation();
  const toast = useToast();
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 px-4 text-sm text-ink">
      <span className="text-warning">
        <AlertGlyph size={12} />
      </span>
      {t("calendar.summary.unreachable")}
      <span aria-hidden="true" className="text-ink-faint">
        ·
      </span>
      <button
        type="button"
        onClick={() => toast.show(t("calendar.summary.docsNotice"))}
        className="rounded-sm font-medium underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
      >
        {t("calendar.summary.openInDocs")}
      </button>
    </p>
  );
}

// --- Project status -----------------------------------------------------------------

/**
 * Lo stato del progetto con le letture e le righe dell'Overview: i conteggi
 * come link alle Tasks filtrate, le ferme più vecchie (`StalledRow`), i
 * traguardi aperti (`MilestoneRow` compatta), le prossime scadenze. Ogni
 * parte vuota sparisce; tutto vuoto → «Nothing open on AUD».
 */
function ProjectStatus({
  prep,
  project,
  eventId,
}: {
  prep: PrepQuery;
  project: Project;
  eventId: string;
}) {
  const { t } = useTranslation();
  const tasks = useTasks({ projectIds: [project.id] });
  const statuses = useProjectStatuses(project.id);
  const people = usePeople();
  const openTask = useOpenTaskFromEvent(eventId);
  const status = prepOf(prep)?.status;
  const nothing =
    !!status &&
    status.inProgress === 0 &&
    status.late === 0 &&
    status.stalled.length === 0 &&
    status.milestones.length === 0 &&
    status.nextDueDates.length === 0;
  const state = queryState([prep, tasks, statuses, people], {
    when: nothing,
    text: t("calendar.prep.nothingOpen", { code: project.code }),
  });
  const familyById = new Map((statuses.data ?? []).map((s) => [s.id, s.family]));
  const familyOf = (task: Task): StatusFamily => familyById.get(task.statusId) ?? "todo";
  const names: StallNames = {
    personName: (id) => people.data?.find((p) => p.id === id)?.name,
    taskCode: (id) => tasks.data?.find((x) => x.id === id)?.code,
  };
  const counts = status
    ? (
        [
          ["inProgress", status.inProgress, IN_PROGRESS],
          ["overdue", status.late, OVERDUE],
          ["stalled", status.stalled.length, STALLED],
        ] as const
      ).filter(([, n]) => n > 0)
    : [];
  return (
    <SheetSection title={t("calendar.prep.status")} state={state}>
      {status && (
        <div className="flex flex-col gap-2">
          {counts.length > 0 && (
            <p className="num flex flex-wrap items-baseline gap-x-1.5 px-4 text-sm">
              {counts.map(([key, n, criteria], i) => (
                <span key={key} className="inline-flex items-baseline gap-1.5">
                  {i > 0 && (
                    <span aria-hidden="true" className="text-ink-faint">
                      ·
                    </span>
                  )}
                  <TasksLink
                    projectCode={project.code}
                    criteria={criteria}
                    label={t("calendar.prep.countLink", { label: t(`calendar.prep.${key}`), count: n })}
                    className={`${numberLink} ${key === "overdue" ? "text-critical" : ""}`}
                  >
                    <span className={key === "overdue" ? "text-critical" : "text-ink-muted"}>
                      {t(`calendar.prep.${key}`)}
                    </span>{" "}
                    <span className="font-semibold">{n}</span>
                  </TasksLink>
                </span>
              ))}
            </p>
          )}
          {status.stalled.length > 0 && (
            <div className="flex flex-col">
              <ul aria-label={t("calendar.prep.stalled")} className="border-t border-rule">
                {status.stalled.slice(0, STALLED_CAP).map(({ task, stall }) => (
                  <StalledRow
                    key={task.id}
                    compact
                    task={task}
                    stall={stall}
                    names={names}
                    onOpen={() => openTask(task.code)}
                  />
                ))}
              </ul>
              {status.stalled.length > STALLED_CAP && (
                <Link
                  to="/p/$code/$section"
                  params={{ code: project.code, section: "overview" }}
                  className={`${ghostButton} mt-0.5 ml-2 self-start`}
                >
                  {t("calendar.prep.showAllStalled", { count: status.stalled.length })}
                </Link>
              )}
            </div>
          )}
          {status.milestones.length > 0 && (
            <ul aria-label={t("calendar.prep.milestones")} className="border-t border-rule">
              {status.milestones.map((m) => (
                <MilestoneRow
                  key={m.id}
                  compact
                  milestone={m}
                  projectCode={project.code}
                  tasks={(tasks.data ?? []).filter((x) => x.milestoneId === m.id)}
                  familyOf={familyOf}
                />
              ))}
            </ul>
          )}
          {status.nextDueDates.length > 0 && (
            <div className="flex flex-col">
              <p className="px-4 pb-1 text-xs text-ink-muted">{t("calendar.prep.nextDue")}</p>
              <ul aria-label={t("calendar.prep.nextDue")} className="flex flex-col">
                {status.nextDueDates.map((task) => (
                  <li
                    key={task.id}
                    data-task-row={task.code}
                    title={task.title}
                    className="relative flex h-9 items-center gap-3 pr-4 pl-4 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
                  >
                    <DeptStrip departmentId={task.departmentId} />
                    <button
                      type="button"
                      onClick={() => openTask(task.code)}
                      className="flex min-w-0 flex-1 items-baseline gap-2 text-left outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
                    >
                      <span className="num w-[4.5rem] shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
                        {task.code}
                      </span>
                      <span className="min-w-0 truncate text-sm text-ink">{task.title}</span>
                    </button>
                    <DueDate date={task.dueDate} overdue={false} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </SheetSection>
  );
}
