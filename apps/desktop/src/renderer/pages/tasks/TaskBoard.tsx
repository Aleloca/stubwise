import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { TFunction } from "i18next";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../data/dates";
import { useUpdateTask } from "../../data/queries";
import type { StatusFamily, Task, TaskPatch } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import type { Stall } from "../../domain/stalled";
import { DeptStrip, useDeptLabel } from "../../layout/DeptStrip";
import { PersonChip } from "../../tasks-ui/PersonChip";
import { SizeMark } from "../../tasks-ui/SizeMark";
import { StallMark } from "../../tasks-ui/StallMark";
import { FamilySign } from "../../tasks-ui/StatusLabel";
import { DueDate } from "../../tasks-ui/TaskRow";
import { useToast } from "../../tasks-ui/Toast";
import { groupTasks, type GroupContext } from "./grouping";

export type BoardLanes = "none" | "assignee" | "department";

/** Quante carte mostra una colonna `closed` prima di «Show older». */
const CLOSED_VISIBLE = 20;
const FAMILIES: StatusFamily[] = ["todo", "active", "closed"];

interface BoardColumn {
  key: string;
  name: string;
  family: StatusFamily;
  /** Lo stato che una task prende arrivando qui (per famiglia: il primo del suo progetto). */
  statusFor(task: Task): string | undefined;
}

interface Lane {
  key: string;
  label: string;
  /**
   * Ciò che una task prende arrivando nella corsia; `null` per «Other», che
   * raccoglie valori che il contesto non nomina e non è un posto dove mettere
   * una task (scriverebbe «other» come reparto o assegnatario).
   */
  patch: TaskPatch | null;
}

interface Picked {
  taskId: string;
  col: number;
  lane: number;
}

const cellId = (col: string, lane: string) => `${col}::${lane}`;

/**
 * Le colonne: gli stati del progetto nell'ordine del progetto; con task di
 * più progetti (un filtro salvato) le tre famiglie.
 */
function useColumns(ctx: GroupContext, projectId: string | undefined): BoardColumn[] {
  const { t } = useTranslation();
  return useMemo(() => {
    const sorted = [...ctx.statuses].sort((a, b) => a.order - b.order);
    if (projectId) {
      return sorted
        .filter((s) => s.projectId === projectId)
        .map((s) => ({ key: s.id, name: s.name, family: s.family, statusFor: () => s.id }));
    }
    return FAMILIES.map((family) => ({
      key: family,
      name: t(`taskUi.families.${family}`),
      family,
      statusFor: (task: Task) =>
        sorted.find((s) => s.projectId === task.projectId && s.family === family)?.id,
    }));
  }, [ctx.statuses, projectId, t]);
}

function columnKeyOf(task: Task, ctx: GroupContext, projectId: string | undefined): string {
  if (projectId) return task.statusId;
  return ctx.statuses.find((s) => s.id === task.statusId)?.family ?? "todo";
}

/** Il contenuto di una carta, su tre righe: striscia e codice, titolo, persona · taglia · scadenza. */
function CardBody({ task, stall }: { task: Task; stall: Stall | null }) {
  const overdue = !!task.dueDate && task.dueDate < TODAY && !task.closedAt;
  return (
    <>
      <DeptStrip departmentId={task.departmentId} />
      <span className="flex items-center gap-2">
        <span className="num text-xs font-semibold tracking-[0.02em] text-ink">{task.code}</span>
        <span className="ml-auto flex">{stall && <StallMark stall={stall} />}</span>
      </span>
      <span title={task.title} className="mt-1 line-clamp-2 text-sm text-ink">
        {task.title}
      </span>
      <span className="mt-2 flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1">
          <PersonChip personId={task.assigneeId} />
        </span>
        <SizeMark size={task.size} />
        <span className="w-14 shrink-0">
          <DueDate date={task.dueDate} overdue={overdue} />
        </span>
      </span>
    </>
  );
}

const cardClass =
  "relative flex cursor-default flex-col rounded-md border bg-surface py-2.5 pr-3 pl-3.5 text-left outline-none transition-colors duration-[var(--duration-fast)] ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

