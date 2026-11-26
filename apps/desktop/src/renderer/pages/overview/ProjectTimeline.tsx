import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TODAY, isoWeek } from "../../data/dates";
import { useMilestones, useTasks, useTimeline } from "../../data/queries";
import type { Milestone, Task, TimelineEvent, TimelineKind } from "../../data/types";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { formatDue } from "../../tasks-ui/TaskRow";
import { ghostButton } from "../task/parts";
import { BlockSection, queryState } from "../home/blocks/BlockSection";
import { Chevron, MenuButton } from "../tasks/controls";
import { GeneratedTag } from "./BriefCard";
import { DeletedTaskSubject } from "./DeletedTaskSubject";
import { MilestoneEventSubject, TaskEventSubject } from "./EventSubject";
import { shiftDate } from "./links";
import { useToday } from "../../data/clock";

/** I tipi del filtro: un tipo può raccogliere più voci (task aperte e chiuse, i tre eventi delle PR). */
export const TIMELINE_TYPES = [
  "all",
  "tasks",
  "milestones",
  "decisions",
  "briefs",
  "reports",
  "prs",
] as const;
export type TimelineType = (typeof TIMELINE_TYPES)[number];

const KINDS_OF: Record<Exclude<TimelineType, "all">, readonly TimelineKind[]> = {
  tasks: ["task_opened", "task_closed"],
  milestones: ["milestone"],
  decisions: ["decision"],
  briefs: ["brief"],
  reports: ["daily_report"],
  prs: ["pr_opened", "pr_merged", "pr_closed"],
};

/** Quante settimane si vedono, e quante ne aggiunge «Show earlier». */
export const WEEKS_STEP = 3;

/**
 * Con un tipo scelto, una pagina di 28 giorni può non aggiungere niente:
 * «Show earlier» continua a chiedere pagine finché trova qualcosa o la storia
 * finisce, al massimo queste (review della fetta 4), poi lo dice.
 */
export const MAX_CHASED_PAGES = 6;

/** Il lunedì della settimana di una data. */
function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return shiftDate(date, -(dow - 1));
}

interface WeekGroup {
  /** `upcoming` (dopo oggi) o la settimana ISO. */
  key: string;
  monday: string | null;
  events: TimelineEvent[];
}

/**
 * Le voci per settimana, dalla più recente: in testa «Upcoming» (ciò che ha
 * una data dopo oggi, cioè i traguardi in arrivo), poi una settimana per
 * gruppo. Le settimane senza voci non ci sono.
 */
export function groupByWeek(events: TimelineEvent[]): WeekGroup[] {
  const groups: WeekGroup[] = [];
  const upcoming = events.filter((e) => e.at.slice(0, 10) > TODAY).reverse();
  if (upcoming.length > 0) groups.push({ key: "upcoming", monday: null, events: upcoming });
  for (const e of events) {
    const day = e.at.slice(0, 10);
    if (day > TODAY) continue;
    const key = isoWeek(day);
    const last = groups.at(-1);
    if (last && last.key === key) last.events.push(e);
    else groups.push({ key, monday: mondayOf(day), events: [e] });
  }
  return groups;
}

/**
 * «Timeline» (la Roadmap del web): per settimana, filtrabile per tipo —
 * task aperte e chiuse, traguardi, decisioni, brief, report giornalieri,
 * PR. Tre settimane, poi «Show earlier». Le voci di una task la aprono nel
 * pannello; brief e report portano l'etichetta «Generated text».
 */
