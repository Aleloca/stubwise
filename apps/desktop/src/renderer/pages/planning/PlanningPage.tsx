import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useDepartments,
  usePeople,
  usePlanTask,
  useProject,
  useProjects,
  useTasks,
} from "../../data/queries";
import type { FilterCriteria, Person, Project, Task } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import {
  busiestCell,
  isToPlan,
  peopleLoad,
  planBlock,
  type PlanBlock,
  type PlanRights,
} from "../../domain/planning";
import { addWeeks, compareWeeks, currentWeek, weekDays } from "../../domain/weeks";
import { DeptLegend } from "../../layout/DeptStrip";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { PageEmpty, PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { formatDue } from "../../tasks-ui/TaskRow";
import { queryState, useOpenTask } from "../home/blocks/BlockSection";
import { Chevron, MenuButton, quietButton } from "../tasks/controls";
import { shortWeek } from "../tasks/pickers";
import { PlanningContext, spotOf, type PlanningContextValue, type Spot } from "./context";
import { GridSkeleton, PeopleGrid, type GridRow } from "./PeopleGrid";
import { ChipBody, chipClass } from "./PlanChip";
import { PlanMenu } from "./PlanMenu";
import { Unplanned, type PoolGroup } from "./Unplanned";

/** Le settimane in vista secondo la larghezza della finestra (shape planning.md §6). */
export const WEEKS_3_QUERY = "(min-width: 1440px)";
export const WEEKS_2_QUERY = "(min-width: 1280px)";
/** Le settimane offerte dal menu «Plan»: questa e le sette dopo. */
const MENU_WEEKS = 8;

function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d={dir === "left" ? "m9.5 4-4 4 4 4" : "m6.5 4 4 4-4 4"} />
    </svg>
  );
}

// Prima ciò che sta sotto il puntatore; fuori da ogni cella, la più sovrapposta.
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length ? within : rectIntersection(args);
};

const byName = (a: Person, b: Person) =>
  Number(a.isClaude) - Number(b.isClaude) || a.name.localeCompare(b.name);

/** Quante settimane si vedono: una a 1024, due da 1280, tre da 1440. */
function useWeekCount(): number {
  const three = useMediaQuery(WEEKS_3_QUERY);
  const two = useMediaQuery(WEEKS_2_QUERY);
  return three ? 3 : two ? 2 : 1;
}

/**
 * Planning (spec §5, shape planning.md): a sinistra la vasca «To plan», a
 * destra la matrice persone × settimane. Trascinare una carta su una cella
 * la assegna a quella persona per quella settimana (= `planTask`); fra celle
 * la ripianifica; sulla vasca le toglie la settimana. Da tastiera: «P» sulla
 * carta apre il menu persona → settimana. Ogni spostamento vale subito; se
 * non riesce torna indietro e un messaggio lo dice.
 *
 * Con `projectCode` è la Planning del progetto: righe = membri, permesso del
 * progetto (senza `planning.others` le righe altrui sono in sola lettura).
 * Senza è la vista trasversale: righe = persone di un reparto (scelto in
 * testa), task di tutti i progetti visibili, permesso valutato per task.
 */