function Card({
  task,
  stall,
  editable,
  picked,
  current,
  onKeyDown,
  onOpen,
  onBlur,
  refocus,
  cell,
}: {
  task: Task;
  /** La cella in cui sta (colonna::corsia). */
  cell: string;
  stall: Stall | null;
  editable: boolean;
  picked: boolean;
  current: boolean;
  onKeyDown: (e: KeyboardEvent, task: Task) => void;
  onOpen: (task: Task) => void;
  onBlur: () => void;
  /** Il codice della carta spostata da tastiera: rinasca dove rinasca, riprende il fuoco. */
  refocus: MutableRefObject<string | null>;
}) {
  const { t } = useTranslation();
  const deptLabel = useDeptLabel(task.departmentId);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: !editable,
    data: { cell },
  });
  const node = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el;
      setNodeRef(el);
    },
    [setNodeRef],
  );
  // Una carta spostata cambia cella, quindi si smonta e rinasce (anche al
  // ritorno indietro di un errore): al montaggio riprende il fuoco.
  useLayoutEffect(() => {
    if (refocus.current === task.code) node.current?.focus();
  }, [refocus, task.code]);
  // Senza il permesso la carta resta un bottone che apre: niente «trascinabile».
  const dragProps = editable ? { ...attributes, ...listeners } : { role: "button", tabIndex: 0 };
  return (
    <div
      ref={ref}
      {...dragProps}
      data-card={task.code}
      data-picked={picked ? "true" : undefined}
      aria-label={t("tasks.board.cardLabel", { code: task.code, title: task.title })}
      aria-current={current ? "true" : undefined}
      title={deptLabel}
      onKeyDown={(e) => onKeyDown(e, task)}
      onClick={() => onOpen(task)}
      onBlur={onBlur}
      className={`${cardClass} ${picked ? "border-ink" : current ? "border-rule-strong bg-ink/6" : "border-rule hover:border-rule-strong"} ${isDragging ? "opacity-40" : ""}`}
    >
      <CardBody task={task} stall={stall} />
    </div>
  );
}

/** Una cella (colonna × corsia) che accetta le carte, col segnaposto della tastiera. */
function Cell({
  id,
  children,
  target,
  targetCode,
  empty,
  droppable,
}: {
  id: string;
  children: React.ReactNode;
  target: boolean;
  targetCode?: string;
  empty: boolean;
  droppable: boolean;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });
  return (
    <div
      ref={setNodeRef}
      data-cell={id}
      className={`flex min-h-16 w-[264px] shrink-0 flex-col gap-2 rounded-lg p-1.5 transition-colors duration-[var(--duration-fast)] ease-out ${isOver || target ? "bg-ink/6" : ""}`}
    >
      {children}
      {target && targetCode && (
        <span
          aria-hidden="true"
          className="grid h-14 place-items-center rounded-md border border-dashed border-rule-strong text-xs text-ink-muted"
        >
          {t("tasks.board.dropHere", { code: targetCode })}
        </span>
      )}
      {empty && !target && (
        <span className="px-2 py-1 text-sm text-ink-faint">
          <span aria-hidden="true">—</span>
          <span className="sr-only">{t("tasks.board.emptyColumn")}</span>
        </span>
      )}
    </div>
  );
}

/**
 * Gli annunci di `@dnd-kit` per il trascinamento col puntatore, tradotti e
 * coi nomi veri (codice della task, colonna, corsia) — mai gli id interni.
 * Il rilascio lo annuncia `move` (spostata, invariata) nell'annunciatore della
 * board: qui tace, per non dirlo due volte.
 */
