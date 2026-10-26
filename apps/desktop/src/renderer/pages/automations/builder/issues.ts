import type { TFunction } from "i18next";
import { availableFields, childLists, scopeAt, stepAt } from "../../../domain/automations/fields";
import { MAX_NESTING, type FlowIssue } from "../../../domain/automations/validate";
import type {
  AutomationFlow,
  AutomationSource,
  Condition,
  DataField,
  Step,
} from "../../../data/types";
import type { Names } from "../format";
import { pathsById, refsOf } from "./tree";

// I problemi di configurazione in parole (shape builder §5). Quanti sono e
// su quale passo lo dice `validateFlow` (via `checkDraft`, coi dati del
// livello dati: approvatori, avvii a catena); COSA manca si rilegge dal passo
// stesso, così la frase nomina il campo («Incomplete: choose who gets the
// task») e sta sotto il campo giusto nel pannello. I messaggi di
// `validateFlow` (italiano, per i log) non si mostrano mai.

/** Un campo del pannello con un problema: la chiave del campo e la frase. */
export interface FieldProblem {
  field: string;
  text: string;
  /** Un dato non disponibile: la sua chiave (il campo di testo che lo cita lo mostra sotto di sé). */
  ref?: string;
}

/** Le chiavi «Incomplete» di un passo, dai suoi campi: nell'ordine del pannello. */
export function missingOf(step: Step, general: boolean): string[] {
  const out: string[] = [];
  const blank = (s: string) => s.trim() === "";
  const target = "project" in step ? step.project : null;
  const approval = "approval" in step ? step.approval : null;
  switch (step.kind) {
    case "createTask": {
      if (blank(step.title)) out.push("title");
      const a = step.assignee;
      if (a && Object.values(a).some((v) => blank(String(v)))) out.push("assignee");
      break;
    }
    case "createMilestone":
      if (blank(step.name)) out.push("name");
      break;
    case "createRequest":
      if (blank(step.title)) out.push("title");
      break;
    case "sendEmail":
      if (blank(step.to)) out.push("to");
      if (blank(step.subject)) out.push("subject");
      if (blank(step.body)) out.push("body");
      break;
    case "notify":
      if (blank(Object.values(step.who)[0] ?? "")) out.push("who");
      if (blank(step.text)) out.push("message");
      break;
    case "startAutomation":
      if (blank(step.automationId)) out.push("automation");
      break;
    case "wait": {
      const w = step.for;
      if ("days" in w && !(w.days > 0)) out.push("days");
      if (!("days" in w) && !(w.maxDays > 0)) out.push("maxDays");
      if ("replyTo" in w && blank(w.replyTo)) out.push("replyTo");
      if ("taskClosed" in w && blank(w.taskClosed)) out.push("taskClosed");
      break;
    }
    case "claude":
      if (blank(step.instruction)) out.push("instruction");
      if (step.outcomes.length === 0 && step.fields.length === 0) out.push("answer");
      if (step.outcomes.some(blank) || new Set(step.outcomes).size !== step.outcomes.length)
        out.push("outcomes");
      if (step.fields.some((f) => blank(f.label))) out.push("fields");
      break;
    case "condition":
      if (conditionIncomplete(step.when)) out.push("condition");
      break;
    case "forEach":
      if (blank(step.list)) out.push("list");
      if (blank(step.as) || /[./]/.test(step.as)) out.push("as");
      break;
    case "repeatUntil":
      if (conditionIncomplete(step.until)) out.push("until");
      break;
  }
  if (target?.mode === "own" && general) out.push("where");
  if (target?.mode === "fixed" && blank(target.projectId)) out.push("project");
  if (target?.mode === "from_client" && blank(target.clientRef)) out.push("client");
  if (approval?.mode === "ask") {
    const who = approval.who;
    if (
      ("personId" in who && blank(who.personId)) ||
      ("projectRole" in who && blank(who.projectRole))
    )
      out.push("approver");
  }
  return out;
}

function conditionIncomplete(c: Condition): boolean {
  const leaves = c.all ?? c.any ?? [c];
  if (leaves.length === 0) return true;
  return leaves.some((l) => {
    if (l.all || l.any) return conditionIncomplete(l);
    const unary = l.op === "empty" || l.op === "not_empty";
    return !l.left || !l.op || (!unary && !l.right);
  });
}

