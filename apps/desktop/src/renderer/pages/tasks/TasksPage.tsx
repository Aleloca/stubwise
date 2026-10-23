import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMilestones, useProject, useTasks } from "../../data/queries";
import { GROUP_BYS, TASK_VIEWS } from "../../data/routes";
import type { FilterCriteria, GroupBy, SavedFilter, Task, TaskView } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { parseCriteria } from "../../domain/filters";
import { DeptLegend } from "../../layout/DeptStrip";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { FilterBar } from "../../tasks-ui/FilterBar";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { useGroupContext, useStallMap } from "./context";
import { Chevron, MenuButton, primaryButton, secondaryButton } from "./controls";
import { TaskBoard, type BoardLanes } from "./TaskBoard";
import { TaskList } from "./TaskList";
import { TaskTimeline } from "./TaskTimeline";

/** Ciò che la pagina legge dalla ricerca dell'indirizzo (già validata dal router). */
interface TasksSearch {
  task?: string;
  view?: string;
  group?: string;
  filters?: unknown;
}

/** Senza criteri nell'indirizzo: le task aperte. «Clear filters» scrive `{}` (tutte). */
const DEFAULT_CRITERIA: FilterCriteria = { families: ["todo", "active"] };

const BOARD_LANES: readonly BoardLanes[] = ["none", "assignee", "department"];
const DEFAULT_GROUP: Record<TaskView, GroupBy> = {
  list: "status",
  board: "none",
  timeline: "none",
};

const isView = (v: unknown): v is TaskView => (TASK_VIEWS as readonly unknown[]).includes(v);
const isGroup = (v: unknown): v is GroupBy => (GROUP_BYS as readonly unknown[]).includes(v);

/**
 * Le task di un progetto (o di un filtro salvato, Task 8): una pagina, tre
 * proiezioni dello stesso insieme filtrato. La testata — h1 col conteggio,
 * riga dei comandi (Elenco · Board · Timeline, raggruppamento, «New task»),
 * barra dei filtri — non si muove fra le viste: cambia solo il corpo, che è
 * l'unico a scorrere. Vista, raggruppamento e criteri stanno nell'indirizzo
 * (`view`, `group`, `filters`); senza, valgono quelli del filtro salvato o
 * le task aperte in elenco per stato. Clic su una task → `?task=<CODE>`.
 */