export function pointerAnnouncements(
  t: TFunction,
  codeOf: (id: string) => string | undefined,
  placeOf: (cellId: string) => { column: string; lane: string } | undefined,
): Announcements {
  const code = (id: unknown) => codeOf(String(id)) ?? "";
  const over = (activeId: unknown, cellId: unknown) => {
    const place = cellId === undefined || cellId === null ? undefined : placeOf(String(cellId));
    if (!place) return undefined;
    return place.lane
      ? t("tasks.board.overLane", { code: code(activeId), column: place.column, lane: place.lane })
      : t("tasks.board.over", { code: code(activeId), column: place.column });
  };
  return {
    onDragStart: ({ active }) => {
      const place = placeOf(String(active.data.current?.cell ?? ""));
      return t("tasks.board.picked", { code: code(active.id), column: place?.column ?? "" });
    },
    onDragOver: ({ active, over: target }) => over(active.id, target?.id),
    onDragEnd: () => undefined,
    onDragCancel: ({ active }) => {
      const place = placeOf(String(active.data.current?.cell ?? ""));
      return t("tasks.board.cancelled", { code: code(active.id), column: place?.column ?? "" });
    },
  };
}

// Prima ciò che sta sotto il puntatore; fuori da ogni cella, la più sovrapposta.
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length ? within : rectIntersection(args);
};

/**
 * La board: una colonna per stato del progetto (per famiglia con più
 * progetti), corsie facoltative per assegnatario o reparto. Le carte si
 * spostano col puntatore (`@dnd-kit`) e con la tastiera — Spazio prende,
 * frecce spostano (sinistra/destra fra colonne, su/giù fra corsie), Spazio
 * lascia, Esc annulla, Invio apre — e ogni passo è annunciato. Lo
 * spostamento vale subito; se non riesce la carta torna dov'era e un
 * messaggio lo dice. Senza `tickets.edit` le carte si aprono soltanto.
 * Una colonna chiusa mostra le ultime 20 chiuse, poi «Show older».
 */
