import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import type { TFunction } from "i18next";
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  availableFields,
  childLists,
  joinPath,
  triggerFields,
} from "../../../domain/automations/fields";
import { AUTOMATION_LIMITS } from "../../../domain/automations/fields";
import type { Approval, Step } from "../../../data/types";
import { MenuGroup, itemClass } from "../../../tasks-ui/Menu";
import { MenuButton } from "../../tasks/controls";
import { conditionWords, stepSentence, templateParts, triggerWords } from "../format";
import { ApprovalGlyph, CriticalGlyph, Disclosure, MoreGlyph, StepGlyph } from "../glyphs";
import { useBuilder, type BuilderState } from "./context";
import { tokenLabel } from "./DataText";
import { producerOf, shortProblem, startProblems } from "./issues";
import { innerCount, isBlock, moveTo, placeOf, type DropTarget } from "./tree";

// Il flusso come procedura scritta (shape builder §3, [A 3]): un elenco
// numerato verticale, l'inizio in testa, i rami come corsie rientrate di
// 20px con la loro etichetta in parole e il «+ Add a step» sempre visibile.
// È un `role="tree"`: ↑/↓ fra le righe, → apre/entra, ← chiude/esce, Enter
// seleziona; Spazio prende il passo e ↑/↓ lo spostano nell'ordine di lettura
// (entrando e uscendo dalle corsie), Spazio lascia, Esc annulla; A aggiunge
// dopo, ⌘D duplica, ⌫ elimina, ⌥↑/⌥↓ spostano di uno ([A 13], [A 14]). Col
// puntatore: la maniglia a sei punti (dnd-kit, come la Home), anche dentro e
// fuori dalle corsie, con la linea d'inserimento.

const ROW = "[data-tree-row]";
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

function focusRow(tree: HTMLElement | null, id: string) {
  requestAnimationFrame(() =>
    tree?.querySelector<HTMLElement>(`${ROW}[data-tree-row="${id}"]`)?.focus(),
  );
}

/** «Asks Laura Costa» / «Asks the Project Lead» / «Asks the owner»; null se parte da solo ([A 5]). */
export function asksWords(approval: Approval, b: BuilderState, t: TFunction) {
  if (approval.mode !== "ask") return null;
  const who = approval.who;
  if ("owner" in who) return t("automations.builder.asks.owner");
  if ("personId" in who)
    return who.personId
      ? t("automations.builder.asks.person", { name: b.names.person(who.personId) })
      : t("automations.builder.asks.nobody");
  return t("automations.builder.asks.role", {
    role: t(`automations.roles.${who.projectRole}`, { defaultValue: who.projectRole }),
  });
}

/** L'etichetta di una corsia, in parole. */
export function laneLabel(step: Step, seg: string, b: BuilderState, t: TFunction) {
  switch (step.kind) {
    case "condition":
      return seg === "then"
        ? t("automations.builder.lane.if", {
            when: conditionWords(step.when, b.labels, t as never),
          })
        : t("automations.builder.lane.otherwise");
    case "claude":
      return t("automations.builder.lane.claude", { outcome: seg });
    case "forEach":
      return t("automations.builder.lane.forEach", {
        as: step.as || t("automations.builder.lane.item"),
        list: step.list ? tokenLabel(b.flow, step.list, b.labels) : "…",
      });
    case "repeatUntil":
      return seg === "onLimit"
        ? t("automations.builder.lane.onLimit")
        : t("automations.builder.lane.repeat", {
            until: conditionWords(step.until, b.labels, t as never),
            count: step.max,
          });
    default:
      return seg;
  }
}