export function TasksPage({
  projectCode,
  savedFilter,
}: {
  projectCode?: string;
  savedFilter?: SavedFilter;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as TasksSearch;
  const project = useProject(projectCode ?? "").data ?? undefined;
  const projectId = projectCode ? project?.id : undefined;

  const view: TaskView = isView(search.view) ? search.view : (savedFilter?.view ?? "list");
  const rawGroup: GroupBy = isGroup(search.group)
    ? search.group
    : (savedFilter?.groupBy ?? DEFAULT_GROUP[view]);
  const group: GroupBy =
    view === "board" && !(BOARD_LANES as readonly string[]).includes(rawGroup) ? "none" : rawGroup;

  const criteria: FilterCriteria = useMemo(() => {
    const fromUrl = search.filters === undefined ? null : parseCriteria(search.filters);
    return fromUrl ?? savedFilter?.criteria ?? DEFAULT_CRITERIA;
  }, [search.filters, savedFilter]);
  // La pagina del progetto aggiunge il progetto ai criteri, senza scriverlo nell'indirizzo.
  const effective = useMemo(
    () => (projectId ? { ...criteria, projectIds: [projectId] } : criteria),
    [criteria, projectId],
  );
  const enabled = !projectCode || !!projectId;

  const tasksQuery = useTasks(effective, { enabled });
  // Quante ce ne sono senza filtri: dice se il vuoto è «ancora nessuna» o «nessuna corrisponde».
  const allQuery = useTasks(projectId ? { projectIds: [projectId] } : savedFilter?.criteria, {
    enabled,
  });
  const tasks = enabled ? tasksQuery.data : undefined;
  const ctx = useGroupContext(tasks, projectId);
  const stalls = useStallMap(effective, enabled);
  const milestones = useMilestones(projectId).data;

  const canCreate = !!projectId && can(viewer, "tickets.create", projectId);

  function setSearch(patch: Partial<TasksSearch>, replace = false) {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      replace,
    } as never);
  }
  const open = (task: Task) => setSearch({ task: task.code });
  const newTask = () => setSearch({ newTask: "1", project: project?.code } as never);
  const setCriteria = (next: FilterCriteria) => setSearch({ filters: next }, true);

  const title = savedFilter?.name ?? t("project.sections.tasks");
  const count = tasks?.length;

  const viewButton = (v: TaskView) => (
    <button
      key={v}
      type="button"
      aria-pressed={view === v}
      onClick={() => setSearch({ view: v, group: undefined })}
      className={`h-7 rounded-[5px] px-3 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${view === v ? "bg-ink/10 font-semibold text-ink" : "font-medium text-ink-muted hover:text-ink"}`}
    >
      {t(`tasks.views.${v}`)}
    </button>
  );
  const groupChoices: readonly GroupBy[] = view === "board" ? BOARD_LANES : GROUP_BYS;
  const groupName = view === "board" ? t("tasks.group.lanes") : t("tasks.group.label");

  let body;
  if (tasksQuery.isError) {
    body = <PageError message={t("tasks.states.error")} onRetry={() => void tasksQuery.refetch()} />;
  } else if (!tasks || !ctx || (projectCode && !milestones)) {
    body = view === "board" ? <PageSkeleton shape="columns" /> : <PageSkeleton />;
  } else if (tasks.length === 0 && (allQuery.data?.length ?? 0) > 0) {
    body = (
      <PageEmpty
        title={t("tasks.states.noMatchTitle")}
        body={t("tasks.states.noMatchBody")}
        action={
          <button type="button" className={secondaryButton} onClick={() => setCriteria({})}>
            {t("tasks.states.clearFilters")}
          </button>
        }
      />
    );
  } else if (tasks.length === 0) {
    body = (
      <PageEmpty
        title={t("tasks.states.emptyTitle")}
        body={
          canCreate
            ? t("tasks.states.emptyBody", { project: project?.name })
            : t("tasks.states.emptyWho", { project: project?.name ?? title })
        }
        action={
          canCreate ? (
            <button type="button" className={primaryButton} onClick={newTask}>
              {t("tasks.newTask")}
            </button>
          ) : undefined
        }
      />
    );
  } else if (view === "board") {
    body = (
      <TaskBoard
        tasks={tasks}
        projectId={projectId}
        lanes={group as BoardLanes}
        ctx={ctx}
        stalls={stalls}
        openCode={search.task}
        onOpen={open}
      />
    );
  } else if (view === "timeline") {
    body = (
      <TaskTimeline
        tasks={tasks}
        groupBy={group}
        ctx={ctx}
        milestones={milestones ?? ctx.milestones}
        stalls={stalls}
        openCode={search.task}
        onOpen={open}
      />
    );
  } else {
    body = (
      <TaskList
        tasks={tasks}
        groupBy={group}
        ctx={ctx}
        stalls={stalls}
        openCode={search.task}
        onOpen={open}
      />
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="page-header flex shrink-0 flex-col gap-3 pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <div className="flex items-baseline gap-3">
          <h1 className="min-w-0 truncate text-2xl font-semibold text-ink" title={title}>
            {title}
          </h1>
          {count !== undefined && (
            <span className="num text-lg text-ink-faint">
              <span aria-hidden="true">{count}</span>
              <span className="sr-only">{t("tasks.count", { count })}</span>
            </span>
          )}
        </div>
        <div
          role="toolbar"
          aria-label={t("tasks.commands")}
          className="flex flex-wrap items-center gap-x-3 gap-y-2"
        >
          <div
            role="group"
            aria-label={t("tasks.views.label")}
            className="flex h-8 items-center gap-0.5 rounded-md border border-rule p-0.5"
          >
            {TASK_VIEWS.map(viewButton)}
          </div>
          <MenuButton
            menuLabel={groupName}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/8"
            label={
              <>
                <span>{groupName}:</span>
                <span className="font-medium text-ink">{t(`tasks.group.${group}`)}</span>
                <Chevron />
              </>
            }
          >
            {(close) => (
              <MenuGroup>
                {groupChoices.map((g) => (
                  <RadioItem
                    key={g}
                    checked={g === group}
                    onSelect={() => {
                      close();
                      setSearch({ group: g }, true);
                    }}
                  >
                    {t(`tasks.group.${g}`)}
                  </RadioItem>
                ))}
              </MenuGroup>
            )}
          </MenuButton>
          {canCreate && (
            <button type="button" className={`${primaryButton} ml-auto`} onClick={newTask}>
              {t("tasks.newTask")}
            </button>
          )}
        </div>
        <FilterBar value={criteria} onChange={setCriteria} lockedProjectId={projectId} />
      </header>
      <div
        data-tasks-body={view}
        className="min-h-0 flex-1 overflow-auto border-t border-rule"
      >
        {body}
      </div>
      {tasks && tasks.length > 0 && (
        <footer className="shrink-0 border-t border-rule px-8 py-2">
          <DeptLegend departmentIds={tasks.map((task) => task.departmentId)} />
        </footer>
      )}
    </section>
  );
}
