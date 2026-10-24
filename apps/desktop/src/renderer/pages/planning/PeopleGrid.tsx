import { useDroppable } from "@dnd-kit/core";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Person, Task } from "../../data/types";
import { SIZE_WEIGHT } from "../../domain/load";
import { planBlock, type PersonLoad } from "../../domain/planning";
import { currentWeek, weekLabel } from "../../domain/weeks";
import { LoadBar } from "../../tasks-ui/LoadBar";
import { Avatar } from "../../tasks-ui/PersonChip";
import { shortWeek } from "../tasks/pickers";
import { usePlanning } from "./context";
import { LockSign, PlanChip } from "./PlanChip";

/** Quante task mostra una cella prima di «+N more» (shape planning.md §5). */
export const CELL_CAP = 4;

export interface GridRow {
  person: Person;
  load: PersonLoad;
  /** Le task della persona per settimana, solo quelle che la cella mostra (qui: del progetto). */
  tasksByWeek: Record<string, Task[]>;
  /** Senza `planning.others` la riga altrui è in sola lettura: il motivo, a parole. */
  readOnly: string | null;
}

/** Il disegno della colonna persone + N settimane, comune a griglia e scheletro. */
export function gridTemplate(weeks: number): string {
  return `168px repeat(${weeks}, minmax(0, 1fr))`;
}

/**
 * Frecce fra celle (sinistra/destra, e su/giù oltre l'ultima carta) e su/giù
 * o J/K fra le carte della stessa cella. Lavora sul DOM della griglia:
 * le celle sono `[data-cell]` con riga e colonna, focalizzabili anche vuote.
 */
function gridNav(e: KeyboardEvent<HTMLElement>) {
  const el = e.currentTarget;
  const cell = el.closest<HTMLElement>("[data-cell]");
  const grid = el.closest<HTMLElement>("[role=grid]");
  if (!cell || !grid) return;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  const chips = [...cell.querySelectorAll<HTMLElement>("[data-chip]")];
  const at = chips.indexOf(el);
  const cellAt = (r: number, c: number) =>
    grid.querySelector<HTMLElement>(`[data-cell][data-row="${r}"][data-col="${c}"]`);
  const enter = (target: HTMLElement | null, last = false) => {
    if (!target) return;
    e.preventDefault();
    const inner = [...target.querySelectorAll<HTMLElement>("[data-chip]")];
    const chip = last ? inner.at(-1) : inner[0];
    if (chip) chip.focus();
    else target.focus();
  };
  switch (e.key) {
    case "ArrowLeft":
      return enter(cellAt(row, col - 1));
    case "ArrowRight":
      return enter(cellAt(row, col + 1));
    case "ArrowDown":
    case "j":
      if (at >= 0 && at < chips.length - 1) {
        e.preventDefault();
        chips[at + 1]!.focus();
        return;
      }
      return enter(cellAt(row + 1, col));
    case "ArrowUp":
    case "k":
      if (at > 0) {
        e.preventDefault();
        chips[at - 1]!.focus();
        return;
      }
      return enter(cellAt(row - 1, col), true);
  }
}

