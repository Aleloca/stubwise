import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { childLists, triggerFields } from "../../domain/automations/fields";
import type {
  Approval,
  AutomationFlow,
  AutomationSourceView,
  DataField,
  Step,
} from "../../data/types";
import { quietButton } from "../tasks/controls";
import { conditionWords, stepSentence, templateParts, triggerWords, type Names } from "./format";
import { ApprovalGlyph, Disclosure, StepGlyph } from "./glyphs";
import { TemplateText } from "./shared";

// «How it works» (shape automations.md §6, [A 1], [A 9], [A 10]): il flusso
// in sola lettura come testo indentato — l'inizio coi dati che porta, poi i
// passi numerati con glifo e frase, i rami rientrati con la loro etichetta.
// Oltre il secondo livello i rami partono chiusi («Show N steps inside»).

/** Quanti livelli di rami restano aperti senza «Expand all». */
const OPEN_DEPTH = 2;

function countSteps(steps: Step[]): number {
  return steps.reduce(
    (n, s) => n + 1 + childLists(s).reduce((m, c) => m + countSteps(c.steps), 0),
    0,
  );
}

export function approvalWords(
  approval: Approval,
  names: Names,
  t: (k: string, o?: Record<string, unknown>) => string,
  ownerId: string | null,
): string | null {
  if (approval.mode !== "ask") return null;
  const who = approval.who;
  if ("owner" in who) return t("automations.approval.owner", { name: names.person(ownerId) });
  if ("personId" in who) return names.person(who.personId);
  return t("automations.approval.role", {
    role: t(`automations.roles.${who.projectRole}`, { defaultValue: who.projectRole }),
  });
}

interface Ctx {
  flow: AutomationFlow;
  names: Names;
  labels: Map<string, DataField>;
  automationCode: (id: string) => string | null;
  ownerId: string | null;
  expandAll: boolean;
}

/** Le etichette dei rami di un passo, nell'ordine in cui si leggono. */
function branchLabel(
  step: Step,
  seg: string,
  ctx: Ctx,
  t: (k: string, o?: Record<string, unknown>) => string,
) {
  switch (step.kind) {
    case "condition":
      return seg === "then"
        ? t("automations.branch.if", { when: conditionWords(step.when, ctx.labels, t as never) })
        : t("automations.branch.otherwise");
    case "claude":
      return t("automations.branch.claude", { outcome: seg });
    case "forEach":
      return t("automations.branch.eachRound");
    case "repeatUntil":
      return seg === "onLimit" ? t("automations.branch.onLimit") : t("automations.branch.eachTime");
    default:
      return seg;
  }
}

