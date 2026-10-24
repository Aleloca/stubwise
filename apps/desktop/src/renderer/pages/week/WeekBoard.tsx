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
import {
  useDayArrangements,
  useSessionPersonId,
  useSetDay,
  useTasks,
} from "../../data/queries";
import type { DayArrangement, Task } from "../../data/types";
import { load, usualWeekWeight } from "../../domain/load";
import { currentWeek, weekDays, weekLabel } from "../../domain/weeks";
import { DeptStrip, useDeptLabel } from "../../layout/DeptStrip";
import { LoadBar } from "../../tasks-ui/LoadBar";
import { SizeMark } from "../../tasks-ui/SizeMark";
import { FamilySign } from "../../tasks-ui/StatusLabel";
import { formatDue } from "../../tasks-ui/TaskRow";
import { useToast } from "../../tasks-ui/Toast";
import { shortWeek } from "../tasks/pickers";

// La mia settimana (spec §2, shape home.md §6): le task assegnate a chi
// guarda e pianificate per una settimana, sistemate nei giorni. Il giorno è
// una sistemazione PERSONALE dell'assegnatario (`DayArrangement`), non un
// campo della task: lo vede solo lui, e il «server» lo azzera quando la task
// cambia settimana o assegnatario. Qui ci sono i pezzi comuni al blocco della
// Home e alla pagina intera: i dati, la barra del carico e la board.

/** Le colonne: 0 = «This week» (in settimana, senza giorno), 1–5 = lunedì–venerdì. */
export const SLOTS = [0, 1, 2, 3, 4, 5] as const;
export type Slot = (typeof SLOTS)[number];

const toDay = (slot: Slot): DayArrangement["day"] => (slot === 0 ? null : slot);

/** La colonna di oggi nella settimana (0 se oggi non è un giorno feriale di quella settimana). */
export function todaySlot(week: string): Slot {
  return (weekDays(week).indexOf(TODAY) + 1) as Slot;
}

const isClosed = (task: Task) => task.closedAt !== null;

/** Aperte prima, poi per codice: l'ordine non cambia spostando una carta. */
function byOpenThenCode(a: Task, b: Task): number {
  return Number(isClosed(a)) - Number(isClosed(b)) || a.code.localeCompare(b.code, "en", { numeric: true });
}

export interface MyWeek {
  /** Le query da cui dipende (per caricamento, errore e «Retry»). */
  queries: { isError: boolean; data?: unknown; refetch: () => unknown }[];
  /** Le mie task della settimana, aperte e chiuse. */
  tasks: Task[];
  /** Le stesse, per colonna (`SLOTS`). */
  bySlot: Task[][];
  /**
   * Il peso della mia settimana solita (`usualWeekWeight`, le 6 prima di
   * questa): la barra si confronta con quella. `null` senza storia.
   */
  usual: number | null;
}

/**
 * Le mie task della settimana, sistemate nei giorni. Una sistemazione vale
 * solo per la settimana in cui la task sta: se la task ne è uscita, conta
 * «in settimana». La settimana solita si misura sulle mie settimane prima
 * di quella di oggi, non di quella in vista: è la stessa misura per ogni
 * settimana che si sfoglia, così due barre si confrontano.
 */
export function useMyWeek(week: string): MyWeek {
  const me = useSessionPersonId();
  const tasks = useTasks({ assigneeIds: [me] });
  const arrangements = useDayArrangements(week);
  return useMemo(() => {
    const mine = (tasks.data ?? []).filter((t) => t.assigneeId === me);
    const inWeek = mine.filter((t) => t.plannedWeek === week).sort(byOpenThenCode);
    const days = new Map(
      (arrangements.data ?? []).filter((a) => a.week === week).map((a) => [a.taskId, a.day]),
    );
    const bySlot: Task[][] = SLOTS.map(() => []);
    for (const task of inWeek) bySlot[days.get(task.id) ?? 0]!.push(task);
    return {
      queries: [tasks, arrangements],
      tasks: inWeek,
      bySlot,
      usual: usualWeekWeight(mine, currentWeek()),
    };
  }, [tasks, arrangements, me, week]);
}

/** «W43 · Oct 19 – Oct 23». */
export function useWeekRange(): (week: string) => string {
  const { t, i18n } = useTranslation();
  return (week) =>
    t("week.range", { week: shortWeek(week), range: weekLabel(week, i18n.language) });
}

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** Il nome del giorno nella lingua: «Mon» / «Lun», «Monday» / «Lunedì». */
export function dayName(date: string, language: string, width: "short" | "long"): string {
  return capitalize(
    new Date(`${date}T00:00:00Z`).toLocaleDateString(language, { weekday: width, timeZone: "UTC" }),
  );
}

const SIZES_DESC = ["XL", "L", "M", "S", "XS"] as const;

