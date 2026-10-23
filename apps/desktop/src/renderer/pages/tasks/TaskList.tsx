import { useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { GroupBy, Task } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import type { Stall } from "../../domain/stalled";
import { TaskRow } from "../../tasks-ui/TaskRow";
import { BulkBar } from "./BulkBar";
import { groupTasks, sortTasks, type GroupContext, type SortKey, type SortState } from "./grouping";
import { InlineAssignee, InlineStatus } from "./pickers";

interface Selection {
  ids: Set<string>;
  /** Da dove parte Maiusc+clic. */
  anchor: string | null;
  /**
   * Scelta con Maiusc, ⌘/Ctrl o ⌘A: solo allora la barra delle azioni in
   * blocco compare. Un clic semplice sceglie la riga che apre, e una task
   * sola si modifica dal suo pannello.
   */
  explicit: boolean;
}

const EMPTY: Selection = { ids: new Set(), anchor: null, explicit: false };

function SortArrow({ dir }: { dir: "asc" | "desc" }) {
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
      {dir === "asc" ? <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" /> : <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />}
    </svg>
  );
}

/**
 * Un'intestazione di colonna che ordina: crescente, decrescente, poi
 * l'ordine naturale. Il verso è detto dalla freccia e dal nome accessibile
 * (`aria-sort` sta sulle tabelle, e questo elenco non lo è).
 */
function SortHeader({
  column,
  sort,
  onSort,
  className = "",
  align = "left",
}: {
  column: SortKey;
  sort: SortState | null;
  onSort: (key: SortKey) => void;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  const { t } = useTranslation();
  const name = t(`tasks.list.columns.${column}`);
  const active = sort?.key === column ? sort.dir : null;
  const label = active
    ? t(active === "asc" ? "tasks.list.sortedAsc" : "tasks.list.sortedDesc", { column: name })
    : t("tasks.list.sortBy", { column: name });
  const justify = { left: "justify-start", right: "justify-end", center: "justify-center" }[align];
  return (
    <span className={`flex shrink-0 ${justify} ${className}`}>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => onSort(column)}
        className={`-mx-1.5 flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink ${active ? "text-ink" : "text-ink-faint"}`}
      >
        <span className={align === "left" ? "truncate" : "whitespace-nowrap"}>{name}</span>
        {active && <SortArrow dir={active} />}
      </button>
    </span>
  );
}

/**
 * L'elenco delle task: righe dense (36 px) nei gruppi del raggruppamento,
 * con l'intestazione delle colonne che ordina. Clic apre; con `tickets.edit`
 * Maiusc+clic, ⌘/Ctrl+clic e ⌘A selezionano (Esc toglie) e in fondo compare
 * la `BulkBar`; stato e assegnatario si cambiano dalla riga. Senza il
 * permesso ogni clic apre e basta. Le colonne a destra cadono con la
 * larghezza come in `TaskRow` (stessi punti di rottura del contenitore).
 */
export function TaskList({
  tasks,
  groupBy,
  ctx,
  stalls,
  openCode,
  onOpen,
}: {
  tasks: Task[];
  groupBy: GroupBy;
  ctx: GroupContext;
  stalls: Map<string, Stall>;
  /** La task aperta nel pannello, evidenziata. */
  openCode?: string;
  onOpen: (task: Task) => void;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const [sort, setSort] = useState<SortState | null>(null);
  const [selection, setSelection] = useState<Selection>(EMPTY);

  const canEdit = (task: Task) => can(viewer, "tickets.edit", task.projectId);
  const groups = useMemo(
    () => groupTasks(sort ? sortTasks(tasks, sort, ctx) : tasks, groupBy, ctx),
    [tasks, sort, groupBy, ctx],
  );
  const order = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  // Ciò che non è più nell'insieme (filtri cambiati, task spostata) esce dalla selezione.
  const selected = order.filter((task) => selection.ids.has(task.id));
  const showBar = selection.explicit && selected.length > 0;

  function onSort(key: SortKey) {
    setSort((s) =>
      s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null,
    );
  }

  function open(task: Task) {
    setSelection({ ids: new Set([task.id]), anchor: task.id, explicit: false });
    onOpen(task);
  }

  function modified(task: Task, mods: { range: boolean; toggle: boolean }) {
    setSelection((s) => {
      const base = s.explicit ? s.ids : new Set<string>();
      if (mods.range && s.anchor) {
        const from = order.findIndex((x) => x.id === s.anchor);
        const to = order.findIndex((x) => x.id === task.id);
        if (from >= 0 && to >= 0) {
          const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
          const ids = new Set(mods.toggle ? base : []);
          for (const x of range) if (canEdit(x)) ids.add(x.id);
          return { ids, anchor: s.anchor, explicit: true };
        }
      }
      const ids = new Set(base);
      if (ids.has(task.id)) ids.delete(task.id);
      else ids.add(task.id);
      return { ids, anchor: task.id, explicit: true };
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      const editable = order.filter(canEdit);
      if (editable.length === 0) return;
      e.preventDefault();
      setSelection({ ids: new Set(editable.map((x) => x.id)), anchor: null, explicit: true });
    } else if (e.key === "Escape" && selection.explicit) {
      e.preventDefault();
      setSelection(EMPTY);
    }
  }

  return (
    <div onKeyDown={onKeyDown} className="relative pb-4">
      <div className="@container sticky top-0 z-10 border-b border-rule bg-ground">
        <div className="flex h-8 items-center gap-3 pr-3 pl-4">
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <SortHeader column="code" sort={sort} onSort={onSort} className="w-16" />
            <SortHeader column="title" sort={sort} onSort={onSort} className="min-w-0" />
          </span>
          <SortHeader column="status" sort={sort} onSort={onSort} className="w-[140px] @max-[560px]:w-4 @max-[560px]:invisible" />
          <SortHeader column="assignee" sort={sort} onSort={onSort} className="w-[120px] @max-[700px]:w-[22px] @max-[700px]:invisible" />
          <SortHeader column="size" sort={sort} onSort={onSort} align="center" className="w-8 @max-[560px]:hidden" />
          <SortHeader column="due" sort={sort} onSort={onSort} align="right" className="w-16 @max-[820px]:hidden" />
          <span className="w-12 shrink-0" />
        </div>
      </div>
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`group-${group.key}`}>
          {groupBy !== "none" && (
            <h2
              id={`group-${group.key}`}
              className="heading-group flex h-9 items-end gap-2 pb-2 pl-4"
              title={group.label}
            >
              <span className="min-w-0 truncate">{group.label}</span>
              <span className="num font-normal tracking-normal text-ink-faint">
                {group.tasks.length}
              </span>
            </h2>
          )}
          <div role="list" aria-label={groupBy === "none" ? t("tasks.list.label") : group.label}>
            {group.tasks.map((task) => {
              const editable = canEdit(task);
              return (
                <div role="listitem" key={task.id}>
                  <TaskRow
                    task={task}
                    stall={stalls.get(task.id) ?? null}
                    selected={
                      (selection.explicit && selection.ids.has(task.id)) || openCode === task.code
                    }
                    onOpen={open}
                    onModifiedClick={editable ? modified : undefined}
                    statusCell={editable ? <InlineStatus task={task} /> : undefined}
                    assigneeCell={editable ? <InlineAssignee task={task} /> : undefined}
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {showBar && <BulkBar tasks={selected} onClear={() => setSelection(EMPTY)} />}
    </div>
  );
}
