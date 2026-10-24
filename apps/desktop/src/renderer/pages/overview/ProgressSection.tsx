import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../data/dates";
import { useMilestones, useProjectStatuses, useTasks } from "../../data/queries";
import type { FilterCriteria, Milestone, StatusFamily, Task } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { progress } from "../../domain/load";
import { DueDate } from "../../tasks-ui/TaskRow";
import { smallSecondary } from "../task/parts";
import { BlockSection, queryState } from "../home/blocks/BlockSection";
import { BriefCard } from "./BriefCard";
import { TasksLink, numberLink, shiftDate } from "./links";
import { MilestonesDialog } from "./MilestonesDialog";

/** «Closed in the last 2 weeks»: oggi e i 13 giorni prima, estremi inclusi. */
export const RECENT_DAYS = 14;

/** I traguardi aperti dal più vicino; quelli senza data in fondo, per nome. */
export function openMilestones(list: Milestone[]): Milestone[] {
  return list
    .filter((m) => !m.closed)
    .sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate || b.dueDate) return a.dueDate ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * «Where it stands» (la prima delle tre domande): i traguardi aperti con
 * data e avanzamento — taglie chiuse sulle totali come barra senza numero,
 * le task senza stima dichiarate —, quante task si sono chiuse nelle ultime
 * due settimane (un numero che apre l'elenco), il brief settimanale. Chi ha
 * `tickets.edit` gestisce i traguardi da «Manage milestones».
 */
export function ProgressSection({
  projectId,
  projectCode,
}: {
  projectId: string;
  projectCode: string;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const milestones = useMilestones(projectId);
  const tasks = useTasks({ projectIds: [projectId] });
  const statuses = useProjectStatuses(projectId);
  const [managing, setManaging] = useState<"list" | "new" | null>(null);
  const canEdit = can(viewer, "tickets.edit", projectId);

  const familyById = new Map((statuses.data ?? []).map((s) => [s.id, s.family]));
  const familyOf = (task: Task): StatusFamily => familyById.get(task.statusId) ?? "todo";
  const open = openMilestones(milestones.data ?? []);
  const from = shiftDate(TODAY, -(RECENT_DAYS - 1));
  const recent = (tasks.data ?? []).filter(
    (x) => x.closedAt && x.closedAt.slice(0, 10) >= from && familyOf(x) === "closed",
  ).length;
  const recentCriteria: FilterCriteria = {
    families: ["closed"],
    period: { field: "closed", kind: "absolute", from, to: TODAY },
  };

  return (
    <>
      <BlockSection
        title={t("overview.progress.title")}
        state={queryState([milestones, tasks, statuses])}
        action={
          canEdit ? (
            <button type="button" className={smallSecondary} onClick={() => setManaging("list")}>
              {t("overview.milestones.manage")}
            </button>
          ) : undefined
        }
      >
        {open.length === 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-2 border-t border-rule py-3 pl-4">
            <p className="text-md text-ink">
              {(milestones.data ?? []).length > 0
                ? t("overview.milestones.noneOpen")
                : t("overview.milestones.none")}
            </p>
            {canEdit ? (
              <button
                type="button"
                className={`${numberLink} text-md font-medium underline`}
                onClick={() => setManaging("new")}
              >
                {t("overview.milestones.addOne")}
              </button>
            ) : (
              <p className="text-sm text-ink-muted">{t("overview.milestones.whoCan")}</p>
            )}
          </div>
        ) : (
          <ul aria-label={t("overview.milestones.label")} className="border-t border-rule">
            {open.map((m) => (
              <MilestoneRow
                key={m.id}
                milestone={m}
                projectCode={projectCode}
                tasks={(tasks.data ?? []).filter((x) => x.milestoneId === m.id)}
                familyOf={familyOf}
              />
            ))}
          </ul>
        )}
        <div className="flex items-baseline gap-3 border-t border-rule py-3 pl-4">
          <span className="text-md text-ink-muted">{t("overview.progress.recent")}</span>
          <TasksLink
            projectCode={projectCode}
            criteria={recentCriteria}
            label={t("overview.progress.recentLink", { count: recent })}
            className={`${numberLink} num text-xl font-semibold`}
          >
            {recent}
          </TasksLink>
        </div>
        <BriefCard projectId={projectId} />
      </BlockSection>
      {managing && (
        <MilestonesDialog
          projectId={projectId}
          startWithNew={managing === "new"}
          onClose={() => setManaging(null)}
        />
      )}
    </>
  );
}

/**
 * Un traguardo: nome (apre le sue task) · scadenza · barra dell'avanzamento
 * · «N without estimate». La barra è il peso chiuso sul totale, mai un
 * numero a schermo; per i lettori di schermo dice la percentuale.
 */
function MilestoneRow({
  milestone,
  projectCode,
  tasks,
  familyOf,
}: {
  milestone: Milestone;
  projectCode: string;
  tasks: Task[];
  familyOf: (task: Task) => StatusFamily;
}) {
  const { t } = useTranslation();
  const { doneWeight, totalWeight, unsized } = progress(tasks, familyOf);
  const share = totalWeight > 0 ? doneWeight / totalWeight : 0;
  const percent = Math.round(share * 100);
  const overdue = !!milestone.dueDate && milestone.dueDate < TODAY;
  return (
    <li
      data-milestone-row={milestone.id}
      className="grid min-h-11 grid-cols-[minmax(0,1fr)_64px_minmax(96px,200px)_minmax(0,148px)] items-center gap-4 border-b border-rule py-2 pr-3 pl-4"
    >
      <TasksLink
        projectCode={projectCode}
        criteria={{ milestoneIds: [milestone.id] }}
        title={milestone.description || milestone.name}
        className={`${numberLink} min-w-0 truncate text-md font-medium`}
      >
        {milestone.name}
      </TasksLink>
      {milestone.dueDate ? (
        <DueDate date={milestone.dueDate} overdue={overdue} />
      ) : (
        <span className="text-right text-xs text-ink-faint">{t("overview.milestones.noDate")}</span>
      )}
      {tasks.length === 0 ? (
        <span className="text-xs text-ink-faint">{t("overview.milestones.noTasks")}</span>
      ) : (
        <span
          role="img"
          aria-label={
            totalWeight > 0
              ? t("overview.milestones.progress", { name: milestone.name, percent })
              : t("overview.milestones.progressUnknown", { name: milestone.name })
          }
          title={
            totalWeight > 0
              ? t("overview.milestones.progressShort", { percent })
              : t("overview.milestones.progressUnknownShort")
          }
          className="flex h-1.5 min-w-0 overflow-hidden rounded-full bg-ink/10"
        >
          <span
            className="h-full bg-ink transition-[width] duration-[var(--duration)] ease-out"
            style={{ width: `${share * 100}%` }}
          />
        </span>
      )}
      <span className="min-w-0 truncate text-xs text-ink-muted">
        {unsized > 0 ? t("overview.milestones.unsized", { count: unsized }) : ""}
      </span>
    </li>
  );
}