export function TaskBoard({
  tasks,
  projectId,
  lanes,
  ctx,
  stalls,
  openCode,
  onOpen,
}: {
  tasks: Task[];
  /** Il progetto della pagina: colonne = i suoi stati. Assente = colonne per famiglia. */
  projectId?: string;
  lanes: BoardLanes;
  ctx: GroupContext;
  stalls: Map<string, Stall>;
  openCode?: string;
  onOpen: (task: Task) => void;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const toast = useToast();
  const update = useUpdateTask();
  const columns = useColumns(ctx, projectId);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const refocus = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [showOlder, setShowOlder] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<Task | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const canEdit = (task: Task) => can(viewer, "tickets.edit", task.projectId);
  const anyEditable = tasks.some(canEdit) || (!!projectId && can(viewer, "tickets.edit", projectId));

  const laneList: Lane[] = useMemo(() => {
    if (lanes === "none") return [{ key: "all", label: "", patch: {} }];
    return groupTasks(tasks, lanes, ctx).map((g) => ({
      key: g.key,
      label: g.label,
      patch:
        g.key === "other"
          ? null
          : lanes === "assignee"
            ? { assigneeId: g.key === "none" ? null : g.key }
            : { departmentId: g.key },
    }));
  }, [lanes, tasks, ctx]);

  const laneKeyOf = (task: Task) =>
    lanes === "assignee" ? (task.assigneeId ?? "none") : lanes === "department" ? task.departmentId : "all";

  // La carta spostata da tastiera tiene il fuoco finché chi guarda non lo
  // porta altrove (anche dopo il ritorno indietro di un errore).
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const card = (e.target as Element | null)?.closest?.("[data-card]");
      if (card?.getAttribute("data-card") !== refocus.current) refocus.current = null;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // Le carte che cambiano posto (spostate, o spinte da quelle intorno)
  // scivolano dal posto di prima in 200 ms (FLIP). Le posizioni sono relative
  // alla board, così lo scorrimento non conta; niente col movimento ridotto.
  const positions = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const board = root.current;
    if (!board) return;
    const origin = board.getBoundingClientRect();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const next = new Map<string, { x: number; y: number }>();
    for (const el of board.querySelectorAll<HTMLElement>("[data-card]")) {
      const r = el.getBoundingClientRect();
      const at = { x: r.left - origin.left, y: r.top - origin.top };
      const code = el.dataset.card!;
      next.set(code, at);
      const before = positions.current.get(code);
      if (!before || reduce || typeof el.animate !== "function") continue;
      const dx = before.x - at.x;
      const dy = before.y - at.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: 200, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      );
    }
    positions.current = next;
  });

  const where = (col: number, lane: number) => ({
    column: columns[col]!.name,
    lane: laneList[lane]?.label ?? "",
  });

  function move(task: Task, col: number, lane: number) {
    const column = columns[col]!;
    const patch: TaskPatch = {};
    const statusId = column.statusFor(task);
    if (statusId && statusId !== task.statusId) patch.statusId = statusId;
    const lanePatch = laneList[lane]!.patch;
    if (lanes !== "none" && lanePatch) {
      for (const [k, v] of Object.entries(lanePatch) as [keyof TaskPatch, unknown][]) {
        if (task[k as keyof Task] !== v) Object.assign(patch, { [k]: v });
      }
    }
    const { column: columnName, lane: laneName } = where(col, lane);
    if (Object.keys(patch).length === 0) {
      setAnnouncement(t("tasks.board.unchanged", { code: task.code, column: columnName }));
      return;
    }
    setAnnouncement(
      lanes === "none"
        ? t("tasks.board.dropped", { code: task.code, column: columnName })
        : t("tasks.board.droppedLane", { code: task.code, column: columnName, lane: laneName }),
    );
    update.mutate(
      { id: task.id, patch },
      { onError: () => toast.error(t("tasks.board.moveFailed", { code: task.code })) },
    );
  }

  const indexOfColumn = (task: Task) =>
    Math.max(0, columns.findIndex((c) => c.key === columnKeyOf(task, ctx, projectId)));
  const indexOfLane = (task: Task) =>
    Math.max(0, laneList.findIndex((l) => l.key === laneKeyOf(task)));

  function onCardKeyDown(e: KeyboardEvent, task: Task) {
    const editable = canEdit(task);
    const mine = picked?.taskId === task.id ? picked : null;
    if (e.key === "Enter" && !mine) {
      e.preventDefault();
      onOpen(task);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      if (!editable) return;
      if (!mine) {
        const next = { taskId: task.id, col: indexOfColumn(task), lane: indexOfLane(task) };
        setPicked(next);
        setAnnouncement(
          t("tasks.board.picked", { code: task.code, column: where(next.col, next.lane).column }),
        );
      } else {
        setPicked(null);
        refocus.current = task.code;
        move(task, mine.col, mine.lane);
      }
      return;
    }
    if (!mine) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setPicked(null);
      setAnnouncement(
        t("tasks.board.cancelled", {
          code: task.code,
          column: columns[indexOfColumn(task)]!.name,
        }),
      );
      return;
    }
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    const col = Math.min(columns.length - 1, Math.max(0, mine.col + d[0]));
    let lane = Math.min(laneList.length - 1, Math.max(0, mine.lane + d[1]));
    // «Other» non accoglie: si resta dove si era (salvo che la task ci stia già).
    if (laneList[lane]!.patch === null && lane !== indexOfLane(task)) lane = mine.lane;
    setPicked({ ...mine, col, lane });
    const w = where(col, lane);
    setAnnouncement(
      lanes === "none"
        ? t("tasks.board.over", { code: task.code, column: w.column })
        : t("tasks.board.overLane", { code: task.code, column: w.column, lane: w.lane }),
    );
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const task = tasks.find((x) => x.id === e.active.id);
    const over = e.over?.id;
    if (!task || typeof over !== "string") return;
    const [colKey, laneKey] = over.split("::");
    const col = columns.findIndex((c) => c.key === colKey);
    const lane = laneList.findIndex((l) => l.key === laneKey);
    if (col >= 0 && lane >= 0 && laneList[lane]!.patch !== null) move(task, col, lane);
  }

  const pickedTask = picked ? tasks.find((x) => x.id === picked.taskId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={(e) => setDragging(tasks.find((x) => x.id === e.active.id) ?? null)}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
      accessibility={{
        screenReaderInstructions: { draggable: t("tasks.board.instructions") },
        announcements: pointerAnnouncements(
          t,
          (id) => tasks.find((x) => x.id === id)?.code,
          (id) => {
            const [colKey, laneKey] = id.split("::");
            const column = columns.find((c) => c.key === colKey);
            const lane = laneList.find((l) => l.key === laneKey);
            return column && lane ? { column: column.name, lane: lane.label } : undefined;
          },
        ),
      }}
    >
      <span data-testid="board-announcer" role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {!anyEditable && (
        <p className="sticky left-0 px-4 pt-3 pb-1 text-sm text-ink-muted">{t("tasks.board.readOnly")}</p>
      )}
      <div ref={root} className="inline-flex min-w-full flex-col px-2.5 pb-6">
        <div className="sticky top-0 z-10 flex gap-3 bg-ground pt-1 pb-1">
          {columns.map((c) => {
            const count = tasks.filter((x) => columnKeyOf(x, ctx, projectId) === c.key).length;
            return (
              <div
                key={c.key}
                data-column-header={c.key}
                title={c.name}
                className="flex h-8 w-[264px] shrink-0 items-center gap-2 border-b border-rule px-1.5"
              >
                <FamilySign family={c.family} />
                <span className="min-w-0 truncate text-sm font-semibold text-ink">{c.name}</span>
                <span className="num text-xs text-ink-faint">{count}</span>
              </div>
            );
          })}
        </div>
        {laneList.map((lane, laneIndex) => {
          const laneTasks = tasks.filter((x) => laneKeyOf(x) === lane.key);
          return (
            <section
              key={lane.key}
              aria-label={lanes === "none" ? t("tasks.board.label") : t("tasks.board.lane", { name: lane.label, count: laneTasks.length })}
              className={lanes === "none" ? "" : "border-b border-rule pb-2"}
            >
              {lanes !== "none" && (
                <h2 className="heading-group sticky left-2.5 flex h-9 w-max max-w-[60vw] items-end gap-2 px-1.5 pb-2">
                  <span className="truncate" title={lane.label}>
                    {lane.label}
                  </span>
                  <span className="num font-normal tracking-normal text-ink-faint">
                    {laneTasks.length}
                  </span>
                </h2>
              )}
              <div className="flex gap-3">
                {columns.map((c, colIndex) => {
                  let cards = laneTasks.filter((x) => columnKeyOf(x, ctx, projectId) === c.key);
                  const total = cards.length;
                  const limited = c.family === "closed" && !showOlder.has(c.key);
                  if (c.family === "closed") {
                    cards = [...cards].sort((a, b) =>
                      (b.closedAt ?? "").localeCompare(a.closedAt ?? ""),
                    );
                  }
                  if (limited) cards = cards.slice(0, CLOSED_VISIBLE);
                  const target =
                    !!picked && picked.col === colIndex && picked.lane === laneIndex &&
                    !(colIndex === indexOfColumn(pickedTask!) && laneIndex === indexOfLane(pickedTask!));
                  return (
                    <section
                      key={c.key}
                      data-column={c.key}
                      aria-label={t("tasks.board.column", { name: c.name, count: total })}
                      className="contents"
                    >
                      <Cell
                        id={cellId(c.key, lane.key)}
                        target={target}
                        targetCode={pickedTask?.code}
                        empty={total === 0}
                        droppable={lane.patch !== null}
                      >
                        {cards.map((task) => (
                          <Card
                            key={task.id}
                            task={task}
                            stall={stalls.get(task.id) ?? null}
                            editable={canEdit(task)}
                            picked={picked?.taskId === task.id}
                            current={openCode === task.code}
                            onKeyDown={onCardKeyDown}
                            onOpen={onOpen}
                            refocus={refocus}
                            cell={cellId(c.key, lane.key)}
                            onBlur={() => {
                              if (picked?.taskId === task.id) setPicked(null);
                            }}
                          />
                        ))}
                        {limited && total > CLOSED_VISIBLE && (
                          <button
                            type="button"
                            onClick={() => setShowOlder((s) => new Set(s).add(c.key))}
                            className="h-8 rounded-md px-2 text-left text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
                          >
                            {t("tasks.board.showOlder", { count: total - CLOSED_VISIBLE })}
                          </button>
                        )}
                      </Cell>
                    </section>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div
            className={`${cardClass} w-[252px] border-rule-strong shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]`}
          >
            <CardBody task={dragging} stall={stalls.get(dragging.id) ?? null} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