/** Un testo con i dati come gettoni; un dato che qui non c'è è barrato, col perché. */
function Tokens({ text, available }: { text: string; available: Set<string> }) {
  const { t } = useTranslation();
  const b = useBuilder();
  return (
    <>
      {templateParts(text, b.labels).map((p, i) => {
        if ("text" in p) return <span key={i}>{p.text}</span>;
        const ok = available.has(p.ref);
        const from = ok ? null : producerOf(b.flow, p.ref);
        const n = from ? b.numbers.get(from.path) : undefined;
        return (
          <span
            key={i}
            data-token={p.ref}
            data-unavailable={ok ? undefined : ""}
            title={
              ok
                ? undefined
                : n !== undefined
                  ? t("automations.builder.data.laterOrElsewhere", { n })
                  : t("automations.builder.data.gone")
            }
            className={`rounded-[4px] px-1 ${ok ? "bg-ink/6" : "bg-critical/10 text-critical line-through decoration-critical"}`}
          >
            {tokenLabel(b.flow, p.ref, b.labels)}
          </span>
        );
      })}
    </>
  );
}

interface Indicator {
  key: string;
  edge: "top" | "bottom";
  target: DropTarget;
}

export function FlowTree({ treeRef }: { treeRef: React.RefObject<HTMLUListElement | null> }) {
  const { t } = useTranslation();
  const b = useBuilder();
  const [focusId, setFocusId] = useState<string>("trigger");
  const [picked, setPicked] = useState<{ id: string; original: BuilderState["flow"] } | null>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const say = (key: string, id: string, extra: object = {}) => {
    const path = b.paths.get(id);
    b.announce(t(key, { n: path ? b.numbers.get(path) : "", ...extra }));
  };

  const where = (id: string): string => {
    const path = b.paths.get(id);
    if (path === undefined) return "";
    const { lane, index } = placeOf(path);
    if (lane === "") return t("automations.builder.move.inMain", { position: index + 1 });
    const blockPath = lane.split("/").slice(0, -1).join("/");
    const seg = lane.split("/").at(-1)!;
    const block = blockPath === "" ? null : findByPath(b, blockPath);
    return t("automations.builder.move.inLane", {
      position: index + 1,
      lane: block ? laneLabel(block, seg, b, t) : "",
    });
  };

  // --- tastiera -----------------------------------------------------------------
  const rows = () => [...(treeRef.current?.querySelectorAll<HTMLElement>(ROW) ?? [])];
  const go = (from: HTMLElement, dir: 1 | -1) => {
    const list = rows();
    const next = list[list.indexOf(from) + dir];
    next?.focus();
  };

  const onRowKey = (e: KeyboardEvent<HTMLElement>, id: string) => {
    if (e.target !== e.currentTarget) return;
    const step = id === "trigger" ? null : findById(b, id);
    const mod = e.metaKey || e.ctrlKey;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (picked && picked.id === id) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        handled();
        b.move(id, e.key === "ArrowUp" ? -1 : 1);
        focusRow(treeRef.current, id);
      } else if (e.key === " " || e.key === "Enter") {
        handled();
        setPicked(null);
        b.announce(t("automations.builder.move.dropped", { where: where(id) }));
      } else if (e.key === "Escape") {
        handled();
        b.update(() => picked.original);
        setPicked(null);
        b.announce(t("automations.builder.move.cancelled"));
        focusRow(treeRef.current, id);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (e.altKey && step && !b.readOnly) {
          handled();
          b.move(id, e.key === "ArrowUp" ? -1 : 1);
          focusRow(treeRef.current, id);
          return;
        }
        handled();
        go(e.currentTarget, e.key === "ArrowDown" ? 1 : -1);
        return;
      case "ArrowRight":
        if (step && isBlock(step.kind)) {
          handled();
          if (b.collapsed.has(id)) b.toggleCollapsed(id, true);
          else go(e.currentTarget, 1);
        }
        return;
      case "ArrowLeft": {
        handled();
        if (step && isBlock(step.kind) && !b.collapsed.has(id)) b.toggleCollapsed(id, false);
        else e.currentTarget.parentElement?.closest<HTMLElement>(ROW)?.focus();
        return;
      }
      case "Enter":
        handled();
        b.select(id);
        return;
    }
    if (!step || b.readOnly) return;
    if (e.key === " ") {
      handled();
      setPicked({ id, original: b.flow });
      say("automations.builder.move.picked", id, { where: where(id) });
    } else if ((e.key === "a" || e.key === "A") && !mod && !e.altKey) {
      handled();
      const { lane, index } = placeOf(b.paths.get(id)!);
      b.requestAdd(lane, index + 1, e.currentTarget);
    } else if (mod && (e.key === "d" || e.key === "D")) {
      handled();
      b.duplicate(id);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      handled();
      b.requestDelete(id);
    }
  };

  const onRowBlur = (id: string) =>
    requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active?.dataset.treeRow === id) return;
      setPicked((p) => (p?.id === id ? null : p));
    });

  // --- puntatore ------------------------------------------------------------------
  const onDragMove = ({ active, over, activatorEvent, delta }: DragMoveEvent) => {
    if (!over) return setIndicator(null);
    const key = String(over.id);
    const y = (activatorEvent as PointerEvent).clientY + delta.y;
    if (key.startsWith("lane:")) {
      const [, block, seg] = key.split(":");
      return setIndicator({
        key,
        edge: "top",
        target: { block: block === "" ? null : block!, seg: seg! },
      });
    }
    const id = key.slice("row:".length);
    if (id === String(active.id)) return setIndicator(null);
    const before = y < over.rect.top + over.rect.height / 2;
    setIndicator({
      key,
      edge: before ? "top" : "bottom",
      target: before ? { before: id } : { after: id },
    });
  };
  const onDragEnd = ({ active }: DragEndEvent) => {
    const id = String(active.id);
    const target = indicator?.target;
    setIndicator(null);
    const path = b.paths.get(id);
    if (!target || path === undefined) return;
    const r = moveTo(b.flow.steps, path, target);
    if (!r) {
      b.announce(t("automations.builder.move.notThere"));
      return;
    }
    b.update((f) => ({ ...f, steps: r.steps }));
    b.announce(t("automations.builder.move.moved", { n: b.numbers.get(path) ?? "" }));
  };

  const ctx: RowCtx = {
    focusId,
    setFocusId,
    picked: picked?.id ?? null,
    indicator,
    onKey: onRowKey,
    onBlur: onRowBlur,
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={() => setIndicator(null)}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) =>
            t("automations.builder.move.picked", {
              n: b.numbers.get(b.paths.get(String(active.id)) ?? "") ?? "",
              where: where(String(active.id)),
            }),
          onDragOver: () => undefined,
          onDragEnd: () => undefined,
          onDragCancel: () => t("automations.builder.move.cancelled"),
        },
        screenReaderInstructions: { draggable: t("automations.builder.move.instructions") },
      }}
    >
      <ul
        ref={treeRef}
        role="tree"
        aria-label={t("automations.builder.flowLabel")}
        aria-describedby="builder-tree-help"
        className="flex flex-col"
      >
        <StartRow ctx={ctx} />
        {b.flow.steps.map((s, i) => (
          <StepRow key={s.id} step={s} path={String(i)} depth={0} ctx={ctx} />
        ))}
        <AddRow lane="" block={null} seg="" index={b.flow.steps.length} depth={0} ctx={ctx} main />
        {b.flow.steps.length === 0 && (
          <li role="none" className="pl-11 text-sm text-ink-muted">
            {t("automations.builder.emptyHint")}
          </li>
        )}
        {b.issues.flow.length > 0 && b.flow.steps.length === 0 && (
          <li role="none" className="flex items-center gap-1.5 pl-11 text-sm text-critical">
            <CriticalGlyph />
            {t("automations.builder.problem.noSteps")}
          </li>
        )}
        <li role="none" className="flex h-10 items-center pl-11 text-sm text-ink-faint">
          {t("automations.builder.end")}
        </li>
      </ul>
      <p id="builder-tree-help" className="sr-only">
        {t("automations.builder.treeHelp")}
      </p>
    </DndContext>
  );
}