export function ProjectTimeline({ projectId }: { projectId: string }) {
  // «Oggi» avanza nella build app: a mezzanotte si ridisegna.
  useToday();
  const { t, i18n } = useTranslation();
  const timeline = useTimeline(projectId);
  const tasks = useTasks({ projectIds: [projectId] });
  const milestones = useMilestones(projectId);
  const [type, setType] = useState<TimelineType>("all");
  const [weeks, setWeeks] = useState(WEEKS_STEP);
  /** Le pagine chieste per un «Show earlier»: quante voci c'erano, quale pagina si aspetta, quante. */
  const [chase, setChase] = useState<{ before: number; waitFor: number; asked: number } | null>(null);
  const [nothingFound, setNothingFound] = useState(false);

  const events = (timeline.data ?? []).filter(
    (e) => type === "all" || KINDS_OF[type].includes(e.kind),
  );

  useEffect(() => {
    if (!chase || timeline.pages < chase.waitFor) return;
    if (events.length > chase.before || timeline.isError) return setChase(null);
    if (timeline.hasMore && chase.asked < MAX_CHASED_PAGES) {
      setChase({ ...chase, waitFor: timeline.pages + 1, asked: chase.asked + 1 });
      timeline.loadOlder();
      return;
    }
    setChase(null);
    setNothingFound(true);
  }, [chase, timeline, events.length]);
  const groups = groupByWeek(events);
  // «Upcoming» non conta fra le settimane caricate.
  const limit = groups[0]?.key === "upcoming" ? weeks + 1 : weeks;
  const shown = groups.slice(0, limit);
  const state = queryState([timeline, tasks, milestones], {
    when: events.length === 0,
    text: type === "all" ? t("overview.timeline.empty") : t("overview.timeline.emptyType"),
  });

  const filter = (
    <MenuButton
      menuLabel={t("overview.timeline.type")}
      align="right"
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/8"
      label={
        <>
          <span>{t("overview.timeline.type")}:</span>
          <span className="font-medium text-ink">{t(`overview.timeline.types.${type}`)}</span>
          <Chevron />
        </>
      }
    >
      {(close) => (
        <MenuGroup>
          {TIMELINE_TYPES.map((x) => (
            <RadioItem
              key={x}
              checked={x === type}
              onSelect={() => {
                close();
                setType(x);
                setWeeks(WEEKS_STEP);
                setChase(null);
                setNothingFound(false);
              }}
            >
              {t(`overview.timeline.types.${x}`)}
            </RadioItem>
          ))}
        </MenuGroup>
      )}
    </MenuButton>
  );

  const weekTitle = (g: WeekGroup) => {
    if (!g.monday) return t("overview.timeline.upcoming");
    if (g.key === isoWeek(TODAY)) return t("overview.timeline.thisWeek");
    if (g.key === isoWeek(shiftDate(TODAY, -7))) return t("overview.timeline.lastWeek");
    return t("overview.timeline.weekOf", { date: formatDue(g.monday, i18n.language) });
  };

  return (
    <BlockSection title={t("overview.timeline.title")} state={state} action={filter}>
      <div className="border-t border-rule">
        {shown.map((g) => (
          <section key={g.key} aria-label={weekTitle(g)} data-timeline-week={g.key}>
            <h3 className="heading-group flex h-9 items-end pb-2 pl-4">{weekTitle(g)}</h3>
            <ul className="border-t border-rule">
              {g.events.map((e) => (
                <TimelineRow
                  key={eventKey(e)}
                  event={e}
                  tasks={tasks.data ?? []}
                  milestones={milestones.data ?? []}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {/* Prima le settimane già lette; finite quelle, la pagina prima dal server («Load older»). */}
      {(groups.length > shown.length || timeline.hasMore) && (
        <button
          type="button"
          className={`${ghostButton} mt-1 ml-2`}
          disabled={timeline.loadingOlder || chase !== null}
          onClick={() => {
            setNothingFound(false);
            if (groups.length <= shown.length + WEEKS_STEP && timeline.hasMore) {
              setChase({ before: events.length, waitFor: timeline.pages + 1, asked: 1 });
              timeline.loadOlder();
            }
            setWeeks((w) => w + WEEKS_STEP);
          }}
        >
          {t("overview.timeline.showEarlier")}
        </button>
      )}
      {nothingFound && (
        <p role="status" className="mt-1 ml-4 text-sm text-ink-muted">
          {t("overview.timeline.nothingInWeeks")}
        </p>
      )}
    </BlockSection>
  );
}

function eventKey(e: TimelineEvent): string {
  switch (e.kind) {
    case "task_opened":
    case "task_closed":
    case "task_deleted":
      return `${e.kind}:${e.taskId}`;
    case "milestone":
      return `${e.kind}:${e.milestoneId}`;
    case "decision":
      return `${e.kind}:${e.decisionId}`;
    case "brief":
      return `${e.kind}:${e.briefId}`;
    case "daily_report":
      return `${e.kind}:${e.reportId}`;
    default:
      return `${e.kind}:${e.prId}`;
  }
}

/** Una voce: data · che cosa è successo · di che cosa. */
function TimelineRow({
  event,
  tasks,
  milestones,
}: {
  event: TimelineEvent;
  tasks: Task[];
  milestones: Milestone[];
}) {
  const { t, i18n } = useTranslation();
  let subject: ReactNode = null;
  let generated = false;
  switch (event.kind) {
    case "task_opened":
    case "task_closed":
    case "pr_opened":
    case "pr_merged":
    case "pr_closed":
      subject = <TaskEventSubject event={event} tasks={tasks} />;
      break;
    case "milestone":
      subject = <MilestoneEventSubject milestoneId={event.milestoneId} milestones={milestones} />;
      break;
    case "decision":
      subject = <span className="min-w-0 truncate text-ink">{event.title}</span>;
      break;
    case "task_deleted":
      subject = <DeletedTaskSubject event={event} />;
      break;
    case "brief":
      generated = true;
      subject = <span className="min-w-0 truncate text-ink-muted">{event.headline}</span>;
      break;
    case "daily_report":
      generated = event.summary !== null;
      subject = (
        <span className={`min-w-0 truncate ${event.summary ? "text-ink-muted" : "text-ink-faint"}`}>
          {event.summary ?? t("overview.timeline.noSummary")}
        </span>
      );
      break;
  }
  return (
    <li
      data-timeline-event={event.kind}
      className="relative grid h-9 grid-cols-[56px_132px_minmax(0,1fr)] items-center gap-3 border-b border-rule pr-3 pl-4 text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
    >
      <span className="num text-xs text-ink-muted">
        {formatDue(event.at.slice(0, 10), i18n.language)}
      </span>
      <span className="truncate text-ink-muted">{t(`overview.timeline.kinds.${event.kind}`)}</span>
      <span className="flex min-w-0 items-center gap-2">
        {subject}
        {generated && <GeneratedTag />}
      </span>
    </li>
  );
}