/** I dati citati dal passo che in quel punto non ci sono (chiavi). */
export function unavailableRefs(
  flow: AutomationFlow,
  path: string,
  step: Step,
  sources: AutomationSource[],
): string[] {
  const here = new Set(availableFields(flow, path, sources).map((f) => f.key));
  return refsOf(step).filter((k) => !here.has(k));
}

/** Il passo che produce un dato (per il tooltip di un gettone non più valido). */
export function producerOf(flow: AutomationFlow, key: string): { id: string; path: string } | null {
  let found: { id: string; path: string } | null = null;
  for (const [id, path] of pathsById(flow.steps)) {
    const s = stepAt(flow.steps, path)!;
    const makes =
      (s.kind === "claude" && s.fields.some((f) => f.key === key || key.startsWith(`${f.key}.`))) ||
      (s.kind === "forEach" && s.as !== "" && (key === s.as || key.startsWith(`${s.as}.`))) ||
      (s.kind === "wait" && "replyTo" in s.for && key.startsWith("risposta."));
    if (makes) found = { id, path };
  }
  return found;
}

/** Chi produce i passi citati per id (traguardo, email, task attese) è ancora prima di questo? */
function stepRefProblem(
  flow: AutomationFlow,
  path: string,
  step: Step,
  t: TFunction,
): string | null {
  const before = new Set(scopeAt(flow, path).preceding.map((s) => s.id));
  if (step.kind === "createTask" && step.milestoneRef && !before.has(step.milestoneRef))
    return t("automations.builder.problem.milestoneLater");
  if (
    step.kind === "wait" &&
    "replyTo" in step.for &&
    step.for.replyTo &&
    !before.has(step.for.replyTo)
  )
    return t("automations.builder.problem.emailLater");
  if (
    step.kind === "wait" &&
    "taskClosed" in step.for &&
    step.for.taskClosed &&
    !before.has(step.for.taskClosed)
  )
    return t("automations.builder.problem.taskLater");
  return null;
}

/** Il passo sta oltre il quinto livello, o al quinto apre altri rami ([A 7]). */
export function tooDeep(step: Step, path: string): boolean {
  const depth = path.split("/").filter((s) => !/^\d+$/.test(s)).length;
  return depth > MAX_NESTING || (depth === MAX_NESTING && childLists(step).length > 0);
}

/** La parola breve sulla riga («Incomplete», «Data not available»…). */
export function shortProblem(
  issues: FlowIssue[],
  step: Step | null,
  names: Names,
  t: TFunction,
): string {
  const first = issues[0]!;
  if (first.code === "limit" && step?.kind === "startAutomation")
    return t("automations.builder.short.selfStart");
  if (first.code === "approver_cant_see" && step && "approval" in step) {
    const code = targetCode(step, names);
    return code
      ? t("automations.builder.short.approverCantSee", { code })
      : t("automations.builder.short.approverCantSeeAny");
  }
  return t(`automations.builder.short.${first.code}`);
}

function targetCode(step: Step, names: Names): string | null {
  if (!("project" in step) || step.project.mode !== "fixed") return null;
  return names.project(step.project.projectId)?.code ?? null;
}

/**
 * Le frasi dei problemi di un passo (pannello e annunci), una per campo,
 * a partire dai codici di `validateFlow` sul passo.
 */
