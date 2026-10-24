import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../data/dates";
import type { GroupBy, Milestone, Task } from "../../data/types";
import type { Stall } from "../../domain/stalled";
import { addWeeks, currentWeek, weekDays } from "../../domain/weeks";
import { DeptStrip, useDeptLabel } from "../../layout/DeptStrip";
import { StallMark } from "../../tasks-ui/StallMark";
import { FamilySign } from "../../tasks-ui/StatusLabel";
import { TaskRow, formatDue } from "../../tasks-ui/TaskRow";
import { groupTasks, type GroupContext } from "./grouping";
import { shortWeek } from "./pickers";

/** Larghezza di una settimana sull'asse: un giorno = 1/7. */
const WEEK_W = 96;
const DAY_W = WEEK_W / 7;
const DAY_MS = 86_400_000;
/** Margine a sinistra dell'asse: la striscia del reparto e un po' d'aria. */
const GUTTER = 16;

/** Le settimane dell'asse: da due prima di quella di oggi a otto dopo. */
export function weekRange(): string[] {
  return Array.from({ length: 11 }, (_, i) => addWeeks(currentWeek(), i - 2));
}

const mondayOf = (week: string) => weekDays(week)[0]!;
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

type Shape =
  | { kind: "bar"; start: string; endExclusive: string }
  | { kind: "point"; at: string; by: "due" | "week" };

/**
 * La forma di una task sull'asse: barra dal lunedì della settimana
 * pianificata alla scadenza compresa (lunghezza = durata esatta, in giorni),
 * punto se ha una data sola, niente se non ne ha. Una scadenza prima della
 * settimana non capovolge la barra: va dalla prima data all'ultima.
 */
function shapeOf(task: Task): Shape | null {
  const { plannedWeek: week, dueDate: due } = task;
  if (week && due) {
    const monday = mondayOf(week);
    const start = due < monday ? due : monday;
    const end = due < monday ? addDays(monday, 7) : addDays(due, 1);
    return { kind: "bar", start, endExclusive: end };
  }
  if (due) return { kind: "point", at: due, by: "due" };
  // Senza scadenza la settimana è un punto a metà dei giorni lavorativi.
  if (week) return { kind: "point", at: addDays(mondayOf(week), 2), by: "week" };
  return null;
}

/** Quanto spazio serve a codice e titolo dentro una barra (stima, senza misurare). */
const labelWidth = (task: Task) => 36 + task.code.length * 7 + task.title.length * 6.4;

