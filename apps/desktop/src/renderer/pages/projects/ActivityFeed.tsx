import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../data/dates";
import { useMilestones, usePortfolioActivity, useTasks } from "../../data/queries";
import type { Milestone, PortfolioEvent, Project, Task } from "../../data/types";
import { PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { ghostButton } from "../task/parts";
import { useOpenTask } from "../home/blocks/BlockSection";
import { GeneratedTag } from "../overview/BriefCard";
import { shiftDate } from "../overview/links";

/** Quanti giorni (con voci) si vedono, e quanti ne aggiunge «Show earlier». */
export const DAYS_STEP = 7;

/**
 * «Activity» del portafoglio: ciò che è successo nei progetti mostrati, per
 * giorno, dal più recente — le stesse voci della cronologia di ogni progetto
 * (task aperte e chiuse, traguardi, decisioni, brief, report, PR), col
 * progetto accanto. Sette giorni, poi «Show earlier». Brief e report portano
 * «Generated text»; le voci di una task la aprono nel pannello.
 */
export function ActivityFeed({ projects }: { projects: Project[] }) {
  const { t, i18n } = useTranslation();
  const activity = usePortfolioActivity();
  const tasks = useTasks();
  const milestones = useMilestones();
  const [days, setDays] = useState(DAYS_STEP);

  const queries = [activity, tasks, milestones];
  const failed = queries.filter((q) => q.isError);
  if (failed.length > 0) {
    return (
      <PageError
        message={t("projects.activity.error")}
        onRetry={() => {
          for (const q of failed) void q.refetch();
        }}
      />
    );
  }
  if (queries.some((q) => q.data === undefined)) return <PageSkeleton rows={8} />;

  const byId = new Map(projects.map((p) => [p.id, p]));
  const groups: { day: string; events: PortfolioEvent[] }[] = [];
  for (const e of activity.data!) {
    if (!byId.has(e.projectId)) continue;
    const day = e.at.slice(0, 10);
    const last = groups.at(-1);
    if (last?.day === day) last.events.push(e);
    else groups.push({ day, events: [e] });
  }
  if (groups.length === 0) {
    return (
      <div className="flex max-w-[60ch] flex-col gap-1 px-4 py-10">
        <h2 className="text-lg font-semibold text-ink">{t("projects.activity.emptyTitle")}</h2>
        <p className="text-md text-ink-muted">{t("projects.activity.emptyBody")}</p>
      </div>
    );
  }
  const dayTitle = (day: string) => {
    if (day === TODAY) return t("projects.activity.today");
    if (day === shiftDate(TODAY, -1)) return t("projects.activity.yesterday");
    return new Date(`${day}T00:00:00Z`).toLocaleDateString(i18n.language, {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  };
  const shown = groups.slice(0, days);
  return (
    <div>
      {shown.map((g) => (
        <section key={g.day} aria-label={dayTitle(g.day)} data-activity-day={g.day}>
          <h2 className="flex h-11 items-end gap-2 pb-2 pl-4">
            <span className="heading-group">{dayTitle(g.day)}</span>
            <span className="num text-xs text-ink-faint">{g.events.length}</span>
          </h2>
          <ul className="border-t border-rule">
            {g.events.map((e, i) => (
              <ActivityRow
                key={`${e.kind}:${i}`}
                event={e}
                project={byId.get(e.projectId)!}
                tasks={tasks.data!}
                milestones={milestones.data!}
              />
            ))}
          </ul>
        </section>
      ))}
      {groups.length > shown.length && (
        <button
          type="button"
          className={`${ghostButton} mt-2 ml-2`}
          onClick={() => setDays((d) => d + DAYS_STEP)}
        >
          {t("projects.activity.showEarlier")}
        </button>
      )}
    </div>
  );
}

/** Una voce: progetto (codice e nome) · che cosa è successo · di che cosa. */
function ActivityRow({
  event,
  project,
  tasks,
  milestones,
}: {
  event: PortfolioEvent;
  project: Project;
  tasks: Task[];
  milestones: Milestone[];
}) {
  const { t } = useTranslation();
  const openTask = useOpenTask();
  let subject: ReactNode = null;
  let generated = false;
  switch (event.kind) {
    case "task_opened":
    case "task_closed":
    case "pr_opened":
    case "pr_merged":
    case "pr_closed": {
      const task = tasks.find((x) => x.id === event.taskId);
      subject = task ? (
        <button
          type="button"
          onClick={() => openTask(task.code)}
          className="flex min-w-0 items-baseline gap-2 text-left outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
        >
          {"number" in event && (
            <span className="num shrink-0 text-xs text-ink-muted">
              {t("overview.timeline.prNumber", { number: event.number })}
            </span>
          )}
          <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
            {task.code}
          </span>
          <span className="min-w-0 truncate text-ink" title={task.title}>
            {task.title}
          </span>
        </button>
      ) : null;
      break;
    }
    case "milestone":
      subject = (
        <span className="min-w-0 truncate text-ink">
          {milestones.find((m) => m.id === event.milestoneId)?.name ?? ""}
        </span>
      );
      break;
    case "decision":
      subject = <span className="min-w-0 truncate text-ink">{event.title}</span>;
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
      data-activity-event={event.kind}
      data-activity-project={project.code}
      className="@container relative border-b border-rule text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
    >
      <div className="grid h-9 grid-cols-[minmax(0,200px)_132px_minmax(0,1fr)] items-center gap-3 pr-3 pl-4 @max-[640px]:grid-cols-[48px_112px_minmax(0,1fr)]">
        <span className="flex min-w-0 items-baseline gap-2" title={project.name}>
          <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
            {project.code}
          </span>
          <span className="min-w-0 truncate text-ink-muted @max-[640px]:sr-only">
            {project.name}
          </span>
        </span>
        <span className="truncate text-ink-muted">{t(`overview.timeline.kinds.${event.kind}`)}</span>
        <span className="flex min-w-0 items-center gap-2">
          {subject}
          {generated && <GeneratedTag />}
        </span>
      </div>
    </li>
  );
}
