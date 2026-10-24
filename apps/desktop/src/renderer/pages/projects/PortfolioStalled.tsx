import { useTranslation } from "react-i18next";
import { usePeople, useStalled, useTasks } from "../../data/queries";
import type { Project, Task } from "../../data/types";
import type { Stall } from "../../domain/stalled";
import { DeptLegend } from "../../layout/DeptStrip";
import { PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import type { StallNames } from "../../tasks-ui/StallMark";
import { useOpenTask } from "../home/blocks/BlockSection";
import { TasksLink, countLinkClass } from "../overview/links";
import { STALLED, StalledRow } from "../overview/StalledSection";

/**
 * «Stalled» del portafoglio: le task ferme di tutti i progetti mostrati,
 * raggruppate per progetto. I gruppi in ordine di ferma più vecchia, e
 * dentro ogni gruppo dalla più vecchia: la stessa riga dell'Overview
 * (giorni, task, motivo vero). Il conteggio del gruppo apre le Tasks di
 * quel progetto filtrate sulle ferme; una riga apre la task nel pannello.
 */
export function PortfolioStalled({ projects }: { projects: Project[] }) {
  const { t } = useTranslation();
  const stalled = useStalled();
  const tasks = useTasks();
  const people = usePeople().data;
  const openTask = useOpenTask();

  if (stalled.isError) {
    return (
      <PageError message={t("projects.stalled.error")} onRetry={() => void stalled.refetch()} />
    );
  }
  if (!stalled.data) return <PageSkeleton rows={6} />;

  const shownIds = new Set(projects.map((p) => p.id));
  const groups = new Map<string, { task: Task; stall: Stall }[]>();
  // `listStalled` le dà già dalla più vecchia: il primo gruppo che compare è quello con la ferma più vecchia.
  for (const row of stalled.data) {
    if (!shownIds.has(row.task.projectId)) continue;
    const list = groups.get(row.task.projectId) ?? [];
    list.push(row);
    groups.set(row.task.projectId, list);
  }
  if (groups.size === 0) {
    return (
      <div className="flex max-w-[60ch] flex-col gap-1 px-4 py-10">
        <h2 className="text-lg font-semibold text-ink">{t("projects.stalled.emptyTitle")}</h2>
        <p className="text-md text-ink-muted">{t("projects.stalled.emptyBody")}</p>
      </div>
    );
  }
  const names: StallNames = {
    personName: (id) => people?.find((p) => p.id === id)?.name,
    taskCode: (id) => tasks.data?.find((x) => x.id === id)?.code,
  };
  const byId = new Map(projects.map((p) => [p.id, p]));
  const all = [...groups.values()].flat();
  return (
    <div>
      <div className="flex h-11 items-center pl-4">
        <DeptLegend departmentIds={all.map((r) => r.task.departmentId)} />
      </div>
      {[...groups].map(([projectId, rows]) => {
        const project = byId.get(projectId)!;
        return (
          <section
            key={projectId}
            aria-labelledby={`stalled-${project.code}`}
            data-stalled-project={project.code}
            className="pb-4"
          >
            <h2
              id={`stalled-${project.code}`}
              className="flex h-9 min-w-0 items-end gap-3 pb-2 pl-4 text-sm"
            >
              <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
                {project.code}
              </span>
              <span className="min-w-0 truncate font-semibold text-ink">{project.name}</span>
              <TasksLink
                projectCode={project.code}
                criteria={STALLED}
                label={t("projects.stalled.countLink", { count: rows.length, code: project.code })}
                className={`num ${countLinkClass}`}
              >
                {rows.length}
              </TasksLink>
            </h2>
            <ul aria-label={`${project.code} ${project.name}`} className="border-t border-rule">
              {rows.map(({ task, stall }) => (
                <StalledRow
                  key={task.id}
                  task={task}
                  stall={stall}
                  names={names}
                  onOpen={() => openTask(task.code)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