function findById(b: BuilderState, id: string): Step | null {
  const path = b.paths.get(id);
  return path === undefined ? null : findByPath(b, path);
}

function findByPath(b: BuilderState, path: string): Step | null {
  let list: Step[] = b.flow.steps;
  let step: Step | null = null;
  const segs = path.split("/");
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]!;
    if (/^\d+$/.test(seg)) {
      step = list[Number(seg)] ?? null;
      if (!step) return null;
    } else {
      const child = childLists(step!).find((c) => c.seg === seg);
      if (!child) return null;
      list = child.steps;
    }
  }
  return step;
}

interface RowCtx {
  focusId: string;
  setFocusId(id: string): void;
  picked: string | null;
  indicator: Indicator | null;
  onKey(e: KeyboardEvent<HTMLElement>, id: string): void;
  onBlur(id: string): void;
}

const rowClass = (selected: boolean, picked: boolean) =>
  `group/row relative flex min-h-12 items-start gap-2 rounded-md py-2 pr-2 pl-1 outline-none transition-colors duration-[var(--duration-fast)] ease-out focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus ${
    picked
      ? "z-10 bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
      : selected
        ? "bg-ink/10"
        : "hover:bg-ink/4"
  }`;

/** L'inizio: «When …», i dati che porta, i suoi problemi. Non si sposta e non si cancella. */
function StartRow({ ctx }: { ctx: RowCtx }) {
  const { t, i18n } = useTranslation();
  const b = useBuilder();
  const tr = b.flow.trigger;
  const chosen = !(tr.kind === "source" && tr.sourceId === "");
  const count = triggerFields(b.flow, b.sources).length;
  const problems = startProblems(b.issues.start, b.flow, b.names, t);
  const selected = b.selected === "trigger" || b.selected === null;
  return (
    <li
      role="treeitem"
      aria-level={1}
      aria-selected={selected}
      tabIndex={ctx.focusId === "trigger" ? 0 : -1}
      data-tree-row="trigger"
      onFocus={() => ctx.setFocusId("trigger")}
      onKeyDown={(e) => ctx.onKey(e, "trigger")}
      onClick={() => b.select("trigger")}
      className={`${rowClass(b.selected === "trigger", false)} mb-1 cursor-default`}
    >
      <span className="w-[56px] shrink-0 pt-0.5 pr-0.5 text-right text-xs font-semibold text-ink-muted">
        {t("automations.builder.when")}
      </span>
      <span className="pt-0.5">
        <StepGlyph kind="trigger" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`text-md ${chosen ? "text-ink" : "font-medium text-critical"}`}>
          {chosen
            ? triggerWords(tr, b.names, t, i18n.language, b.automation.projectId)
            : t("automations.builder.start.choose")}
        </span>
        {chosen && (
          <span className="text-xs text-ink-muted">
            {t("automations.builder.start.dataCount", { count })}
            {" · "}
            <button
              type="button"
              tabIndex={-1}
              className="underline-offset-4 hover:text-ink hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                b.select("trigger", { focusPanel: true });
              }}
            >
              {t("automations.builder.start.see")}
            </button>
          </span>
        )}
        {problems.map((p, i) => (
          <span
            key={i}
            data-row-problem
            className="flex items-center gap-1.5 text-sm text-critical"
          >
            <CriticalGlyph />
            {p}
          </span>
        ))}
      </span>
    </li>
  );
}