/**
 * Il mio carico della settimana, in taglie e mai in numero: le aperte a
 * inchiostro pieno, le chiuse al 30%, confrontate con la mia settimana
 * solita (R-D2): la traccia vale il doppio della solita e un filetto segna
 * «solita», così una settimana normale arriva a metà e una pesante si vede.
 * Senza storia (`usual` null) niente barra: solo le taglie della settimana.
 * Le senza stima non pesano e non valgono zero: si contano a parte,
 * «+N no estimate».
 */
export function WeekLoad({ tasks, usual }: { tasks: Task[]; usual: number | null }) {
  const { t } = useTranslation();
  const open = load(tasks.filter((x) => !isClosed(x)));
  const done = load(tasks.filter(isClosed));
  const unsized = open.unsized + done.unsized;
  if (usual === null) {
    const counts = SIZES_DESC.map((size) => ({
      size,
      count: tasks.filter((x) => x.size === size).length,
    })).filter((c) => c.count > 0);
    const parts = counts.map((c) => t("week.sizeCount", { count: c.count, size: c.size }));
    return (
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-ink-muted">
        {parts.length > 0 && (
          <span
            className="num font-medium whitespace-nowrap"
            title={t("week.noUsual")}
          >
            {parts.join(" · ")}
          </span>
        )}
        {unsized > 0 && (
          <span className="whitespace-nowrap">{t("taskUi.load.unsized", { count: unsized })}</span>
        )}
      </span>
    );
  }
  return (
    <LoadBar
      max={usual * 2}
      marker={{ weight: usual, label: t("week.usual") }}
      unsized={unsized}
      label={t("week.load")}
      relativeLabel={(percent) => t("week.loadUsual", { label: t("week.load"), percent })}
      title={t("week.usualTitle")}
      segments={[
        { weight: open.weight, tone: "strong", label: t("week.loadOpen") },
        { weight: done.weight, tone: "faint", label: t("week.loadDone") },
      ]}
    />
  );
}

/**
 * «Slipped ×N»: la task è arrivata qui da settimane precedenti, N volte.
 * `compact` (le celle di Planning) mostra solo il segno e «×N»; la frase
 * intera resta per i lettori di schermo e nel `title`.
 */
export function SlipMark({ count, compact = false }: { count: number; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      title={t("week.slippedTitle", { count })}
      className="num inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap text-ink-muted"
    >
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
        <path d="M3 5h7.5a2.5 2.5 0 0 1 0 5H5" />
        <path d="m6.5 8-2 2 2 2" />
      </svg>
      {compact ? (
        <>
          <span aria-hidden="true">×{count}</span>
          <span className="sr-only">{t("week.slipped", { count })}</span>
        </>
      ) : (
        t("week.slipped", { count })
      )}
    </span>
  );
}

/** Il contenuto di una carta: striscia, codice e taglia, titolo (2 righe, 3 se stretta), segni. */
function CardBody({ task }: { task: Task }) {
  const { t } = useTranslation();
  const closed = isClosed(task);
  return (
    <>
      <DeptStrip departmentId={task.departmentId} />
      <span className="flex items-center gap-2">
        <span className="num text-xs font-semibold tracking-[0.02em] whitespace-nowrap text-ink">
          {task.code}
        </span>
        <span className="ml-auto flex">
          <SizeMark size={task.size} />
        </span>
      </span>
      <span
        title={task.title}
        className={`mt-1 line-clamp-2 text-sm break-words @max-[150px]:line-clamp-3 ${closed ? "text-ink-muted" : "text-ink"}`}
      >
        {task.title}
      </span>
      {(closed || task.slipCount > 0) && (
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {closed && (
            <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
              <FamilySign family="closed" />
              {t("week.done")}
            </span>
          )}
          {task.slipCount > 0 && <SlipMark count={task.slipCount} />}
        </span>
      )}
    </>
  );
}

const cardClass =
  "relative flex cursor-default flex-col rounded-md border bg-surface py-2 pr-2.5 pl-3 text-left outline-none transition-colors duration-[var(--duration-fast)] ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

