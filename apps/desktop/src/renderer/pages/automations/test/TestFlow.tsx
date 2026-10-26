import { useRef, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { childLists, joinPath } from "../../../domain/automations/fields";
import type { Step } from "../../../data/types";
import { useAutomations } from "../../../data/queries";
import { stepSentence, templateParts, triggerWords } from "../format";
import { ApprovalGlyph, CriticalGlyph, StepGlyph } from "../glyphs";
import { TemplateText } from "../shared";
import { asksWords, laneLabel, projectMark } from "../builder/flowWords";
import { flowPathOf, useTest } from "./context";
import { laneTaken, markAt, roundSeg, roundTotal, type Mark } from "./marks";
import { RoundPicker } from "./Rounds";
import { rowOutcome } from "./words";

// Il flusso nella prova (shape automation-test §3, [A 2]): lo stesso elenco
// numerato del costruttore, in sola lettura (niente «+», niente maniglie),
// che si accende passo dopo passo. Ogni riga ha il suo segno di percorso —
// glifo + parola nel nome accessibile, mai solo colore ([A 7]) — e i rami
// non presi sono interi in `ink-faint`. Nei cicli la corsia ha in testa il
// selettore del giro, e i passi dentro mostrano i segni del giro scelto.

/** Il segno di una riga: punto pieno (corrente), spunta (fatto), anello a metà (fermo)… */
export function MarkGlyph({ mark }: { mark: Mark }) {
  const box = "grid size-4 shrink-0 place-items-center";
  switch (mark) {
    case "current":
      return (
        <span aria-hidden="true" className={box}>
          <span className="size-2.5 rounded-full bg-ink" />
        </span>
      );
    case "done":
      return (
        <svg
          viewBox="0 0 16 16"
          width={16}
          height={16}
          aria-hidden="true"
          className="shrink-0 text-ink"
        >
          <path
            d="m3.5 8.25 3 3 6-6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "stopped":
      return (
        <svg
          viewBox="0 0 16 16"
          width={16}
          height={16}
          aria-hidden="true"
          className="shrink-0 text-ink"
        >
          <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth={1.5} />
          <path d="M8 3a5 5 0 0 1 0 10z" fill="currentColor" />
        </svg>
      );
    case "inside":
      return (
        <svg
          viewBox="0 0 16 16"
          width={16}
          height={16}
          aria-hidden="true"
          className="shrink-0 text-ink-muted"
        >
          <circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth={1.4} />
        </svg>
      );
    case "failed":
    case "rejected":
      return <CriticalGlyph />;
    case "skipped":
      return (
        <svg
          viewBox="0 0 16 16"
          width={16}
          height={16}
          aria-hidden="true"
          className="shrink-0 text-ink-muted"
        >
          <path d="M4.5 8h7" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
        </svg>
      );
    default:
      return <span aria-hidden="true" className={box} />;
  }
}

const rowBase =
  "relative flex min-h-11 w-full cursor-default items-start gap-2 rounded-md py-2 pr-2 pl-1 text-left outline-none transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";

function rowTone(mark: Mark, selected: boolean) {
  if (selected) return "bg-ink/10";
  if (mark === "current") return "bg-ink/10";
  return "hover:bg-ink/4";
}

export function TestFlow({ treeRef }: { treeRef: RefObject<HTMLUListElement | null> }) {
  const { t } = useTranslation();
  const ctx = useTest();
  const focusRef = useRef<string | null>(null);
  // Le frecce spostano il fuoco fra le righe e mostrano la loro anteprima;
  // Invio resta «Next step» (lo gestisce la pagina).
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const rows = [...(treeRef.current?.querySelectorAll<HTMLElement>("[data-test-row]") ?? [])];
    const at = rows.findIndex((r) => r === document.activeElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
    const el = rows[next];
    if (!el) return;
    e.preventDefault();
    el.focus();
    const path = el.dataset.testRow!;
    focusRef.current = path;
    ctx.select(path === "end" ? null : path);
  };
  const ended = ctx.sim?.status === "done";
  return (
    <ul
      ref={treeRef}
      aria-label={t("automations.builder.flowLabel")}
      onKeyDown={onKey}
      data-test-flow
      className="flex flex-col"
    >
      <StartRow />
      {ctx.flow.steps.map((s, i) => (
        <StepRow key={s.id} step={s} path={String(i)} depth={0} lane={null} />
      ))}
      <li>
        <div
          data-test-row="end"
          tabIndex={-1}
          aria-label={`${t("automations.test.row.end")}, ${t(`automations.test.mark.${ended ? "done" : "pending"}`)}`}
          className={`${rowBase} hover:bg-transparent`}
        >
          <span className="w-7 shrink-0" />
          <MarkGlyph mark={ended ? "done" : "pending"} />
          <span className={`text-md ${ended ? "text-ink" : "text-ink-faint"}`}>
            {t("automations.test.row.end")}
          </span>
        </div>
      </li>
    </ul>
  );
}

function StartRow() {
  const { t, i18n } = useTranslation();
  const ctx = useTest();
  const mark: Mark = ctx.ix ? markAt(ctx.ix, "trigger") : "pending";
  const selected = ctx.selected === "trigger";
  return (
    <li>
      <div
        role="button"
        data-test-row="trigger"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        aria-label={`${t("automations.test.row.start_row")}, ${t(`automations.test.mark.${mark}`)}`}
        onClick={() => ctx.select("trigger")}
        onKeyDown={(e) => {
          if (e.key === " ") {
            e.preventDefault();
            ctx.select("trigger");
          }
        }}
        className={`${rowBase} ${rowTone(mark, selected)} mb-1`}
      >
        <span className="w-7 shrink-0" />
        <span className="pt-0.5">
          <MarkGlyph mark={mark} />
        </span>
        <span className="pt-0.5">
          <StepGlyph kind="trigger" />
        </span>
        <span className="min-w-0 flex-1 text-md text-ink">
          {triggerWords(ctx.flow.trigger, ctx.names, t, i18n.language, ctx.automation.projectId)}
        </span>
      </div>
    </li>
  );
}

function StepRow({
  step,
  path,
  depth,
  lane,
}: {
  step: Step;
  /** Il percorso concreto (giro compreso). */
  path: string;
  depth: number;
  /** La corsia è stata presa? `false` = ramo non preso; null = non si sa (o la radice). */
  lane: boolean | null;
}) {
  const { t } = useTranslation();
  const ctx = useTest();
  const others = useAutomations().data ?? [];
  const flowPath = flowPathOf(path);
  const n = ctx.numbers.get(flowPath) ?? 0;
  const notTaken = lane === false;
  const mark: Mark = notTaken ? "notTaken" : ctx.ix ? markAt(ctx.ix, path) : "pending";
  const current = ctx.stream?.path ?? ctx.sim?.current?.path ?? ctx.sim?.cursor ?? null;
  const selected = ctx.selected === null ? current === path : ctx.selected === path;
  const sentence = stepSentence(
    step,
    ctx.flow,
    ctx.names,
    ctx.labels,
    t,
    (id) => others.find((a) => a.id === id)?.code ?? null,
  );
  const asks = "approval" in step ? asksWords(step.approval, ctx, t) : null;
  const project = projectMark(step, ctx, t);
  const outcome = notTaken ? null : rowOutcome(ctx, step, path, mark, t);
  const faint = notTaken || mark === "pending";
  const kind = t(`automations.builder.kind.${step.kind}`);
  const claudeWorking = step.kind === "claude" && mark === "current";
  return (
    <li data-step-path={path} data-mark={mark}>
      <div
        role="button"
        data-test-row={path}
        tabIndex={-1}
        aria-current={selected ? "step" : undefined}
        aria-label={`${t("automations.builder.stepN", { n })}, ${kind}, ${t(`automations.test.mark.${mark}`)}`}
        aria-describedby={`test-row-${path}`}
        onClick={() => ctx.select(path)}
        onKeyDown={(e) => {
          if (e.key === " ") {
            e.preventDefault();
            ctx.select(path);
          }
        }}
        className={`${rowBase} ${rowTone(mark, selected)}`}
      >
        <span
          className={`num w-7 shrink-0 pt-0.5 text-right text-sm ${faint ? "text-ink-faint" : "text-ink-muted"}`}
        >
          {n}
        </span>
        <span className="pt-0.5">
          <MarkGlyph mark={mark} />
        </span>
        <span className={`relative pt-0.5 ${faint ? "opacity-60" : ""}`}>
          <StepGlyph kind={step.kind} />
          {claudeWorking && (
            <span
              aria-hidden="true"
              className="rail-pulse absolute -inset-1 top-0 rounded-full border-2 border-dashed border-ink"
            />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
          <span
            id={`test-row-${path}`}
            className={`line-clamp-2 min-w-[min(320px,100%)] flex-1 text-md ${faint ? "text-ink-faint" : "text-ink"}`}
          >
            {sentence.text ? (
              <TemplateText parts={templateParts(sentence.text, ctx.labels)} />
            ) : (
              kind
            )}
            {sentence.details.length > 0 && (
              <span className={faint ? "" : "text-ink-muted"}>
                {" · "}
                <TemplateText parts={templateParts(sentence.details.join(" · "), ctx.labels)} />
              </span>
            )}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            {asks && (
              <span className="inline-flex items-center gap-1">
                <ApprovalGlyph />
                {asks}
              </span>
            )}
            {project && <span title={project.title}>{project.text}</span>}
            {outcome && (
              <span
                data-row-outcome
                className={
                  mark === "failed" || mark === "rejected"
                    ? "font-medium text-critical"
                    : "text-ink-muted"
                }
              >
                {outcome}
              </span>
            )}
          </span>
        </span>
      </div>
      {childLists(step).length > 0 && (
        <ul className="flex flex-col">
          {childLists(step).map((c) => (
            <Lane
              key={c.seg}
              block={step}
              blockPath={path}
              seg={c.seg}
              steps={c.steps}
              depth={depth + 1}
              parentNotTaken={notTaken}
              number={n}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function Lane({
  block,
  blockPath,
  seg,
  steps,
  depth,
  parentNotTaken,
  number,
}: {
  block: Step;
  blockPath: string;
  seg: string;
  steps: Step[];
  depth: number;
  parentNotTaken: boolean;
  number: number;
}) {
  const { t } = useTranslation();
  const ctx = useTest();
  const loop = seg === "forEach[0]" ? "forEach" : seg === "repeat[0]" ? "repeat" : null;
  const round = loop ? ctx.roundOf(blockPath) : 0;
  const concrete = joinPath(blockPath, roundSeg(seg, round));
  const taken = parentNotTaken ? false : ctx.ix ? laneTaken(ctx.ix, block, blockPath, seg) : null;
  const total = loop && ctx.ix ? roundTotal(ctx.ix, block, blockPath) : 0;
  const label = laneLabel(block, seg, ctx, t);
  // «When the limit is reached» non ancora raggiunto mentre il ciclo gira.
  const repeatStarted =
    block.kind === "repeatUntil" && seg === "onLimit" && taken === null && total > 0;
  return (
    <li
      data-lane={concrete}
      data-taken={taken === null ? undefined : String(taken)}
      className="ml-5 flex flex-col border-l border-rule"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-1.5 pb-0.5 pl-3">
        <p
          className={`min-w-0 text-xs font-semibold ${taken === false ? "text-ink-faint" : "text-ink-muted"}`}
        >
          {label}
          {taken === false && (
            <span className="font-normal"> · {t("automations.test.row.notTaken")}</span>
          )}
          {repeatStarted && (
            <span className="font-normal text-ink-faint">
              {" "}
              · {t("automations.test.row.notReached")}
            </span>
          )}
        </p>
        {loop && total > 0 && !parentNotTaken && (
          <RoundPicker
            blockPath={blockPath}
            kind={loop}
            total={total}
            max={block.kind === "repeatUntil" ? block.max : undefined}
            stepNumber={number}
          />
        )}
      </div>
      <ul className="flex flex-col">
        {steps.map((s, i) => (
          <StepRow
            key={s.id}
            step={s}
            path={joinPath(concrete, String(i))}
            depth={depth}
            lane={taken}
          />
        ))}
        {steps.length === 0 && (
          <li className="py-1 pl-10 text-sm text-ink-faint">
            {t("automations.builder.lane.nothing")}
          </li>
        )}
      </ul>
    </li>
  );
}