export function stepProblems(
  issues: FlowIssue[],
  flow: AutomationFlow,
  path: string,
  step: Step,
  ctx: {
    general: boolean;
    names: Names;
    ownerId: string | null;
    projectCode: string | null;
    sources: AutomationSource[];
    labels: Map<string, DataField>;
  },
  t: TFunction,
): FieldProblem[] {
  const out: FieldProblem[] = [];
  const codes = new Set(issues.map((i) => i.code));
  if (codes.has("incomplete")) {
    for (const field of missingOf(step, ctx.general))
      out.push({ field, text: t(`automations.builder.missing.${field}`) });
    if (out.length === 0) out.push({ field: "step", text: t("automations.issue.incomplete") });
  }
  if (codes.has("unknown_ref")) {
    const refs = unavailableRefs(flow, path, step, ctx.sources);
    for (const key of refs)
      out.push({
        field: "data",
        ref: key,
        text: t("automations.builder.problem.unavailable", {
          label: ctx.labels.get(key)?.label ?? labelOf(flow, key),
        }),
      });
    const stepRef = stepRefProblem(flow, path, step, t);
    if (stepRef) out.push({ field: "stepRef", text: stepRef });
    if (step.kind === "startAutomation")
      out.push({ field: "automation", text: t("automations.builder.problem.automationGone") });
    if (refs.length === 0 && !stepRef && step.kind !== "startAutomation")
      out.push({ field: "data", text: t("automations.issue.unknown_ref") });
  }
  if (codes.has("type_mismatch")) {
    if (step.kind === "forEach") {
      const f = availableFields(flow, path, ctx.sources).find((x) => x.key === step.list);
      out.push({
        field: "list",
        text: f
          ? t("automations.builder.problem.notAList", {
              label: f.label,
              type: t(`automations.builder.types.${f.type}`),
            })
          : t("automations.issue.type_mismatch"),
      });
    } else out.push({ field: "step", text: t("automations.issue.type_mismatch") });
  }
  if (codes.has("approver_cant_see") && "approval" in step && step.approval.mode === "ask") {
    const who = step.approval.who;
    const name =
      "personId" in who
        ? ctx.names.person(who.personId)
        : "owner" in who
          ? ctx.names.person(ctx.ownerId)
          : t(`automations.roles.${who.projectRole}`, { defaultValue: who.projectRole });
    const code = targetCode(step, ctx.names) ?? ctx.projectCode;
    out.push({
      field: "approver",
      text: code
        ? t("automations.builder.problem.approverCantSee", { name, code })
        : t("automations.builder.problem.approverCantSeeAny", { name }),
    });
  }
  if (codes.has("limit")) {
    const deep = tooDeep(step, path);
    if (deep) out.push({ field: "step", text: t("automations.builder.problem.tooDeep") });
    if (step.kind === "startAutomation")
      out.push({ field: "automation", text: t("automations.builder.problem.selfStart") });
    else if (
      step.kind === "repeatUntil" &&
      !(Number.isInteger(step.max) && step.max >= 1 && step.max <= 10)
    )
      out.push({ field: "max", text: t("automations.builder.problem.repeatMax") });
    else if (!deep) out.push({ field: "step", text: t("automations.issue.limit") });
  }
  return out;
}

/** L'etichetta di un dato da qualunque punto del flusso (anche quelli che qui non ci sono). */
export function labelOf(flow: AutomationFlow, key: string): string {
  for (const path of pathsById(flow.steps).values()) {
    const f = availableFields(flow, path).find((x) => x.key === key);
    if (f) return f.label;
    const s = stepAt(flow.steps, path);
    const own = s?.kind === "claude" ? s.fields.find((x) => x.key === key) : undefined;
    if (own) return own.label;
  }
  return key.split(".").at(-1) ?? key;
}

/** Le frasi dei problemi dell'inizio e del flusso intero. */
export function startProblems(
  issues: FlowIssue[],
  flow: AutomationFlow,
  names: Names,
  t: TFunction,
): string[] {
  return issues.map((i) => {
    const tr = flow.trigger;
    if (i.path === "") return t("automations.builder.problem.noSteps");
    if (i.code === "source_disconnected" && tr.kind === "source")
      return t("automations.builder.problem.sourceDisconnected", {
        source: names.source(tr.sourceId)?.name ?? "",
      });
    if (i.code === "unknown_ref" && tr.kind === "source") {
      if (tr.sourceId === "") return t("automations.builder.missing.source");
      if (!names.source(tr.sourceId)) return t("automations.builder.problem.sourceGone");
    }
    if (i.code === "incomplete" && tr.kind === "schedule" && tr.rule.trim() === "")
      return t("automations.builder.missing.schedule");
    if (i.code === "incomplete" && flow.titleTemplate.trim() === "")
      return t("automations.builder.missing.titleTemplate");
    if (i.code === "unknown_ref") return t("automations.builder.problem.titleData");
    return t(`automations.issue.${i.code}`);
  });
}