function Card({
  task,
  slot,
  editable,
  picked,
  current,
  onKeyDown,
  onOpen,
  onBlur,
  refocus,
}: {
  task: Task;
  slot: Slot;
  editable: boolean;
  picked: boolean;
  current: boolean;
  onKeyDown: (e: KeyboardEvent, task: Task) => void;
  onOpen: (task: Task) => void;
  onBlur: () => void;
  /** Il codice della carta spostata da tastiera: rinasce nella colonna nuova e riprende il fuoco. */
  refocus: MutableRefObject<string | null>;
}) {
  const { t } = useTranslation();
  const deptLabel = useDeptLabel(task.departmentId);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: !editable,
    data: { slot },
  });
  const node = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el;
      setNodeRef(el);
    },
    [setNodeRef],
  );
  useLayoutEffect(() => {
    if (refocus.current === task.code) node.current?.focus();
  }, [refocus, task.code]);
  // Chiusa o in una settimana passata la carta si apre soltanto: niente «trascinabile».
  const dragProps = editable ? { ...attributes, ...listeners } : { role: "button", tabIndex: 0 };
  return (
    <div
      ref={ref}
      {...dragProps}
      data-card={task.code}
      data-picked={picked ? "true" : undefined}
      aria-label={t("week.cardLabel", { code: task.code, title: task.title })}
      aria-current={current ? "true" : undefined}
      title={deptLabel}
      onKeyDown={(e) => onKeyDown(e, task)}
      onClick={() => onOpen(task)}
      onBlur={onBlur}
      className={`${cardClass} ${picked ? "border-ink" : current ? "border-rule-strong bg-ink/6" : "border-rule hover:border-rule-strong"} ${isDragging ? "opacity-40" : ""}`}
    >
      <CardBody task={task} />
    </div>
  );
}

/** Una colonna (un giorno, o «This week») che accetta le carte, col segnaposto della tastiera. */
function Column({
  slot,
  label,
  header,
  count,
  target,
  targetCode,
  children,
}: {
  slot: Slot;
  label: string;
  header: React.ReactNode;
  count: number;
  target: boolean;
  targetCode?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: `day-${slot}` });
  return (
    <section
      aria-label={t("week.column", { name: label, count })}
      data-day={slot}
      className="@container flex min-w-0 flex-col"
    >
      {header}
      <div
        ref={setNodeRef}
        className={`flex min-h-40 flex-1 flex-col gap-2 rounded-lg p-1 transition-colors duration-[var(--duration-fast)] ease-out ${isOver || target ? "bg-ink/6" : ""}`}
      >
        {children}
        {target && targetCode && (
          <span
            aria-hidden="true"
            className="grid min-h-14 place-items-center rounded-md border border-dashed border-rule-strong px-2 text-center text-xs text-ink-muted"
          >
            {t("week.dropHere", { code: targetCode })}
          </span>
        )}
        {count === 0 && !target && (
          <span className="px-2 py-1 text-sm text-ink-faint">
            <span aria-hidden="true">—</span>
            <span className="sr-only">{t("week.emptyColumn")}</span>
          </span>
        )}
      </div>
    </section>
  );
}

// Prima ciò che sta sotto il puntatore; fuori da ogni colonna, la più sovrapposta.
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length ? within : rectIntersection(args);
};

/**
 * La settimana a sei colonne: «This week» (senza giorno) a sinistra, perché è
 * la vasca da cui si smista, poi lunedì–venerdì; oggi è detto a parole
 * («Today»), non con un colore. Le carte si spostano fra i giorni col
 * puntatore e con la tastiera — Spazio prende, frecce sinistra/destra,
 * Spazio lascia, Esc annulla, Invio apre — e ogni passo è annunciato.
 * Lo spostamento vale subito; se non riesce la carta torna dov'era e un
 * messaggio lo dice. In sola lettura (settimana passata) e per le chiuse le
 * carte si aprono soltanto.
 */