function StepRow({
  step,
  path,
  depth,
  ctx,
}: {
  step: Step;
  path: string;
  depth: number;
  ctx: RowCtx;
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const n = b.numbers.get(path) ?? 0;
  const block = isBlock(step.kind);
  const open = block && !b.collapsed.has(step.id);
  const issues = b.issues.byStep.get(step.id) ?? [];
  const available = useMemo(
    () => new Set(availableFields(b.flow, path, b.sources).map((f) => f.key)),
    [b.flow, b.sources, path],
  );
  const sentence = stepSentence(step, b.flow, b.names, b.labels, t, (id) => automationCode(b, id));
  const asks = "approval" in step ? asksWords(step.approval, b, t) : null;
  const project = projectMark(step, b, t);
  const selected = b.selected === step.id;
  const picked = ctx.picked === step.id;
  const drag = useDraggable({ id: step.id, disabled: b.readOnly });
  const drop = useDroppable({ id: `row:${step.id}` });
  const ind = ctx.indicator?.key === `row:${step.id}` ? ctx.indicator.edge : null;
  const inside = block ? innerCount(step) : 0;
  const insideProblems = block ? countInside(step, b) : 0;
  const name = `${t("automations.builder.stepN", { n })}, ${t(`automations.builder.kind.${step.kind}`)}`;

  return (
    <li
      role="treeitem"
      aria-level={depth + 2}
      aria-expanded={block ? open : undefined}
      aria-selected={selected}
      aria-label={name}
      aria-describedby={`row-text-${step.id}`}
      tabIndex={ctx.focusId === step.id ? 0 : -1}
      data-tree-row={step.id}
      data-step-path={path}
      onFocus={(e) => {
        if (e.target === e.currentTarget) ctx.setFocusId(step.id);
      }}
      onBlur={() => ctx.onBlur(step.id)}
      onKeyDown={(e) => ctx.onKey(e, step.id)}
      onClick={(e) => {
        e.stopPropagation();
        b.select(step.id);
      }}
      className="event-enter relative flex flex-col outline-none focus-visible:[&>div:first-child]:outline-2 focus-visible:[&>div:first-child]:-outline-offset-2 focus-visible:[&>div:first-child]:outline-focus"
      style={{ opacity: drag.isDragging ? 0.4 : undefined }}
    >
      <div ref={drop.setNodeRef} className={rowClass(selected, picked)}>
        {ind && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute right-0 left-0 h-0.5 bg-ink ${ind === "top" ? "-top-px" : "-bottom-px"}`}
          />
        )}
        {!b.readOnly && (
          <button
            ref={drag.setNodeRef}
            type="button"
            aria-hidden="true"
            {...drag.listeners}
            {...drag.attributes}
            tabIndex={-1}
            role={undefined}
            aria-label={undefined}
            aria-roledescription={undefined}
            aria-describedby={undefined}
            data-step-handle={step.id}
            className={`-ml-1 grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded text-ink-faint opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:text-ink active:cursor-grabbing ${selected || picked ? "opacity-100" : ""}`}
          >
            <GripIcon />
          </button>
        )}
        <span className="num w-7 shrink-0 pt-0.5 text-right text-sm text-ink-faint">{n}</span>
        <span className="pt-0.5">
          <StepGlyph kind={step.kind} />
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
          <span
            id={`row-text-${step.id}`}
            className="line-clamp-2 min-w-[min(360px,100%)] flex-1 text-md text-ink"
          >
            {sentence.text ? (
              <Tokens text={sentence.text} available={available} />
            ) : (
              t(`automations.builder.kind.${step.kind}`)
            )}
            {sentence.details.length > 0 && (
              <span className="text-ink-muted">
                {" "}
                ·{" "}
                {sentence.details.map((d, i) => (
                  <span key={i}>
                    {i > 0 && " · "}
                    <Tokens text={d} available={available} />
                  </span>
                ))}
              </span>
            )}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            {asks && (
              <span data-asks className="inline-flex items-center gap-1">
                <ApprovalGlyph />
                {asks}
              </span>
            )}
            {project && (
              <span title={project.title} className="inline-flex items-center">
                {project.text}
              </span>
            )}
            {issues.length > 0 && (
              <span
                data-row-problem
                className="inline-flex items-center gap-1 text-sm text-critical"
              >
                <CriticalGlyph />
                {shortProblem(issues, step, b.names, t)}
              </span>
            )}
            {block && !open && (
              <span>
                {t("automations.builder.collapsed", {
                  branches: childLists(step).length,
                  count: inside,
                })}
                {insideProblems > 0 && (
                  <span className="text-critical">
                    {" · "}
                    {t("automations.builder.problemsInside", { count: insideProblems })}
                  </span>
                )}
              </span>
            )}
          </span>
        </span>
        {block && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={open ? t("automations.builder.collapse") : t("automations.builder.expand")}
            onClick={(e) => {
              e.stopPropagation();
              b.toggleCollapsed(step.id);
            }}
            className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-ink/6"
          >
            <Disclosure open={open} />
          </button>
        )}
        {!b.readOnly && <RowMenu step={step} path={path} />}
        {!b.readOnly && (
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              const { lane, index } = placeOf(path);
              b.requestAdd(lane, index + 1, e.currentTarget);
            }}
            className="absolute -bottom-3 left-10 z-10 hidden h-6 items-center gap-1 rounded-md border border-rule bg-surface px-2 text-xs text-ink-muted group-hover/row:flex hover:text-ink"
          >
            {t("automations.builder.add.here")}
          </button>
        )}
      </div>
      {open && (
        <ul
          role="group"
          aria-label={t("automations.builder.branchesOf", { n })}
          className="flex flex-col"
        >
          {childLists(step).map((c) => (
            <Lane
              key={c.seg}
              step={step}
              seg={c.seg}
              steps={c.steps}
              path={joinPath(path, c.seg)}
              depth={depth + 1}
              ctx={ctx}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function countInside(step: Step, b: BuilderState): number {
  let n = 0;
  for (const c of childLists(step))
    for (const s of c.steps) {
      n += b.issues.byStep.get(s.id)?.length ?? 0;
      n += countInside(s, b);
    }
  return n;
}

function automationCode(b: BuilderState, id: string): string | null {
  return b.otherAutomations.find((a) => a.id === id)?.code ?? null;
}

function projectMark(step: Step, b: BuilderState, t: TFunction) {
  if (!("project" in step)) return null;
  const p = step.project;
  if (p.mode === "own") return null;
  if (p.mode === "from_client") {
    if (b.automation.projectId === null) return null;
    return { text: t("automations.steps.inClientProject"), title: undefined };
  }
  const prj = b.names.project(p.projectId);
  if (!prj)
    return p.projectId ? { text: t("automations.steps.inHiddenProject"), title: undefined } : null;
  return {
    text: t("automations.steps.inProject", { code: prj.code }),
    title: `${prj.code} · ${prj.name}`,
  };
}

function Lane({
  step,
  seg,
  steps,
  path,
  depth,
  ctx,
}: {
  step: Step;
  seg: string;
  steps: Step[];
  path: string;
  depth: number;
  ctx: RowCtx;
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const label = laneLabel(step, seg, b, t);
  return (
    <li role="none" className="ml-5 flex flex-col border-l border-rule pl-0" data-lane={path}>
      <p className="flex items-baseline gap-3 pt-1.5 pb-0.5 pl-3 text-xs font-semibold text-ink-muted">
        <span className="min-w-0">{label}</span>
        {step.kind === "forEach" && (
          <span className="font-normal text-ink-faint">
            {t("automations.builder.lane.upTo", { count: AUTOMATION_LIMITS.forEachRounds })}
          </span>
        )}
      </p>
      <ul role="group" aria-label={label} className="flex flex-col">
        {steps.map((s, i) => (
          <StepRow key={s.id} step={s} path={joinPath(path, String(i))} depth={depth} ctx={ctx} />
        ))}
        {steps.length === 0 && (
          <li role="none" className="py-1 pl-10 text-sm text-ink-faint">
            {t("automations.builder.lane.nothing")}
          </li>
        )}
        <AddRow
          lane={path}
          block={step.id}
          seg={seg}
          index={steps.length}
          depth={depth}
          ctx={ctx}
        />
      </ul>
    </li>
  );
}

function AddRow({
  lane,
  block,
  seg,
  index,
  depth,
  ctx,
  main = false,
}: {
  lane: string;
  block: string | null;
  seg: string;
  index: number;
  depth: number;
  ctx: RowCtx;
  main?: boolean;
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const key = `lane:${block ?? ""}:${seg}`;
  const drop = useDroppable({ id: key });
  if (b.readOnly) return null;
  const ind = ctx.indicator?.key === key;
  void depth;
  return (
    <li role="none" ref={drop.setNodeRef} className="relative">
      {ind && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 right-0 left-0 h-0.5 bg-ink"
        />
      )}
      <button
        type="button"
        data-add-step={lane}
        onClick={(e) => b.requestAdd(lane, index, e.currentTarget)}
        className={`flex h-8 items-center gap-2 rounded-md pr-2 pl-[38px] text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 hover:text-ink ${main ? "mt-1" : ""}`}
      >
        <svg
          viewBox="0 0 16 16"
          width={14}
          height={14}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M8 3.5v9M3.5 8h9" />
        </svg>
        {t("automations.builder.add.step")}
      </button>
    </li>
  );
}

function RowMenu({ step, path }: { step: Step; path: string }) {
  const { t } = useTranslation();
  const b = useBuilder();
  const mod = isMac ? "⌘" : "Ctrl+";
  const opt = isMac ? "⌥" : "Alt+";
  const item = (label: string, keys: string, run: () => void, danger = false): ReactNode => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`${itemClass} ${danger ? "text-critical" : ""}`}
      onClick={run}
    >
      <span className="flex-1">{label}</span>
      {keys && <kbd className="num text-xs text-ink-faint">{keys}</kbd>}
    </button>
  );
  return (
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <MenuButton
        ariaLabel={t("automations.builder.rowMenu", { n: b.numbers.get(path) ?? "" })}
        menuLabel={t("automations.builder.rowMenu", { n: b.numbers.get(path) ?? "" })}
        align="right"
        label={<MoreGlyph />}
        className="grid size-7 shrink-0 place-items-center rounded-md text-ink-faint opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:bg-ink/6 hover:text-ink aria-expanded:opacity-100"
      >
        {(close) => (
          <>
            <MenuGroup>
              {item(t("automations.builder.menu.addAfter"), "A", () => {
                close();
                const { lane, index } = placeOf(path);
                b.requestAdd(
                  lane,
                  index + 1,
                  document.querySelector(`[data-tree-row="${step.id}"]`),
                );
              })}
              {item(t("automations.builder.menu.duplicate"), `${mod}D`, () => {
                close();
                b.duplicate(step.id);
              })}
              {item(t("automations.builder.menu.moveTo"), "", () => {
                close();
                b.requestMoveTo(step.id);
              })}
              {item(t("automations.builder.menu.moveUp"), `${opt}↑`, () => {
                close();
                b.move(step.id, -1);
              })}
              {item(t("automations.builder.menu.moveDown"), `${opt}↓`, () => {
                close();
                b.move(step.id, 1);
              })}
            </MenuGroup>
            <MenuGroup>
              {item(
                t("automations.builder.menu.delete"),
                "⌫",
                () => {
                  close();
                  b.requestDelete(step.id);
                },
                true,
              )}
            </MenuGroup>
          </>
        )}
      </MenuButton>
    </span>
  );
}

function GripIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {[4, 8, 12].flatMap((y) =>
        [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.1} />),
      )}
    </svg>
  );
}
