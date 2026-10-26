import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useMemo, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  AUTOMATION_LIMITS,
  availableFields,
  childLists,
  joinPath,
  triggerFields,
} from "../../../domain/automations/fields";
import type { Step } from "../../../data/types";
import { stepSentence, triggerWords } from "../format";
import { ApprovalGlyph, CriticalGlyph, Disclosure, StepGlyph } from "../glyphs";
import { useBuilder } from "./context";
import {
  asksWords,
  automationCode,
  countInside,
  laneLabel,
  projectMark,
  Tokens,
} from "./flowWords";
import { shortProblem, startProblems } from "./issues";
import { RowMenu } from "./RowMenu";
import { innerCount, isBlock, placeOf } from "./tree";
import type { Indicator } from "./useTreeDrag";

// Le righe del flusso: l'inizio, i passi coi loro segni, le corsie dei
// blocchi con l'etichetta e «+ Add a step».

export interface RowCtx {
  focusId: string;
  setFocusId(id: string): void;
  picked: string | null;
  indicator: Indicator | null;
  onKey(e: KeyboardEvent<HTMLElement>, id: string): void;
  onBlur(id: string): void;
}

export const rowClass = (selected: boolean, picked: boolean) =>
  `group/row relative flex min-h-12 items-start gap-2 rounded-md py-2 pr-2 pl-1 outline-none transition-colors duration-[var(--duration-fast)] ease-out focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus ${
    picked
      ? "z-10 bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
      : selected
        ? "bg-ink/10"
        : "hover:bg-ink/4"
  }`;

/** L'inizio: «When …», i dati che porta, i suoi problemi. Non si sposta e non si cancella. */
export function StartRow({ ctx }: { ctx: RowCtx }) {
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

export function StepRow({
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

export function Lane({
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

export function AddRow({
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