function Branch({
  step,
  seg,
  steps,
  depth,
  number,
  start,
  ctx,
}: {
  step: Step;
  seg: string;
  steps: Step[];
  depth: number;
  number: string;
  /** Il primo numero dei passi del ramo: i rami di un passo continuano la numerazione (3.1, 3.2 | 3.3). */
  start: number;
  ctx: Ctx;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(depth <= OPEN_DEPTH);
  const shown = open || ctx.expandAll;
  if (steps.length === 0 && step.kind !== "condition") return null;
  return (
    <li className="ml-2 border-l border-rule pl-5">
      <p className="pt-1 pb-0.5 text-xs font-semibold text-ink-muted">
        {branchLabel(step, seg, ctx, t)}
      </p>
      {steps.length === 0 ? (
        <p className="pb-1 text-sm text-ink-faint">{t("automations.branch.nothing")}</p>
      ) : shown ? (
        <StepList steps={steps} depth={depth} prefix={number} start={start} ctx={ctx} />
      ) : (
        <button
          type="button"
          aria-expanded={false}
          className={`${quietButton} h-7 px-1.5`}
          onClick={() => setOpen(true)}
        >
          <Disclosure open={false} />
          {t("automations.branch.showInside", { count: countSteps(steps) })}
        </button>
      )}
    </li>
  );
}

function StepLine({
  step,
  number,
  depth,
  ctx,
}: {
  step: Step;
  number: string;
  depth: number;
  ctx: Ctx;
}) {
  const { t } = useTranslation();
  const sentence = stepSentence(step, ctx.flow, ctx.names, ctx.labels, t, ctx.automationCode);
  const approval =
    "approval" in step ? approvalWords(step.approval, ctx.names, t, ctx.ownerId) : null;
  const children = childLists(step);
  return (
    <li data-flow-step={step.id}>
      <div className="flex min-h-8 items-start gap-2.5 py-1">
        <span className="num w-8 shrink-0 pt-px text-right text-xs text-ink-faint">{number}</span>
        <span className="pt-0.5">
          <StepGlyph kind={step.kind} />
        </span>
        <p className="min-w-0 flex-1 text-md text-ink [overflow-wrap:anywhere]">
          <TemplateText parts={templateParts(sentence.text, ctx.labels)} />
          {sentence.details.length > 0 && (
            <span className="text-ink-muted"> · {sentence.details.join(" · ")}</span>
          )}
        </p>
        {approval && (
          <span
            data-needs-approval
            className="flex shrink-0 items-center gap-1.5 pt-0.5 text-sm text-ink-muted"
          >
            <ApprovalGlyph />
            {t("automations.approval.needs", { who: approval })}
          </span>
        )}
      </div>
      {children.length > 0 && (
        <ul className="pl-10">
          {children.map((c, k) => (
            <Branch
              key={c.seg}
              step={step}
              seg={c.seg}
              steps={c.steps}
              depth={depth + 1}
              number={number}
              start={children.slice(0, k).reduce((n, x) => n + x.steps.length, 0)}
              ctx={ctx}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function StepList({
  steps,
  depth,
  prefix,
  start = 0,
  ctx,
}: {
  steps: Step[];
  depth: number;
  prefix: string;
  start?: number;
  ctx: Ctx;
}) {
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => (
        <StepLine
          key={s.id || i}
          step={s}
          number={prefix ? `${prefix}.${start + i + 1}` : String(start + i + 1)}
          depth={depth}
          ctx={ctx}
        />
      ))}
    </ol>
  );
}

/** I dati dell'inizio in parole: «Brings: Cliente, Contratto (file), Prodotti (list)». */
function brings(fields: DataField[], t: (k: string, o?: Record<string, unknown>) => string) {
  return fields
    .map((f) =>
      f.type === "file" || f.type === "list"
        ? `${f.label} (${t(`automations.fieldType.${f.type}`)})`
        : f.label,
    )
    .join(", ");
}

export function FlowSummary({
  flow,
  names,
  labels,
  sources,
  projectId,
  ownerId,
  automationCode,
  title,
  header,
}: {
  flow: AutomationFlow;
  names: Names;
  labels: Map<string, DataField>;
  sources: AutomationSourceView[];
  projectId: string | null;
  ownerId: string | null;
  automationCode: (id: string) => string | null;
  /** Il titolo della sezione: «Expand all» gli sta accanto. */
  title?: ReactNode;
  header?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [expandAll, setExpandAll] = useState(false);
  const ctx: Ctx = { flow, names, labels, automationCode, ownerId, expandAll };
  const fields = triggerFields(flow, sources);
  return (
    <div data-flow-summary className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {title}
        <button
          type="button"
          className={`${quietButton} ml-auto h-7`}
          aria-pressed={expandAll}
          onClick={() => setExpandAll((v) => !v)}
        >
          {expandAll ? t("automations.flow.collapseAll") : t("automations.flow.expandAll")}
        </button>
      </div>
      {header}
      <div className="flex items-start gap-2.5 py-1">
        <span className="w-8 shrink-0" />
        <span className="pt-0.5">
          <StepGlyph kind="trigger" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-md font-medium text-ink">
            {triggerWords(flow.trigger, names, t, i18n.language, projectId)}
          </p>
          {fields.length > 0 && (
            <p className="text-xs text-ink-muted">
              {t("automations.flow.brings", { fields: brings(fields, t) })}
            </p>
          )}
        </div>
      </div>
      {flow.steps.length === 0 ? (
        <p className="pl-[62px] text-sm text-ink-muted">{t("automations.flow.noSteps")}</p>
      ) : (
        <StepList key={String(expandAll)} steps={flow.steps} depth={0} prefix="" ctx={ctx} />
      )}
    </div>
  );
}