function TimelineItem({
  task,
  shape,
  rangeStart,
  rangeEnd,
  ctx,
  stall,
  current,
  onOpen,
}: {
  task: Task;
  shape: Shape;
  rangeStart: string;
  rangeEnd: string;
  ctx: GroupContext;
  stall: Stall | null;
  current: boolean;
  onOpen: (task: Task) => void;
}) {
  const { t, i18n } = useTranslation();
  const deptLabel = useDeptLabel(task.departmentId);
  const status = ctx.statuses.find((s) => s.id === task.statusId);
  const closed = status?.family === "closed";
  const date = (d: string) => formatDue(d, i18n.language);
  const x = (d: string) => GUTTER + days(rangeStart, d) * DAY_W;
  const total = days(rangeStart, rangeEnd);

  const label = (
    <span className="flex min-w-0 items-center gap-1.5">
      {closed && <FamilySign family="closed" />}
      <span className="num shrink-0 text-xs font-semibold tracking-[0.02em]">{task.code}</span>
      <span className="truncate text-sm">{task.title}</span>
    </span>
  );

  let left: number;
  let width: number;
  let name: string;
  let before = false;
  let after = false;
  if (shape.kind === "bar") {
    const from = Math.max(0, days(rangeStart, shape.start));
    const to = Math.min(total, days(rangeStart, shape.endExclusive));
    before = days(rangeStart, shape.start) < 0;
    after = days(rangeStart, shape.endExclusive) > total;
    left = GUTTER + Math.min(from, total) * DAY_W;
    // Fuori dall'intervallo resta un trattino sul bordo, col motivo nel `title`.
    width = Math.max(6, (Math.max(to, from) - from) * DAY_W);
    name = t("tasks.timeline.bar", {
      code: task.code,
      title: task.title,
      from: date(shape.start),
      to: date(addDays(shape.endExclusive, -1)),
    });
  } else {
    const at = Math.min(total - 0.5, Math.max(0.5, days(rangeStart, shape.at) + 0.5));
    before = days(rangeStart, shape.at) < 0;
    after = days(rangeStart, shape.at) >= total;
    left = x(rangeStart) + at * DAY_W - 6;
    width = 12;
    name =
      shape.by === "due"
        ? t("tasks.timeline.pointDue", { code: task.code, title: task.title, date: date(shape.at) })
        : t("tasks.timeline.pointWeek", {
            code: task.code,
            title: task.title,
            week: shortWeek(task.plannedWeek!),
          });
  }
  const outside = before ? t("tasks.timeline.before") : after ? t("tasks.timeline.after") : null;
  const inside = shape.kind === "bar" && width >= labelWidth(task);
  const tone = closed ? "text-ink-muted" : "text-ink";

  return (
    <div
      data-timeline-row={task.code}
      data-current={current ? "" : undefined}
      title={deptLabel}
      className={`group/row relative h-9 border-b border-rule/60 ${current ? "bg-ink/6" : "hover:bg-ink/4"}`}
    >
      <span className="sticky left-0 z-[1] block h-full w-1">
        <DeptStrip departmentId={task.departmentId} />
      </span>
      <button
        type="button"
        data-timeline-item={task.code}
        data-shape={shape.kind}
        data-days={shape.kind === "bar" ? days(shape.start, shape.endExclusive) : undefined}
        aria-label={name}
        aria-current={current ? "true" : undefined}
        title={outside ? `${task.title} · ${outside}` : task.title}
        onClick={() => onOpen(task)}
        style={{ left, width: inside ? width : undefined, minWidth: width }}
        className={`absolute top-1.5 z-[3] flex h-6 items-center gap-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${tone}`}
      >
        {shape.kind === "bar" ? (
          <span
            aria-hidden="true"
            style={{ width }}
            className={`absolute inset-y-0 left-0 ${closed ? "bg-[color-mix(in_oklab,var(--ink)_8%,var(--ground))]" : "bg-[color-mix(in_oklab,var(--ink)_22%,var(--ground))] group-hover/row:bg-[color-mix(in_oklab,var(--ink)_30%,var(--ground))]"} ${before ? "rounded-r-md" : after ? "rounded-l-md" : "rounded-md"}`}
          />
        ) : (
          <span
            aria-hidden="true"
            className={`absolute top-1/2 left-0 ${shape.by === "due" ? "ml-0.5 size-2.5 -translate-y-1/2 rotate-45 rounded-[1px]" : "size-3 -translate-y-1/2 rounded-full"} ${closed ? "bg-ink-faint" : "bg-ink"}`}
          />
        )}
        <span
          aria-hidden="true"
          style={inside ? undefined : { marginLeft: width + 4 }}
          className={`relative flex min-w-0 items-center gap-2 whitespace-nowrap ${inside ? "pr-2 pl-2.5" : "timeline-knockout rounded-sm px-1"}`}
        >
          {label}
        </span>
      </button>
      {stall && (
        <span
          className="timeline-knockout absolute top-2 z-[3] rounded-sm px-1"
          style={{ left: left + Math.max(width, inside ? width : width + labelWidth(task)) + 8 }}
        >
          <StallMark stall={stall} />
        </span>
      )}
    </div>
  );
}

/**
 * La timeline: asse a settimane da due prima di oggi a otto dopo (scorre in
 * orizzontale), oggi come linea d'inchiostro sottile, i traguardi come linee
 * tratteggiate col nome in cima. Ogni task è una riga: barra dalla settimana
 * pianificata alla scadenza (lunga quanto la durata), punto se ha una data
 * sola — rombo la scadenza, cerchio la settimana —, con codice e titolo
 * dentro se ci stanno, altrimenti a destra; una chiusa è più chiara e porta
 * il segno della spunta (non il solo colore). Le righe seguono il
 * raggruppamento dell'elenco; le task senza date stanno sotto, in «No dates».
 */
