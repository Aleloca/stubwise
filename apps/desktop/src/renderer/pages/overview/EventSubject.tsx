import { useTranslation } from "react-i18next";
import type { Milestone, Task, TimelineEvent } from "../../data/types";
import { useOpenTask } from "../home/blocks/BlockSection";

type TaskEvent = Extract<TimelineEvent, { taskId: string; kind: `task_${"opened" | "closed"}` | `pr_${string}` }>;

/**
 * Il soggetto di una voce di task o di PR, per la cronologia e l'attività:
 * la task la apre. Se la task non è fra quelle lette (oltre il tetto della
 * lista, o non più visibile) la voce non resta vuota: lo dice (review della
 * fetta 4). Il numero della PR c'è solo se il server lo sa.
 */
export function TaskEventSubject({ event, tasks }: { event: TaskEvent; tasks: Task[] }) {
  const { t } = useTranslation();
  const openTask = useOpenTask();
  const task = tasks.find((x) => x.id === event.taskId);
  const number =
    "number" in event && event.number !== undefined ? (
      <span className="num shrink-0 text-xs text-ink-muted">
        {t("overview.timeline.prNumber", { number: event.number })}
      </span>
    ) : null;
  if (!task) {
    return (
      <span className="flex min-w-0 items-baseline gap-2">
        {number}
        <span className="min-w-0 truncate text-ink-faint">{t("overview.timeline.taskUnavailable")}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => openTask(task.code)}
      className="flex min-w-0 items-baseline gap-2 text-left outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
    >
      {number}
      <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">{task.code}</span>
      <span className="min-w-0 truncate text-ink" title={task.title}>
        {task.title}
      </span>
    </button>
  );
}

/** Il traguardo di una voce; uno che non c'è più fra quelli del progetto è stato eliminato. */
export function MilestoneEventSubject({ milestoneId, milestones }: { milestoneId: string; milestones: Milestone[] }) {
  const { t } = useTranslation();
  const m = milestones.find((x) => x.id === milestoneId);
  return m ? (
    <span className="min-w-0 truncate text-ink">{m.name}</span>
  ) : (
    <span className="min-w-0 truncate text-ink-faint">{t("overview.timeline.milestoneUnavailable")}</span>
  );
}
