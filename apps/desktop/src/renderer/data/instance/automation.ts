import { recordChange } from "../changelog/index";
import { encodeAutomation, type PrReviewValue } from "../changelog/settingValues";
import type { TaskType } from "../model";
import { gate, state } from "../store";
import { forbidden, writer } from "../writer";
import { canI, refuse } from "./common";
import type { AutomationRule, InstanceState } from "./state";
import type { InstanceResult } from "./types";

// L'automazione dell'AI (area 9b, Task 3): per tipo di task, se Claude parte
// da solo e fin dove (effort, approvazione del piano, costo massimo); più la
// revisione delle PR. Nel prototipo si salvano e basta (Global Constraints:
// nessun effetto simulato). Si scrive con `settings.manage`, una voce sola per
// salvataggio con prima e dopo delle sole righe cambiate; si legge anche con
// `ai_providers.manage`.

export type AutomationSettings = InstanceState["automation"];

const TASK_TYPES: readonly TaskType[] = ["bug", "feature", "activity"];
const canRead = (me: string) => canI(me, "settings.manage") || canI(me, "ai_providers.manage");

const copy = (a: AutomationSettings): AutomationSettings => ({
  rules: a.rules.map((r) => ({ ...r })),
  prReview: { ...a.prReview },
});

const isEffort = (n: unknown): boolean =>
  Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 5;
const isCost = (n: number | null): boolean => n === null || (Number.isFinite(n) && n >= 0);
const sameRule = (a: AutomationRule, b: AutomationRule): boolean =>
  a.autoFix === b.autoFix &&
  a.maxEffort === b.maxEffort &&
  a.planApprovalMinEffort === b.planApprovalMinEffort &&
  a.maxCostUsd === b.maxCostUsd;

/** Le regole e la revisione delle PR. */
export async function getAutomation(): Promise<AutomationSettings> {
  const me = await gate("instance.getAutomation");
  if (!canRead(me)) throw forbidden();
  return copy(state.instance.automation);
}

/** Salva regole e revisione delle PR insieme. */
export async function saveAutomation(input: AutomationSettings): Promise<InstanceResult> {
  const me = await writer("instance.saveAutomation");
  if (!canI(me, "settings.manage")) return refuse.forbidden();
  const types = input.rules.map((r) => r.taskType);
  if (types.length !== TASK_TYPES.length || !TASK_TYPES.every((t) => types.includes(t)))
    return refuse.invalid("task_type");
  if (
    input.rules.some(
      (r) =>
        !isEffort(r.maxEffort) ||
        (r.planApprovalMinEffort !== null && !isEffort(r.planApprovalMinEffort)),
    )
  )
    return refuse.invalid("effort");
  if (input.rules.some((r) => !isCost(r.maxCostUsd)) || !isCost(input.prReview.maxCostUsd))
    return refuse.invalid("cost");

  const saved = state.instance.automation;
  const next = copy({
    // L'ordine delle righe resta quello di `TASK_TYPES`.
    rules: TASK_TYPES.map((t) => input.rules.find((r) => r.taskType === t)!),
    prReview: input.prReview,
  });
  // Il prima/dopo: le sole righe cambiate, in valori stabili (Ruling T3).
  const before: AutomationRule[] = [];
  const after: AutomationRule[] = [];
  for (const rule of next.rules) {
    const old = saved.rules.find((r) => r.taskType === rule.taskType);
    if (old && sameRule(old, rule)) continue;
    if (old) before.push(old);
    after.push(rule);
  }
  const review = saved.prReview;
  const reviewChanged =
    review.enabled !== next.prReview.enabled || review.maxCostUsd !== next.prReview.maxCostUsd;
  if (after.length === 0 && !reviewChanged) return { ok: true };
  const reviewOf = (p: PrReviewValue): PrReviewValue | null => (reviewChanged ? { ...p } : null);

  state.instance.automation = next;
  recordChange({
    kind: "automation.changed",
    actorId: me,
    projectId: null,
    object: { type: "ai_settings", id: "automation", label: "automation" },
    before: encodeAutomation(before, reviewOf(review)),
    after: encodeAutomation(after, reviewOf(next.prReview)),
  });
  return { ok: true };
}
