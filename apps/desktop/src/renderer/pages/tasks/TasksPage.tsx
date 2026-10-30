import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useRef, useState, type ReactNode } from "react";
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
import { SaveFilterDialog } from "../filters/SaveFilterDialog";
import { useGroupContextState, useStallMap } from "./context";
import { Chevron, MenuButton, primaryButton, quietButton, secondaryButton } from "./controls";
import { TaskBoard, type BoardLanes } from "./TaskBoard";
import { TaskList } from "./TaskList";
import { TaskTimeline } from "./TaskTimeline";
import { useTaskKeys } from "./useTaskKeys";
import { WhoCanLink } from "../../components/WhoCanLink";

/** Ciò che la pagina legge dalla ricerca dell'indirizzo (già validata dal router). */
interface TasksSearch {
  task?: string;
  view?: string;
  group?: string;
  filters?: unknown;
}

/** Ciò che la pagina mostra adesso: per salvarlo in un filtro. */
export interface TasksPageState {
  criteria: FilterCriteria;
  view: TaskView;
  groupBy: GroupBy;
  /** Vista, raggruppamento o criteri vengono dall'indirizzo (cambiati dopo l'apertura). */
  changed: boolean;
}

/** Senza criteri nell'indirizzo: le task aperte. «Clear filters» scrive `{}` (tutte). */
const DEFAULT_CRITERIA: FilterCriteria = { families: ["todo", "active"] };

const BOARD_LANES: readonly BoardLanes[] = ["none", "assignee", "department"];
const DEFAULT_GROUP: Record<TaskView, GroupBy> = {
  list: "status",
  board: "none",
  // La timeline raggruppa come l'elenco.
  timeline: "status",
};

const isView = (v: unknown): v is TaskView => (TASK_VIEWS as readonly unknown[]).includes(v);
const isGroup = (v: unknown): v is GroupBy => (GROUP_BYS as readonly unknown[]).includes(v);

/**
 * Il raggruppamento quando l'indirizzo non ne dice uno: quello del filtro
 * salvato nella vista con cui è stato salvato; la timeline di un insieme su
 * più progetti per progetto (shape brief, assunzione 7); altrimenti quello
 * del filtro o il default della vista.
 */