export function WeekBoard({
  week,
  bySlot,
  readOnly,
  openCode,
  onOpen,
}: {
  week: string;
  bySlot: Task[][];
  readOnly: boolean;
  openCode?: string;
  onOpen: (task: Task) => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const setDay = useSetDay();
  const [picked, setPicked] = useState<{ taskId: string; slot: Slot } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState<Task | null>(null);
  const refocus = useRef<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const dates = weekDays(week);
  const today = todaySlot(week);
  const all = bySlot.flat();

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

  /** Il nome della colonna negli annunci: «Monday», «This week (no day)». */
  const spoken = (slot: Slot) =>
    slot === 0 ? t("week.anyDayName") : dayName(dates[slot - 1]!, i18n.language, "long");
  const slotOf = (task: Task) => bySlot.findIndex((list) => list.some((x) => x.id === task.id)) as Slot;
  const editable = (task: Task) => !readOnly && !isClosed(task);

  function move(task: Task, slot: Slot) {
    if (slot === slotOf(task)) {
      setAnnouncement(t("week.unchanged", { code: task.code, column: spoken(slot) }));
      return;
    }
    setAnnouncement(t("week.dropped", { code: task.code, column: spoken(slot) }));
    setDay.mutate(
      { taskId: task.id, week, day: toDay(slot) },
      { onError: () => toast.error(t("week.moveFailed", { code: task.code })) },
    );
  }

  function onCardKeyDown(e: KeyboardEvent, task: Task) {
    const mine = picked?.taskId === task.id ? picked : null;
    if (e.key === "Enter" && !mine) {
      e.preventDefault();
      onOpen(task);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      if (!editable(task)) return;
      if (!mine) {
        const slot = slotOf(task);
        setPicked({ taskId: task.id, slot });
        setAnnouncement(t("week.picked", { code: task.code, column: spoken(slot) }));
      } else {
        setPicked(null);
        refocus.current = task.code;
        move(task, mine.slot);
      }
      return;
    }
    if (!mine) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setPicked(null);
      setAnnouncement(t("week.cancelled", { code: task.code, column: spoken(slotOf(task)) }));
      return;
    }
    const delta = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    const slot = Math.min(5, Math.max(0, mine.slot + delta)) as Slot;
    setPicked({ ...mine, slot });
    setAnnouncement(t("week.over", { code: task.code, column: spoken(slot) }));
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const task = all.find((x) => x.id === e.active.id);
    const over = e.over?.id;
    if (!task || typeof over !== "string") return;
    move(task, Number(over.replace("day-", "")) as Slot);
  }

  const codeOf = (id: unknown) => all.find((x) => x.id === id)?.code ?? "";
  const slotOfId = (id: unknown): Slot | undefined => {
    const n = Number(String(id ?? "").replace("day-", ""));
    return Number.isInteger(n) && n >= 0 && n <= 5 ? (n as Slot) : undefined;
  };
  // Gli annunci del trascinamento col puntatore, coi nomi veri (codice, giorno);
  // il rilascio lo dice `move`, qui tace per non dirlo due volte.
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t("week.picked", { code: codeOf(active.id), column: spoken(active.data.current?.slot ?? 0) }),
    onDragOver: ({ active, over }) => {
      const slot = slotOfId(over?.id);
      return slot === undefined ? undefined : t("week.over", { code: codeOf(active.id), column: spoken(slot) });
    },
    onDragEnd: () => undefined,
    onDragCancel: ({ active }) =>
      t("week.cancelled", { code: codeOf(active.id), column: spoken(active.data.current?.slot ?? 0) }),
  };

  const pickedTask = picked ? all.find((x) => x.id === picked.taskId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={(e) => setDragging(all.find((x) => x.id === e.active.id) ?? null)}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
      accessibility={{
        screenReaderInstructions: { draggable: t("week.instructions") },
        announcements,
      }}
    >
      <span data-testid="week-announcer" role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <div className="grid grid-cols-6 gap-2">
        {SLOTS.map((slot) => {
          const cards = bySlot[slot]!;
          const date = slot === 0 ? null : dates[slot - 1]!;
          const isToday = slot !== 0 && slot === today;
          const label =
            slot === 0
              ? t("week.anyDayName")
              : isToday
                ? t("week.todayName", { name: `${dayName(date!, i18n.language, "long")}, ${formatDue(date!, i18n.language)}` })
                : `${dayName(date!, i18n.language, "long")}, ${formatDue(date!, i18n.language)}`;
          const header = (
            <div
              aria-hidden="true"
              className={`mb-1.5 flex flex-col border-b px-1.5 pb-1.5 ${isToday ? "border-ink" : "border-rule"}`}
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span
                  className={`min-w-0 truncate text-sm ${isToday || slot === 0 ? "font-semibold text-ink" : "font-medium text-ink-muted"}`}
                >
                  {slot === 0 ? t("week.anyDay") : dayName(date!, i18n.language, "short")}
                </span>
                {cards.length > 0 && (
                  <span className="num ml-auto text-xs text-ink-faint">{cards.length}</span>
                )}
              </span>
              <span className="num truncate text-xs text-ink-muted">
                {slot === 0 ? t("week.noDay") : formatDue(date!, i18n.language)}
                {isToday && (
                  <span className="font-semibold text-ink"> · {t("week.today")}</span>
                )}
              </span>
            </div>
          );
          const target =
            !!picked && picked.slot === slot && !!pickedTask && slotOf(pickedTask) !== slot;
          return (
            <Column
              key={slot}
              slot={slot}
              label={label}
              header={header}
              count={cards.length}
              target={target}
              targetCode={pickedTask?.code}
            >
              {cards.map((task) => (
                <Card
                  key={task.id}
                  task={task}
                  slot={slot}
                  editable={editable(task)}
                  picked={picked?.taskId === task.id}
                  current={openCode === task.code}
                  onKeyDown={onCardKeyDown}
                  onOpen={onOpen}
                  refocus={refocus}
                  onBlur={() => {
                    if (picked?.taskId === task.id) setPicked(null);
                  }}
                />
              ))}
            </Column>
          );
        })}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div
            className={`${cardClass} w-[180px] border-rule-strong shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]`}
          >
            <CardBody task={dragging} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