export function PlanningPage({ projectCode }: { projectCode?: string }) {
  const { t, i18n } = useTranslation();
  const { viewer } = useViewer();
  const me = viewer.personId;
  const toast = useToast();
  const planTask = usePlanTask();
  const search = useSearch({ strict: false }) as { task?: string };
  const openTask = useOpenTask();
  const now = currentWeek();

  const projectQuery = useProject(projectCode ?? "");
  const project = projectCode ? projectQuery.data ?? undefined : undefined;
  const projectId = project?.id;
  const projects = useProjects();
  const people = usePeople();
  const departments = useDepartments();
  const all = useTasks();

  // --- vasca: filtri e raggruppamento --------------------------------------
  const [criteria, setCriteria] = useState<FilterCriteria>({});
  const [group, setGroup] = useState<PoolGroup>("department");
  const pool = useTasks(projectId ? { ...criteria, projectIds: [projectId] } : criteria, {
    enabled: !projectCode || !!projectId,
  });

  // --- reparto (trasversale) ----------------------------------------------
  const myDepartment = people.data?.find((p) => p.id === me)?.departmentIds[0];
  const [chosenDept, setChosenDept] = useState<string | null>(null);
  const departmentId = chosenDept ?? myDepartment ?? departments.data?.[0]?.id;

  // --- settimane in vista ---------------------------------------------------
  const count = useWeekCount();
  const [start, setStart] = useState(now);
  const weeks = useMemo(() => Array.from({ length: count }, (_, i) => addWeeks(start, i)), [start, count]);
  const menuWeeks = useMemo(() => Array.from({ length: MENU_WEEKS }, (_, i) => addWeeks(now, i)), [now]);

  const projectById = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p] as const)),
    [projects.data],
  );
  const projectOf = useCallback((id: string) => projectById.get(id), [projectById]);
  const rightsOf = useCallback(
    (task: Task): PlanRights => ({
      me,
      others: can(viewer, "planning.others", task.projectId),
      edit: can(viewer, "tickets.edit", task.projectId),
      members: projectById.get(task.projectId)?.memberIds ?? [],
    }),
    [me, viewer, projectById],
  );
  const othersHere = projectId ? can(viewer, "planning.others", projectId) : false;
  const blockText = useCallback(
    (block: PlanBlock, task: Task) => {
      if (block === "member") return t("planning.notMember");
      if (projectId) return t("planning.readOnlyRow");
      return t("planning.readOnlyProject", { project: projectById.get(task.projectId)?.name ?? "" });
    },
    [t, projectId, projectById],
  );
  const lockReason = useCallback(
    (task: Task) => {
      if (task.closedAt !== null) return t("planning.closed");
      return blockText("others", task);
    },
    [t, blockText],
  );

  // --- righe e carico --------------------------------------------------------
  const rowPeople = useMemo(() => {
    const list = people.data ?? [];
    if (projectCode) {
      const members = new Set(project?.memberIds ?? []);
      return list.filter((p) => members.has(p.id)).sort(byName);
    }
    // Trasversale: le persone del reparto, e Claude sempre ultimo.
    return list.filter((p) => p.isClaude || (departmentId && p.departmentIds.includes(departmentId))).sort(byName);
  }, [people.data, projectCode, project, departmentId]);

  const loadWeeks = useMemo(() => [...new Set([...weeks, ...menuWeeks])], [weeks, menuWeeks]);
  const loads = useMemo(
    () => peopleLoad(all.data ?? [], people.data ?? [], loadWeeks, { projectId }),
    [all.data, people.data, loadWeeks, projectId],
  );
  const rowLoads = useMemo(
    () => new Map(rowPeople.map((p) => [p.id, loads.get(p.id)!] as const)),
    [rowPeople, loads],
  );
  const max = busiestCell(rowLoads, weeks);

  const rows: GridRow[] = useMemo(() => {
    const open = (all.data ?? []).filter((x) => x.closedAt === null);
    return rowPeople.map((person) => {
      const tasksByWeek: Record<string, Task[]> = {};
      for (const week of weeks) {
        tasksByWeek[week] = open
          .filter(
            (x) =>
              x.assigneeId === person.id &&
              x.plannedWeek === week &&
              (!projectId || x.projectId === projectId),
          )
          .sort((a, b) => b.slipCount - a.slipCount || a.code.localeCompare(b.code, "en", { numeric: true }));
      }
      const readOnly = projectId && !othersHere && person.id !== me ? t("planning.readOnlyRow") : null;
      return { person, load: loads.get(person.id)!, tasksByWeek, readOnly };
    });
  }, [all.data, rowPeople, weeks, projectId, othersHere, me, loads, t]);

  const poolTasks = useMemo(() => {
    const rowIds = new Set(rowPeople.map((p) => p.id));
    return (pool.data ?? []).filter(
      (x) =>
        isToPlan(x, now) &&
        // Trasversale: le task del reparto, o di chi è nelle righe.
        (projectId || x.departmentId === departmentId || (x.assigneeId && rowIds.has(x.assigneeId))),
    );
  }, [pool.data, now, projectId, departmentId, rowPeople]);

  // --- spostare ---------------------------------------------------------------
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState<Task | null>(null);
  const [over, setOver] = useState<Spot | null>(null);
  const [menu, setMenu] = useState<{ task: Task; anchor: HTMLElement } | null>(null);
  const refocus = useRef<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // La carta spostata da tastiera tiene il fuoco finché chi guarda non lo porta altrove.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const chip = (e.target as Element | null)?.closest?.("[data-chip]");
      if (chip?.getAttribute("data-chip") !== refocus.current) refocus.current = null;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  const personName = useCallback(
    (id: string | null) => people.data?.find((p) => p.id === id)?.name ?? t("taskUi.unassigned"),
    [people.data, t],
  );

  function plan(task: Task, assigneeId: string | null, week: string | null, opts: { undo?: boolean } = {}) {
    const previous = { assigneeId: task.assigneeId, week: task.plannedWeek };
    if (previous.assigneeId === assigneeId && previous.week === week) {
      setAnnouncement(t("planning.unchanged", { code: task.code }));
      return;
    }
    const moved =
      week === null
        ? t("planning.movedToPool", { code: task.code })
        : t("planning.moved", { code: task.code, person: personName(assigneeId), week: shortWeek(week) });
    setAnnouncement(moved);
    planTask.mutate(
      { id: task.id, assigneeId, week },
      {
        onSuccess: () => {
          if (opts.undo) return;
          toast.show(
            week === null
              ? t("planning.toastToPool", { code: task.code })
              : t("planning.toastPlanned", { code: task.code, person: personName(assigneeId), week: shortWeek(week) }),
            {
              action: {
                label: t("planning.undo"),
                run: () => plan({ ...task, assigneeId, plannedWeek: week }, previous.assigneeId, previous.week, { undo: true }),
              },
            },
          );
        },
        onError: () =>
          toast.error(t("planning.moveFailed", { code: task.code }), {
            action: { label: t("planning.tryAgain"), run: () => plan(task, assigneeId, week, opts) },
          }),
      },
    );
  }

  const taskById = (id: unknown) =>
    (all.data ?? []).find((x) => x.id === id) ?? (pool.data ?? []).find((x) => x.id === id);

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    setOver(null);
    const task = taskById(e.active.id);
    const spot = spotOf(e.over?.id);
    if (!task || !spot) return;
    if (spot.kind === "pool") {
      if (planBlock(task, null, rightsOf(task)) === null) plan(task, task.assigneeId, null);
      return;
    }
    if (planBlock(task, spot.personId, rightsOf(task)) === null) plan(task, spot.personId, spot.week);
  }

  const spotName = (spot: Spot | null) =>
    !spot
      ? ""
      : spot.kind === "pool"
        ? t("planning.pool.title")
        : t("planning.spot", { person: personName(spot.personId), week: shortWeek(spot.week) });
  const codeOf = (id: unknown) => taskById(id)?.code ?? "";
  // Gli annunci del trascinamento col puntatore, coi nomi veri (codice, persona,
  // settimana) e mai con gli id; il rilascio lo dice `plan`.
  const announcements: Announcements = {
    onDragStart: ({ active }) => t("planning.picked", { code: codeOf(active.id) }),
    onDragOver: ({ active, over: o }) => {
      const spot = spotOf(o?.id);
      return spot ? t("planning.over", { code: codeOf(active.id), spot: spotName(spot) }) : undefined;
    },
    onDragEnd: () => undefined,
    onDragCancel: ({ active }) => t("planning.cancelled", { code: codeOf(active.id) }),
  };

  const openPlanMenu = useCallback((task: Task, anchor: HTMLElement) => setMenu({ task, anchor }), []);
  const ctx: PlanningContextValue = {
    projectId,
    projectOf,
    rightsOf,
    lockReason,
    dragging,
    over,
    openPlanMenu,
    openTask,
    openCode: search.task,
    refocus,
    blockText,
  };

  // --- stato della pagina ------------------------------------------------------
  const gridState = queryState([all, people, projects, ...(projectCode ? [] : [departments])]);
  const poolState = queryState([pool, people, projects]);
  const poolStatus = poolState.status === "empty" ? "ready" : poolState.status;
  const gridRetry = gridState.status === "error" ? gridState.retry : () => {};
  const poolRetry = poolState.status === "error" ? poolState.retry : () => {};

  let grid;
  if (gridState.status === "error") {
    grid = <PageError message={t("planning.error")} onRetry={gridRetry} />;
  } else if (gridState.status === "loading") {
    grid = <GridSkeleton weeks={count} />;
  } else if (rows.length === 0) {
    grid = (
      <PageEmpty
        title={projectId ? t("planning.emptyMembers") : t("planning.emptyDepartment")}
        body={projectId ? t("planning.emptyMembersBody") : t("planning.emptyDepartmentBody")}
      />
    );
  } else {
    const nextStart = addWeeks(start, count);
    grid = (
      <PeopleGrid
        rows={rows}
        weeks={weeks}
        max={max}
        later={
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
            aria-label={t("planning.nav.laterLabel", { week: shortWeek(nextStart) })}
            onClick={() => setStart(nextStart)}
          >
            {t("planning.nav.later")}
            <Arrow dir="right" />
          </button>
        }
      />
    );
  }

  const last = weeks.at(-1)!;
  const span =
    count === 1
      ? t("planning.range", { week: shortWeek(start), range: rangeOf(start, start, i18n.language) })
      : t("planning.range", {
          week: `${shortWeek(start)}–${shortWeek(last)}`,
          range: rangeOf(start, last, i18n.language),
        });

  const legendIds = [
    ...poolTasks.map((x) => x.departmentId),
    ...rows.flatMap((r) => Object.values(r.tasksByWeek).flat().map((x) => x.departmentId)),
  ];
  const deptName = departments.data?.find((d) => d.id === departmentId)?.name;

  return (
    <PlanningContext.Provider value={ctx}>
      <section className="flex h-full min-h-0 flex-col">
        <header className="page-header flex shrink-0 flex-col gap-2 pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="text-2xl font-semibold text-ink">{t("planning.title")}</h1>
            {!projectCode && (
              <MenuButton
                menuLabel={t("planning.department")}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-rule px-2.5 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:border-rule-strong hover:text-ink aria-expanded:bg-ink/8"
                label={
                  <>
                    <span>{t("planning.department")}:</span>
                    <span className="font-medium text-ink">{deptName ?? "…"}</span>
                    <Chevron />
                  </>
                }
              >
                {(close) => (
                  <MenuGroup>
                    {(departments.data ?? []).map((d) => (
                      <RadioItem
                        key={d.id}
                        checked={d.id === departmentId}
                        onSelect={() => {
                          close();
                          setChosenDept(d.id);
                        }}
                      >
                        <span
                          aria-hidden="true"
                          className="h-3 w-[3px] shrink-0 rounded-[1px]"
                          style={{ background: `var(${d.colorToken})` }}
                        />
                        {d.name}
                      </RadioItem>
                    ))}
                  </MenuGroup>
                )}
              </MenuButton>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <p className="num text-md font-semibold text-ink" aria-live="polite">
              {span}
            </p>
            <nav aria-label={t("planning.nav.label")} className="flex items-center gap-1">
              <button
                type="button"
                className={`${quietButton} disabled:text-ink-faint`}
                aria-label={t("planning.nav.previousLabel")}
                disabled={compareWeeks(start, now) <= 0}
                onClick={() => setStart((w) => addWeeks(w, -1))}
              >
                <Arrow dir="left" />
              </button>
              <button
                type="button"
                className={`${quietButton} disabled:text-ink-faint`}
                disabled={start === now}
                onClick={() => setStart(now)}
              >
                {t("planning.nav.thisWeek")}
              </button>
              <button
                type="button"
                className={quietButton}
                aria-label={t("planning.nav.nextLabel")}
                onClick={() => setStart((w) => addWeeks(w, 1))}
              >
                <Arrow dir="right" />
              </button>
            </nav>
            <span className="ml-auto">
              <DeptLegend departmentIds={legendIds} />
            </span>
          </div>
        </header>
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={(e) => setDragging(taskById(e.active.id) ?? null)}
          onDragOver={(e) => setOver(spotOf(e.over?.id))}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            setDragging(null);
            setOver(null);
          }}
          accessibility={{
            screenReaderInstructions: { draggable: t("planning.instructions") },
            announcements,
          }}
        >
          <span data-testid="planning-announcer" role="status" aria-live="polite" className="sr-only">
            {announcement}
          </span>
          <div className="flex min-h-0 flex-1 border-t border-rule">
            <Unplanned
              tasks={poolTasks}
              status={poolStatus}
              onRetry={poolRetry}
              criteria={criteria}
              onCriteria={setCriteria}
              group={group}
              onGroup={setGroup}
            />
            <div data-planning-grid className="min-h-0 min-w-0 flex-1 overflow-auto">
              {grid}
            </div>
          </div>
          <DragOverlay dropAnimation={null}>
            {dragging && (
              <div
                className={`${chipClass} w-[240px] border border-rule-strong bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]`}
              >
                <ChipBody task={dragging} withAssignee={false} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
        {menu && (
          <PlanMenu
            task={menu.task}
            anchor={menu.anchor}
            people={candidates(menu.task, projectById, people.data ?? [])}
            loads={loads}
            weeks={menuWeeks}
            firstWeek={start}
            max={Math.max(1, busiestCell(loads, menuWeeks))}
            onClose={(restore) => {
              const anchor = menu.anchor;
              setMenu(null);
              if (restore) anchor.focus();
            }}
            onPlan={(assigneeId, week) => {
              const task = menu.task;
              setMenu(null);
              refocus.current = task.code;
              plan(task, assigneeId, week);
            }}
          />
        )}
      </section>
    </PlanningContext.Provider>
  );
}

/** I candidati del menu «Plan»: i membri del progetto della task, Claude per ultimo. */
function candidates(task: Task, projects: Map<string, Project>, people: Person[]): Person[] {
  const members = new Set(projects.get(task.projectId)?.memberIds ?? []);
  return people.filter((p) => members.has(p.id)).sort(byName);
}

/** «Oct 19 – Nov 6»: dal lunedì della prima settimana al venerdì dell'ultima. */
function rangeOf(from: string, to: string, language: string): string {
  return `${formatDue(weekDays(from)[0]!, language)} – ${formatDue(weekDays(to)[4]!, language)}`;
}
