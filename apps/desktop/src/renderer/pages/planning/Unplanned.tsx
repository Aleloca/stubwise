import { useDroppable } from "@dnd-kit/core";
import { useMemo, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useDepartments, useMilestones } from "../../data/queries";
import type { FilterCriteria, Task } from "../../data/types";
import { planBlock } from "../../domain/planning";
import { FilterBar } from "../../tasks-ui/FilterBar";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { Chevron, MenuButton } from "../tasks/controls";
import { usePlanning } from "./context";
import { PlanChip } from "./PlanChip";

export type PoolGroup = "department" | "milestone" | "none";
export const POOL_GROUPS: PoolGroup[] = ["department", "milestone", "none"];

/** Le slittate in testa al gruppo (le più slittate prima), poi per codice. */
function bySlipThenCode(a: Task, b: Task): number {
  return b.slipCount - a.slipCount || a.code.localeCompare(b.code, "en", { numeric: true });
}

/** Su e giù (frecce, J/K) fra le carte della vasca, nell'ordine in cui si vedono. */
function poolNav(e: KeyboardEvent<HTMLElement>) {
  const delta =
    e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
  if (!delta) return;
  const list = e.currentTarget.closest("[data-pool-list]");
  const chips = [...(list?.querySelectorAll<HTMLElement>("[data-chip]") ?? [])];
  const next = chips[chips.indexOf(e.currentTarget) + delta];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

function PoolSkeleton() {
  const bar = "rounded-sm bg-ink/8";
  const widths = ["70%", "52%", "64%", "45%", "58%", "38%"];
  return (
    <div aria-hidden="true" className="skeleton-breathe flex flex-col gap-1 px-3 pt-3">
      <span className={`mb-1 h-2.5 w-20 ${bar}`} />
      {widths.map((w, i) => (
        <span key={i} className="flex h-8 items-center gap-2 pl-3">
          <span className={`h-2.5 w-11 shrink-0 ${bar}`} />
          <span className={`h-2.5 ${bar}`} style={{ width: w }} />
        </span>
      ))}
    </div>
  );
}

/**
 * La vasca «To plan» (shape planning.md §3): le aperte senza settimana o
 * senza persona, e le slittate ancora nella settimana corrente. Barra dei
 * filtri e «Group by» (reparto, traguardo, nessuno), le slittate in testa
 * al gruppo. È anche un bersaglio: una carta lasciata qui perde la
 * settimana e tiene la persona.
 */
export function Unplanned({
  tasks,
  status,
  onRetry,
  criteria,
  onCriteria,
  group,
  onGroup,
}: {
  tasks: Task[];
  status: "loading" | "error" | "ready";
  onRetry: () => void;
  criteria: FilterCriteria;
  onCriteria: (c: FilterCriteria) => void;
  group: PoolGroup;
  onGroup: (g: PoolGroup) => void;
}) {
  const { t } = useTranslation();
  const ctx = usePlanning();
  const departments = useDepartments().data;
  const milestones = useMilestones(ctx.projectId).data;
  const dragging = ctx.dragging;
  // Si accetta la carta solo se ha una settimana da togliere e chi guarda può toglierla.
  const accepts =
    !!dragging && dragging.plannedWeek !== null && planBlock(dragging, null, ctx.rightsOf(dragging)) === null;
  const { setNodeRef, isOver } = useDroppable({ id: "pool", disabled: !accepts });

  const groups = useMemo(() => {
    const sorted = [...tasks].sort(bySlipThenCode);
    if (group === "none") return [{ key: "all", label: null as string | null, tasks: sorted }];
    const map = new Map<string, Task[]>();
    for (const task of sorted) {
      const key = (group === "department" ? task.departmentId : task.milestoneId) ?? "none";
      map.set(key, [...(map.get(key) ?? []), task]);
    }
    const label = (key: string) => {
      if (group === "department") return departments?.find((d) => d.id === key)?.name ?? key;
      if (key === "none") return t("planning.pool.noMilestone");
      const m = milestones?.find((x) => x.id === key);
      if (!m) return key;
      // Nella vista trasversale il traguardo dice il suo progetto.
      const code = ctx.projectId ? null : ctx.projectOf(m.projectId)?.code;
      return code ? `${code} · ${m.name}` : m.name;
    };
    // Reparti nell'ordine di configurazione; traguardi per nome, «senza» in fondo.
    const order = (key: string) =>
      group === "department" ? (departments?.findIndex((d) => d.id === key) ?? 0) : key === "none" ? 1 : 0;
    return [...map.entries()]
      .map(([key, list]) => ({ key, label: label(key), tasks: list }))
      .sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label));
  }, [tasks, group, departments, milestones, ctx, t]);

  const groupName = t("planning.pool.groupBy");
  return (
    <section
      ref={setNodeRef}
      aria-labelledby="planning-pool-title"
      data-pool
      className={`flex min-h-0 w-[280px] shrink-0 flex-col border-r border-rule transition-colors duration-[var(--duration-fast)] ease-out ${isOver ? "bg-ink/6" : ""}`}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-rule px-3 pt-3 pb-3">
        <div className="flex items-baseline gap-2">
          <h2 id="planning-pool-title" className="text-md font-semibold text-ink">
            {t("planning.pool.title")}
          </h2>
          {status === "ready" && (
            <span className="num text-sm text-ink-faint">
              <span aria-hidden="true">{tasks.length}</span>
              <span className="sr-only">{t("planning.pool.count", { count: tasks.length })}</span>
            </span>
          )}
          <span className="ml-auto">
            <MenuButton
              menuLabel={groupName}
              align="right"
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/8"
              label={
                <>
                  <span className="sr-only">{groupName}: </span>
                  <span className="font-medium text-ink">{t(`planning.pool.group.${group}`)}</span>
                  <Chevron />
                </>
              }
            >
              {(close) => (
                <MenuGroup label={groupName}>
                  {POOL_GROUPS.map((g) => (
                    <RadioItem
                      key={g}
                      checked={g === group}
                      onSelect={() => {
                        close();
                        onGroup(g);
                      }}
                    >
                      {t(`planning.pool.group.${g}`)}
                    </RadioItem>
                  ))}
                </MenuGroup>
              )}
            </MenuButton>
          </span>
        </div>
        <FilterBar value={criteria} onChange={onCriteria} lockedProjectId={ctx.projectId} compact />
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-6">
        {status === "error" ? (
          <PageError message={t("planning.pool.error")} onRetry={onRetry} />
        ) : status === "loading" ? (
          <PoolSkeleton />
        ) : tasks.length === 0 ? (
          <div className="flex flex-col gap-1 px-4 py-6">
            <p className="text-md text-ink">{t("planning.pool.emptyTitle")}</p>
            <p className="text-sm text-ink-muted">{t("planning.pool.emptyBody")}</p>
          </div>
        ) : (
          <div data-pool-list className="flex flex-col">
            {groups.map((g) => (
              <section key={g.key} aria-label={g.label ?? undefined} className="flex flex-col pt-2">
                {g.label && (
                  <h3 className="heading-group flex items-baseline gap-2 px-3 pt-1 pb-1">
                    <span className="min-w-0 truncate">{g.label}</span>
                    <span className="num ml-auto tracking-normal text-ink-faint">{g.tasks.length}</span>
                  </h3>
                )}
                <div className="flex flex-col px-1">
                  {g.tasks.map((task) => (
                    <PlanChip
                      key={task.id}
                      task={task}
                      spot={{ kind: "pool" }}
                      withAssignee
                      onKeyNav={poolNav}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