function defaultGroup(
  view: TaskView,
  savedFilter: SavedFilter | undefined,
  multiProject: boolean,
): GroupBy {
  if (savedFilter && savedFilter.view === view) return savedFilter.groupBy;
  if (multiProject && view === "timeline") return "project";
  return savedFilter?.groupBy ?? DEFAULT_GROUP[view];
}

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
  meta,
  actions,
}: {
  projectCode?: string;
  savedFilter?: SavedFilter;
  /** Sotto l'h1 (il filtro salvato: «Public · by …»). */
  meta?: ReactNode;
  /** Accanto all'h1 (le azioni del filtro salvato), con lo stato corrente della pagina. */
  actions?: (current: TasksPageState) => ReactNode;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as TasksSearch;
  const project = useProject(projectCode ?? "").data ?? undefined;
  const projectId = projectCode ? project?.id : undefined;

  const view: TaskView = isView(search.view) ? search.view : (savedFilter?.view ?? "list");

  const criteria: FilterCriteria = useMemo(() => {
    const fromUrl = search.filters === undefined ? null : parseCriteria(search.filters);
    return fromUrl ?? savedFilter?.criteria ?? DEFAULT_CRITERIA;
  }, [search.filters, savedFilter]);
  // Fuori da un progetto, salvo un filtro fissato su uno solo.
  const multiProject = !projectCode && (criteria.projectIds?.length ?? 0) !== 1;
  const rawGroup: GroupBy = isGroup(search.group)
    ? search.group
    : defaultGroup(view, savedFilter, multiProject);
  // La board ha solo le sue corsie; «Project» ha senso solo su più progetti.
  const group: GroupBy =
    view === "board"
      ? (BOARD_LANES as readonly string[]).includes(rawGroup)
        ? rawGroup
        : "none"
      : rawGroup === "project" && !multiProject
        ? DEFAULT_GROUP[view]
        : rawGroup;
  // La pagina del progetto aggiunge il progetto ai criteri, senza scriverlo nell'indirizzo.
  const effective = useMemo(
    () => (projectId ? { ...criteria, projectIds: [projectId] } : criteria),
    [criteria, projectId],
  );
  const enabled = !projectCode || !!projectId;
  const changed =
    search.view !== undefined || search.group !== undefined || search.filters !== undefined;

  const tasksQuery = useTasks(effective, { enabled });
  // Quante ce ne sono senza filtri: dice se il vuoto è «ancora nessuna» o «nessuna corrisponde».
  const allQuery = useTasks(projectId ? { projectIds: [projectId] } : savedFilter?.criteria, {
    enabled,
  });
  const tasks = enabled ? tasksQuery.data : undefined;
  const context = useGroupContextState(tasks, projectId);
  const ctx = context.ctx;
  const stalls = useStallMap(effective, enabled);
  const milestonesQuery = useMilestones(projectId);
  const milestones = milestonesQuery.data;
  // Una lettura di contorno che fallisce è un errore della pagina, non uno scheletro per sempre.
  const supportError = context.isError || milestonesQuery.isError;
  const retryAll = () => {
    void tasksQuery.refetch();
    void allQuery.refetch();
    void context.refetch();
    void milestonesQuery.refetch();
  };

  const canCreate = !!projectId && can(viewer, "tickets.create", projectId);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

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
  // J/K scorrono senza riempire la cronologia: «indietro» torna da dove si era partiti.
  useTaskKeys({
    body: bodyRef,
    openCode: search.task,
    onOpen: (code) => setSearch({ task: code }, true),
  });

  const title = savedFilter?.name ?? t("project.sections.tasks");
  const count = tasks?.length;

  const viewButton = (v: TaskView) => (
    <button
      key={v}
      type="button"
      aria-pressed={view === v}
      // Il raggruppamento resta: la board ne tiene solo le corsie che ha.
      onClick={() => setSearch({ view: v })}
      className={`h-7 rounded-[5px] px-3 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${view === v ? "bg-ink/10 font-semibold text-ink" : "font-medium text-ink-muted hover:text-ink"}`}
    >
      {t(`tasks.views.${v}`)}
    </button>
  );
  const groupChoices: readonly GroupBy[] =
    view === "board" ? BOARD_LANES : GROUP_BYS.filter((g) => g !== "project" || multiProject);
  const groupName = view === "board" ? t("tasks.group.lanes") : t("tasks.group.label");

  let body;
  if (tasksQuery.isError || supportError) {
    body = <PageError message={t("tasks.states.error")} onRetry={retryAll} />;
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
            : (
                <>
                  {t("tasks.states.emptyWho", { project: project?.name ?? title })}
                  {project && (
                    <>
                      {" "}
                      <WhoCanLink
                        action="createTasks"
                        projectId={project.id}
                        projectCode={project.code}
                      />
                    </>
                  )}
                </>
              )
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
        // Su più progetti le linee dei traguardi di tutti si accavallerebbero:
        // i traguardi stanno nella timeline di un progetto solo.
        milestones={multiProject ? [] : (milestones ?? ctx.milestones)}
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
        <div className="flex flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-2">
            <h1 className="min-w-0 truncate text-2xl font-semibold text-ink" title={title}>
              {title}
            </h1>
            {count !== undefined && (
              <span className="num text-lg text-ink-faint">
                <span aria-hidden="true">{count}</span>
                <span className="sr-only">{t("tasks.count", { count })}</span>
              </span>
            )}
            {actions && (
              <div className="ml-auto self-center">
                {actions({ criteria: effective, view, groupBy: group, changed })}
              </div>
            )}
          </div>
          {meta}
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
          <button
            type="button"
            className={`${quietButton} ml-auto`}
            onClick={() => setSaving(true)}
          >
            {t("tasks.saveAsFilter")}
          </button>
          {canCreate && (
            <button type="button" className={primaryButton} onClick={newTask}>
              {t("tasks.newTask")}
            </button>
          )}
        </div>
        <FilterBar value={criteria} onChange={setCriteria} lockedProjectId={projectId} />
      </header>
      <div
        ref={bodyRef}
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
      {saving && (
        <SaveFilterDialog
          criteria={effective}
          view={view}
          groupBy={group}
          project={projectId ? project : undefined}
          onClose={() => setSaving(false)}
        />
      )}
    </section>
  );
}