function WeekCell({
  row,
  rowIndex,
  week,
  colIndex,
  max,
  expanded,
  onExpand,
}: {
  row: GridRow;
  rowIndex: number;
  week: string;
  colIndex: number;
  max: number;
  expanded: boolean;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  const ctx = usePlanning();
  const personId = row.person.id;
  const tasks = row.tasksByWeek[week] ?? [];
  const cellLoad = row.load.byWeek[week]!;
  const dragging = ctx.dragging;
  const accepts = !!dragging && planBlock(dragging, personId, ctx.rightsOf(dragging)) === null;
  const { setNodeRef } = useDroppable({ id: `cell:${personId}:${week}`, disabled: !accepts });
  const isOver =
    accepts && ctx.over?.kind === "cell" && ctx.over.personId === personId && ctx.over.week === week;
  // Anteprima: la barra si allunga sotto il puntatore, prima del rilascio.
  const already = dragging && dragging.assigneeId === personId && dragging.plannedWeek === week;
  const preview = isOver && dragging?.size && !already ? SIZE_WEIGHT[dragging.size] : 0;
  const previewHere = !ctx.projectId || dragging?.projectId === ctx.projectId;
  const shown = expanded ? tasks : tasks.slice(0, CELL_CAP);
  const hidden = tasks.length - shown.length;
  const name = row.person.name;
  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      tabIndex={-1}
      data-cell
      data-row={rowIndex}
      data-col={colIndex}
      data-week={week}
      aria-label={t("planning.cellLabel", { person: name, week: shortWeek(week), count: cellLoad.count })}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget) gridNav(e);
      }}
      className={`flex min-w-0 flex-col gap-1.5 border-b border-l border-rule px-2 pt-2.5 pb-2 outline-none transition-colors duration-[var(--duration-fast)] ease-out focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus ${isOver ? "bg-ink/6" : ""} ${dragging && !accepts ? "opacity-60" : ""}`}
    >
      <div className="px-1">
        <LoadBar
          max={Math.max(max, cellLoad.weight + preview)}
          unsized={cellLoad.unsized + (isOver && dragging && !dragging.size && !already ? 1 : 0)}
          label={t("planning.loadOf", { person: name, week: shortWeek(week) })}
          segments={
            ctx.projectId
              ? [
                  {
                    weight: cellLoad.hereWeight + (previewHere ? preview : 0),
                    tone: "strong",
                    label: t("planning.loadHere"),
                  },
                  {
                    weight: cellLoad.weight - cellLoad.hereWeight + (previewHere ? 0 : preview),
                    tone: "faint",
                    label: t("planning.loadOthers"),
                  },
                ]
              : [{ weight: cellLoad.weight + preview, tone: "strong", label: t("planning.loadAll") }]
          }
        />
      </div>
      {shown.length > 0 ? (
        <div className="flex flex-col">
          {shown.map((task) => (
            <PlanChip
              key={task.id}
              task={task}
              spot={{ kind: "cell", personId, week }}
              onKeyNav={gridNav}
            />
          ))}
        </div>
      ) : (
        <span className="px-1 text-sm text-ink-faint">
          <span aria-hidden="true">—</span>
          <span className="sr-only">{t("planning.emptyCell")}</span>
        </span>
      )}
      {(hidden > 0 || (expanded && tasks.length > CELL_CAP)) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onExpand}
          className="self-start rounded-md px-2 py-0.5 text-xs font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
        >
          {expanded ? t("planning.showFewer") : t("planning.showMore", { count: hidden })}
        </button>
      )}
    </div>
  );
}

function RowHead({ row, projectView }: { row: GridRow; projectView: boolean }) {
  const { t } = useTranslation();
  const { load, person } = row;
  const stats = [
    projectView
      ? t("planning.stats.openHere", { count: load.openHere })
      : t("planning.stats.open", { count: load.openEverywhere }),
    ...(projectView ? [t("planning.stats.everywhere", { count: load.openEverywhere })] : []),
    ...(load.slipped > 0 ? [t("planning.stats.slipped", { count: load.slipped })] : []),
  ];
  return (
    <div
      role="rowheader"
      data-row-head={person.id}
      data-readonly={row.readOnly ? "true" : undefined}
      title={row.readOnly ?? undefined}
      className="sticky left-0 z-10 flex min-w-0 flex-col gap-1 border-b border-rule bg-ground py-2.5 pr-2 pl-4"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Avatar person={person} />
        <span title={person.name} className="min-w-0 truncate text-sm font-medium text-ink">
          {person.name}
        </span>
        {row.readOnly && (
          <>
            <LockSign className="ml-auto" />
            <span className="sr-only">{row.readOnly}</span>
          </>
        )}
      </span>
      <span className="num text-xs text-ink-muted">{stats.join(" · ")}</span>
    </div>
  );
}