export function TaskTimeline({
  tasks,
  groupBy,
  ctx,
  milestones,
  stalls,
  openCode,
  onOpen,
}: {
  tasks: Task[];
  groupBy: GroupBy;
  ctx: GroupContext;
  milestones: Milestone[];
  stalls: Map<string, Stall>;
  openCode?: string;
  onOpen: (task: Task) => void;
}) {
  const { t, i18n } = useTranslation();
  const weeks = weekRange();
  const rangeStart = mondayOf(weeks[0]!);
  const rangeEnd = addDays(mondayOf(weeks.at(-1)!), 7);
  const total = days(rangeStart, rangeEnd);
  const width = GUTTER * 2 + total * DAY_W;
  const x = (d: string) => GUTTER + days(rangeStart, d) * DAY_W;

  const { dated, undated } = useMemo(() => {
    const dated: Task[] = [];
    const undated: Task[] = [];
    for (const task of tasks) (shapeOf(task) ? dated : undated).push(task);
    return { dated, undated };
  }, [tasks]);
  const groups = useMemo(() => groupTasks(dated, groupBy, ctx), [dated, groupBy, ctx]);
  const visibleMilestones = milestones.filter(
    (m) => m.dueDate && m.dueDate >= rangeStart && m.dueDate < rangeEnd,
  );
  const thisWeek = currentWeek();

  return (
    <div className="pb-6">
      <div style={{ width }} className="relative">
        {/* Testata: traguardi e settimane, ferma in alto mentre le righe scorrono. */}
        <div className="sticky top-0 z-10 border-b border-rule bg-ground">
          <div className="relative h-6" aria-hidden={visibleMilestones.length === 0}>
            {visibleMilestones.map((m) => (
              <span
                key={m.id}
                style={{ left: x(m.dueDate!) + DAY_W / 2 + 4 }}
                title={m.name}
                className="absolute top-1 max-w-36 truncate text-xs font-medium text-ink-muted"
              >
                {m.name}
              </span>
            ))}
          </div>
          <ol aria-label={t("tasks.timeline.weeks")} className="relative flex h-9">
            {weeks.map((w) => (
              <li
                key={w}
                style={{ left: x(mondayOf(w)), width: WEEK_W }}
                aria-current={w === thisWeek ? "date" : undefined}
                className="absolute inset-y-0 flex flex-col justify-center border-l border-rule px-2"
              >
                <span
                  className={`num text-xs font-semibold ${w === thisWeek ? "text-ink" : "text-ink-muted"}`}
                >
                  {shortWeek(w)}
                </span>
                <span className="num text-xs text-ink-faint">
                  {formatDue(mondayOf(w), i18n.language)}
                </span>
              </li>
            ))}
          </ol>
        </div>

        {/* Griglia, oggi e traguardi: dietro le righe, per tutta l'altezza. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 top-6">
          {weeks.map((w) => (
            <span
              key={w}
              style={{ left: x(mondayOf(w)) }}
              className="absolute inset-y-0 border-l border-rule/60"
            />
          ))}
        </div>
        <span
          data-today
          role="img"
          aria-label={`${t("tasks.timeline.today")}, ${formatDue(TODAY, i18n.language)}`}
          style={{ left: x(TODAY) + DAY_W / 2 }}
          className="pointer-events-none absolute top-6 bottom-0 z-[2] w-px bg-ink"
        >
          <span className="absolute -top-px -left-[3px] size-[7px] rounded-full bg-ink" />
        </span>
        {visibleMilestones.map((m) => (
          <span
            key={m.id}
            data-milestone={m.id}
            role="img"
            aria-label={t("tasks.timeline.milestone", {
              name: m.name,
              date: formatDue(m.dueDate!, i18n.language),
            })}
            style={{ left: x(m.dueDate!) + DAY_W / 2 }}
            className="pointer-events-none absolute top-1 bottom-0 z-[2] border-l border-dashed border-ink/50"
          />
        ))}

        {groups.map((group) => (
          <section key={group.key} aria-label={groupBy === "none" ? t("tasks.timeline.label") : group.label}>
            {groupBy !== "none" && (
              <h2 className="heading-group sticky left-0 flex h-9 w-max max-w-[60vw] items-end gap-2 pb-2 pl-4">
                <span className="truncate" title={group.label}>
                  {group.label}
                </span>
                <span className="num font-normal tracking-normal text-ink-faint">
                  {group.tasks.length}
                </span>
              </h2>
            )}
            {group.tasks.map((task) => (
              <TimelineItem
                key={task.id}
                task={task}
                shape={shapeOf(task)!}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
                ctx={ctx}
                stall={stalls.get(task.id) ?? null}
                current={openCode === task.code}
                onOpen={onOpen}
              />
            ))}
          </section>
        ))}
      </div>

      {undated.length > 0 && (
        <section aria-label={t("tasks.timeline.noDates")} className="sticky left-0 mt-8">
          <h2
            className="heading-group flex h-9 items-end gap-2 border-b border-rule pb-2 pl-4"
          >
            {t("tasks.timeline.noDates")}
            <span className="num font-normal tracking-normal text-ink-faint">{undated.length}</span>
          </h2>
          {undated.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              stall={stalls.get(task.id) ?? null}
              selected={openCode === task.code}
              onOpen={onOpen}
            />
          ))}
        </section>
      )}
    </div>
  );
}
