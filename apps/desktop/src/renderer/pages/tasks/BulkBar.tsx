import { useTranslation } from "react-i18next";
import { useBulkUpdateTasks, useMilestones, useProjectStatuses } from "../../data/queries";
import type { Task, TaskPatch } from "../../data/types";
import { MenuGroup, MenuNote } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { Chevron, MenuButton } from "./controls";
import {
  AssigneeOptions,
  MilestoneOptions,
  SizeOptions,
  StatusOptions,
  WeekOptions,
  useProjectMembers,
} from "./pickers";

const barButton =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-expanded:bg-ink/10";

/** Il valore comune a tutte le task, se c'è: il menu lo segna come scelto. */
function common<T>(tasks: Task[], pick: (t: Task) => T): T | undefined {
  const first = pick(tasks[0]!);
  return tasks.every((t) => pick(t) === first) ? first : undefined;
}

/**
 * Le azioni sulle task selezionate (solo con `tickets.edit`): stato,
 * assegnatario, settimana, traguardo, taglia, e «Clear». Galleggia in fondo
 * all'elenco finché la selezione c'è — è l'unica superficie della pagina con
 * l'ombra, perché sta sopra le righe. Ogni scelta vale per tutte, subito; se
 * non riesce tornano com'erano e il messaggio lo dice. Stato, assegnatario e
 * traguardo sono del progetto: con task di più progetti il menu lo spiega.
 */
export function BulkBar({ tasks, onClear }: { tasks: Task[]; onClear: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const bulk = useBulkUpdateTasks();
  const projectIds = new Set(tasks.map((task) => task.projectId));
  const projectId = projectIds.size === 1 ? tasks[0]!.projectId : undefined;
  // Con più progetti le letture restano vuote: i menu mostrano la nota.
  const statuses = useProjectStatuses(projectId ?? "").data;
  const milestones = useMilestones(projectId ?? "").data;
  const members = useProjectMembers(projectId);

  const apply = (patch: TaskPatch) => {
    const ids = tasks.map((task) => task.id);
    const count = ids.length;
    bulk.mutate(
      { ids, patch },
      {
        onSuccess: () => toast.show(t("tasks.bulk.done", { count })),
        onError: () => toast.error(t("tasks.bulk.failed", { count })),
      },
    );
  };

  const oneProjectNote = <MenuNote>{t("tasks.bulk.oneProject")}</MenuNote>;
  const label = (key: string) => (
    <>
      {t(`tasks.bulk.${key}`)}
      <Chevron />
    </>
  );

  return (
    <section
      aria-label={t("tasks.bulk.label")}
      data-bulk-bar
      className="toast-enter sticky bottom-4 z-20 mx-auto mt-4 flex w-max max-w-[calc(100%-32px)] flex-wrap items-center gap-1 rounded-lg border border-rule-strong bg-surface py-1.5 pr-1.5 pl-3.5 shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
    >
      <span role="status" className="num mr-2 text-sm font-semibold text-ink">
        {t("tasks.bulk.selected", { count: tasks.length })}
      </span>
      <span aria-hidden="true" className="mr-1 h-5 w-px bg-rule" />
      <MenuButton
        menuLabel={t("tasks.bulk.status")}
        className={barButton}
        placement="above"
        label={label("status")}
      >
        {(close) => (
          <MenuGroup>
            {statuses && projectId ? (
              <StatusOptions
                statuses={statuses}
                current={common(tasks, (task) => task.statusId)}
                onPick={(statusId) => {
                  close();
                  apply({ statusId });
                }}
              />
            ) : (
              oneProjectNote
            )}
          </MenuGroup>
        )}
      </MenuButton>
      <MenuButton
        menuLabel={t("tasks.bulk.assignee")}
        className={barButton}
        placement="above"
        label={label("assignee")}
      >
        {(close) => (
          <MenuGroup>
            {members ? (
              <AssigneeOptions
                people={members}
                current={common(tasks, (task) => task.assigneeId)}
                onPick={(assigneeId) => {
                  close();
                  apply({ assigneeId });
                }}
              />
            ) : (
              oneProjectNote
            )}
          </MenuGroup>
        )}
      </MenuButton>
      <MenuButton
        menuLabel={t("tasks.bulk.week")}
        className={barButton}
        placement="above"
        label={label("week")}
      >
        {(close) => (
          <MenuGroup>
            <WeekOptions
              current={common(tasks, (task) => task.plannedWeek)}
              onPick={(plannedWeek) => {
                close();
                apply({ plannedWeek });
              }}
            />
          </MenuGroup>
        )}
      </MenuButton>
      <MenuButton
        menuLabel={t("tasks.bulk.milestone")}
        className={barButton}
        placement="above"
        label={label("milestone")}
      >
        {(close) => (
          <MenuGroup>
            {milestones && projectId ? (
              <MilestoneOptions
                milestones={milestones}
                current={common(tasks, (task) => task.milestoneId)}
                onPick={(milestoneId) => {
                  close();
                  apply({ milestoneId });
                }}
              />
            ) : (
              oneProjectNote
            )}
          </MenuGroup>
        )}
      </MenuButton>
      <MenuButton
        menuLabel={t("tasks.bulk.size")}
        className={barButton}
        placement="above"
        align="right"
        label={label("size")}
      >
        {(close) => (
          <MenuGroup>
            <SizeOptions
              current={common(tasks, (task) => task.size)}
              onPick={(size) => {
                close();
                apply({ size });
              }}
            />
          </MenuGroup>
        )}
      </MenuButton>
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-rule" />
      <button
        type="button"
        aria-label={t("tasks.bulk.clearLabel")}
        onClick={onClear}
        className={`${barButton} text-ink-muted hover:text-ink`}
      >
        {t("tasks.bulk.clear")}
      </button>
    </section>
  );
}