/** Lo scheletro della matrice: 6 righe × le settimane in vista. */
export function GridSkeleton({ weeks }: { weeks: number }) {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <div className="grid border-b border-rule" style={{ gridTemplateColumns: gridTemplate(weeks) }}>
        <span className="h-12" />
        {Array.from({ length: weeks }, (_, i) => (
          <span key={i} className="flex flex-col justify-center gap-1.5 border-l border-rule px-3">
            <span className={`h-3 w-10 ${bar}`} />
            <span className={`h-2.5 w-20 ${bar}`} />
          </span>
        ))}
      </div>
      {Array.from({ length: 6 }, (_, r) => (
        <div key={r} className="grid" style={{ gridTemplateColumns: gridTemplate(weeks) }}>
          <span className="flex flex-col gap-2 border-b border-rule py-3 pl-4">
            <span className="flex items-center gap-2">
              <span className="size-[22px] rounded-full bg-ink/8" />
              <span className={`h-2.5 w-20 ${bar}`} />
            </span>
            <span className={`h-2 w-24 ${bar}`} />
          </span>
          {Array.from({ length: weeks }, (_, c) => (
            <span key={c} className="flex flex-col gap-2 border-b border-l border-rule px-3 py-3">
              <span className={`h-1.5 rounded-full ${bar}`} style={{ width: `${30 + ((r * 3 + c * 5) % 6) * 10}%` }} />
              {Array.from({ length: 1 + ((r + c) % 3) }, (_, i) => (
                <span key={i} className={`h-2.5 ${bar}`} style={{ width: `${55 + ((r + i) % 4) * 10}%` }} />
              ))}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * La matrice persone × settimane (shape planning.md §3): una riga per
 * persona (Claude per ultimo), una colonna per settimana in vista. Ogni
 * cella dice prima il carico — barra in taglie, mai un numero: questo
 * progetto a inchiostro pieno, gli altri al 30% — poi le task (4, poi
 * «+N more», che espande la riga). Intestazioni di settimana e colonna
 * persone restano ferme mentre si scorre.
 */
export function PeopleGrid({
  rows,
  weeks,
  max,
  later,
}: {
  rows: GridRow[];
  weeks: string[];
  max: number;
  /** «Later →» in fondo alle intestazioni. */
  later: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const ctx = usePlanning();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const now = currentWeek();
  const toggle = (personId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  const template = { gridTemplateColumns: gridTemplate(weeks.length) };
  return (
    <div
      role="grid"
      aria-label={t("planning.gridLabel")}
      aria-rowcount={rows.length + 1}
      aria-colcount={weeks.length + 1}
      className="min-w-0"
    >
      <div role="rowgroup" className="sticky top-0 z-20 bg-ground">
        <div role="row" className="grid border-b border-rule" style={template}>
          <div role="columnheader" className="flex items-end py-2 pl-4">
            <span className="heading-group">{t("planning.person")}</span>
          </div>
          {weeks.map((week, i) => (
            <div
              key={week}
              role="columnheader"
              className="flex min-w-0 items-center gap-2 border-l border-rule px-3 py-2"
            >
              <span className="flex min-w-0 flex-col">
                <span className="num flex items-baseline gap-2 text-sm font-semibold text-ink">
                  {shortWeek(week)}
                  {week === now && (
                    <span className="text-xs font-medium text-ink-muted">{t("planning.thisWeek")}</span>
                  )}
                </span>
                <span className="num truncate text-xs text-ink-muted">{weekLabel(week, i18n.language)}</span>
              </span>
              {i === weeks.length - 1 && <span className="ml-auto shrink-0">{later}</span>}
            </div>
          ))}
        </div>
      </div>
      <div role="rowgroup">
        {rows.map((row, r) => (
          <div key={row.person.id} role="row" data-person={row.person.id} className="grid" style={template}>
            <RowHead row={row} projectView={!!ctx.projectId} />
            {weeks.map((week, c) => (
              <WeekCell
                key={week}
                row={row}
                rowIndex={r}
                week={week}
                colIndex={c}
                max={max}
                expanded={expanded.has(row.person.id)}
                onExpand={() => toggle(row.person.id)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
