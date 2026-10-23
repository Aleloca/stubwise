import { useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../../data/dates";
import { useSessionPersonId, useStalled, useTasks } from "../../../data/queries";
import type { FilterCriteria, Task } from "../../../data/types";
import { currentWeek, weekDays } from "../../../domain/weeks";
import type { Stall } from "../../../domain/stalled";
import { TaskRow } from "../../../tasks-ui/TaskRow";
import {
  BlockSection,
  Capped,
  queryState,
  useOpenTask,
  useReportDepartments,
} from "./BlockSection";

const OPEN: FilterCriteria = { families: ["todo", "active"] };
const TABS = ["assigned", "delegated", "following"] as const;
type Tab = (typeof TABS)[number];
const GROUPS = ["overdue", "today", "thisWeek", "later", "noDate"] as const;
type Group = (typeof GROUPS)[number];

/** In quale tab sta una task aperta, per chi guarda (al più una). */
function tabOf(task: Task, me: string): Tab | null {
  if (task.assigneeId === me) return "assigned";
  if (task.createdById === me && task.assigneeId !== null) return "delegated";
  if (task.followerIds.includes(me)) return "following";
  return null;
}

/** La domenica della settimana corrente: «This week» arriva fin lì. */
function endOfWeek(): string {
  const friday = weekDays(currentWeek())[4]!;
  return new Date(Date.parse(`${friday}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
}

function groupOf(task: Task, sunday: string): Group {
  if (!task.dueDate) return "noDate";
  if (task.dueDate < TODAY) return "overdue";
  if (task.dueDate === TODAY) return "today";
  if (task.dueDate <= sunday) return "thisWeek";
  return "later";
}

/** Le ferme visibili per codice, per il segno sulle righe (lettura accessoria: se manca, niente segno). */
export function useStallsByCode(): Map<string, Stall> {
  const { data } = useStalled();
  return useMemo(() => new Map((data ?? []).map((r) => [r.task.code, r.stall])), [data]);
}

/**
 * «My tasks»: tre schede — assegnate a me, delegate (create da me e
 * assegnate ad altri), che seguo — con le task aperte raggruppate per
 * scadenza (in ritardo, oggi, questa settimana, più avanti, senza data).
 * Ogni gruppo mostra 5 righe, poi «Show N more». Le schede si scorrono
 * con le frecce (tablist).
 */
export function MyTasksBlock() {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const tasks = useTasks(OPEN);
  const stalls = useStallsByCode();
  const openTask = useOpenTask();
  const [tab, setTab] = useState<Tab>("assigned");

  const byTab = useMemo(() => {
    const out: Record<Tab, Task[]> = { assigned: [], delegated: [], following: [] };
    for (const task of tasks.data ?? []) {
      const which = tabOf(task, me);
      if (which) out[which].push(task);
    }
    return out;
  }, [tasks.data, me]);
  const list = byTab[tab];
  useReportDepartments("myTasks", list);
  const sunday = endOfWeek();
  const groups = GROUPS.map((g) => ({
    key: g,
    tasks: list
      .filter((task) => groupOf(task, sunday) === g)
      .sort(
        (a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.code.localeCompare(b.code),
      ),
  })).filter((g) => g.tasks.length > 0);

  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next =
      TABS[(TABS.indexOf(tab) + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
    setTab(next);
    (e.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
  };

  const state = queryState([tasks]);
  return (
    <BlockSection title={t("home.blocks.myTasks")} count={list.length} state={state}>
      <div
        role="tablist"
        aria-label={t("home.myTasks.tabs")}
        onKeyDown={onTabKey}
        className="mb-3 flex gap-1"
      >
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            data-tab={key}
            aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${tab === key ? "bg-ink/10 font-semibold text-ink" : "text-ink-muted hover:bg-ink/6 hover:text-ink"}`}
          >
            {t(`home.myTasks.${key}`)}
            <span className="num text-xs text-ink-faint">{byTab[key].length}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={t(`home.myTasks.${tab}`)}>
        {groups.length === 0 ? (
          <p className="border-t border-rule py-3 pl-4 text-md text-ink-muted">
            {t(`home.myTasks.empty.${tab}`)}
          </p>
        ) : (
          groups.map((g) => (
            <div key={`${tab}-${g.key}`} className="mb-2">
              <h3 className="heading-group flex items-center gap-2 px-4 pt-2 pb-1.5">
                {t(`home.myTasks.groups.${g.key}`)}
                <span className="num text-ink-faint">{g.tasks.length}</span>
              </h3>
              <Capped
                items={g.tasks}
                label={t(`home.myTasks.groups.${g.key}`)}
                render={(task) => (
                  <li key={task.id}>
                    <TaskRow
                      task={task}
                      density="regular"
                      stall={stalls.get(task.code) ?? null}
                      onOpen={(x) => openTask(x.code)}
                    />
                  </li>
                )}
              />
            </div>
          ))
        )}
      </div>
    </BlockSection>
  );
}
