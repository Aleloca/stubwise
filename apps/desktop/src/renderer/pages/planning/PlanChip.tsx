import { useDraggable } from "@dnd-kit/core";
import { useCallback, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { usePeople } from "../../data/queries";
import type { Task } from "../../data/types";
import { canMove } from "../../domain/planning";
import { DeptStrip, useDeptLabel } from "../../layout/DeptStrip";
import { Avatar } from "../../tasks-ui/PersonChip";
import { SizeMark } from "../../tasks-ui/SizeMark";
import { SlipMark } from "../week/WeekBoard";
import { usePlanning, type Spot } from "./context";

/** La riga compatta di una task, condivisa da carta e anteprima del trascinamento. */
export function ChipBody({ task, withAssignee }: { task: Task; withAssignee: boolean }) {
  const people = usePeople().data;
  const assignee = withAssignee && task.assigneeId ? people?.find((p) => p.id === task.assigneeId) : null;
  return (
    <>
      <DeptStrip departmentId={task.departmentId} />
      <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] whitespace-nowrap text-ink">
        {task.code}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{task.title}</span>
      {task.slipCount > 0 && <SlipMark count={task.slipCount} compact />}
      <span className="flex w-5 shrink-0 justify-end">
        <SizeMark size={task.size} />
      </span>
      {assignee && (
        <span title={assignee.name} className="shrink-0">
          <Avatar person={assignee} />
          <span className="sr-only">{assignee.name}</span>
        </span>
      )}
    </>
  );
}

export const chipClass =
  "group relative flex h-8 min-w-0 cursor-default items-center gap-2 rounded-md pr-2 pl-3 text-left outline-none transition-colors duration-[var(--duration-fast)] ease-out focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";

/**
 * Una task nella vasca o in una cella: striscia, codice, titolo, segni.
 * Si trascina col puntatore; da tastiera Invio apre il dettaglio e «P»
 * apre il menu «Plan» (persona → settimana). Se chi guarda non può
 * spostarla resta apribile, con il motivo nel `title`.
 */
export function PlanChip({
  task,
  spot,
  withAssignee = false,
  onKeyNav,
}: {
  task: Task;
  spot: Spot;
  withAssignee?: boolean;
  /** Frecce e J/K: il genitore sposta il fuoco fra le carte. */
  onKeyNav?: (e: KeyboardEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();
  const ctx = usePlanning();
  const deptLabel = useDeptLabel(task.departmentId);
  const movable = canMove(task, ctx.rightsOf(task));
  const lock = movable ? null : ctx.lockReason(task);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: !movable,
    data: { spot },
  });
  const node = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el;
      setNodeRef(el);
    },
    [setNodeRef],
  );
  const { refocus } = ctx;
  useLayoutEffect(() => {
    if (refocus.current === task.code) node.current?.focus();
  }, [refocus, task.code]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      ctx.openTask(task.code);
      return;
    }
    if ((e.key === "p" || e.key === "P") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (movable && node.current) ctx.openPlanMenu(task, node.current);
      return;
    }
    onKeyNav?.(e);
  }

  const current = ctx.openCode === task.code;
  const dragProps = movable ? { ...attributes, ...listeners } : { role: "button", tabIndex: 0 };
  return (
    <div
      ref={ref}
      {...dragProps}
      data-chip={task.code}
      data-locked={lock ? "true" : undefined}
      aria-label={t("planning.chipLabel", { code: task.code, title: task.title })}
      aria-current={current ? "true" : undefined}
      aria-description={lock ?? (movable ? t("planning.chipHint") : undefined)}
      title={[deptLabel, lock].filter(Boolean).join(" · ") || undefined}
      onKeyDown={onKeyDown}
      onClick={() => ctx.openTask(task.code)}
      className={`${chipClass} ${current ? "bg-ink/10" : "hover:bg-ink/6"} ${isDragging ? "opacity-40" : ""}`}
    >
      <ChipBody task={task} withAssignee={withAssignee} />
      {lock && <LockSign />}
    </div>
  );
}

/** Il lucchetto discreto di ciò che chi guarda non può spostare. */
export function LockSign({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-lock
      className={`shrink-0 text-ink-faint ${className}`}
    >
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.25" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}
