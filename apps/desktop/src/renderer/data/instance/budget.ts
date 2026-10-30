import { recordChange } from "../changelog/index";
import { gate, state } from "../store";
import { forbidden, writer } from "../writer";
import { budgetReached, spentThisMonthUsd } from "./blocks";
import { canI, refuse } from "./common";
import type { InstanceResult } from "./types";

// Il budget mensile dell'AI e la lingua dei contenuti (area 9b, Task 3). Si
// scrivono con `settings.manage`, con una voce per il budget e una per la
// lingua (anche nello stesso salvataggio); si leggono anche con
// `ai_providers.manage`. Lo speso è di tutta l'istanza, in tutti i progetti.
// `budgetReached` sta nella foglia dei blocchi (`blocks.ts`): lo leggono le
// partenze dei lavori (Task 5, 6).

export { budgetReached } from "./blocks";

export type ContentLanguage = "en" | "it";

export interface BudgetView {
  monthlyUsd: number | null;
  spentUsd: number;
  reached: boolean;
  contentLanguage: ContentLanguage;
}

const LANGUAGE_NAMES: Record<ContentLanguage, string> = { en: "English", it: "Italiano" };

const canRead = (me: string) => canI(me, "settings.manage") || canI(me, "ai_providers.manage");
const amount = (n: number | null): string =>
  n === null ? "No budget" : `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** Il budget, lo speso del mese, se è raggiunto e la lingua dei contenuti. */
export async function getBudget(): Promise<BudgetView> {
  const me = await gate("instance.getBudget");
  if (!canRead(me)) throw forbidden();
  const { monthlyUsd, contentLanguage } = state.instance.budget;
  return { monthlyUsd, spentUsd: spentThisMonthUsd(), reached: budgetReached(), contentLanguage };
}

/** Salva budget (`null` = nessun budget) e lingua dei contenuti. */
export async function saveBudget(input: {
  monthlyUsd: number | null;
  contentLanguage: ContentLanguage;
}): Promise<InstanceResult> {
  const me = await writer("instance.saveBudget");
  if (!canI(me, "settings.manage")) return refuse.forbidden();
  const { monthlyUsd, contentLanguage } = input;
  if (monthlyUsd !== null && !(Number.isFinite(monthlyUsd) && monthlyUsd >= 0))
    return refuse.invalid("amount");
  if (!(contentLanguage in LANGUAGE_NAMES)) return refuse.invalid("language");

  const saved = state.instance.budget;
  const object = { type: "ai_settings", id: "budget", label: "Budget & language" };
  if (saved.monthlyUsd !== monthlyUsd) {
    recordChange({
      kind: "budget.changed",
      actorId: me,
      projectId: null,
      object,
      before: amount(saved.monthlyUsd),
      after: amount(monthlyUsd),
    });
  }
  if (saved.contentLanguage !== contentLanguage) {
    recordChange({
      kind: "content_language.changed",
      actorId: me,
      projectId: null,
      object,
      before: LANGUAGE_NAMES[saved.contentLanguage],
      after: LANGUAGE_NAMES[contentLanguage],
    });
  }
  state.instance.budget = { monthlyUsd, contentLanguage };
  return { ok: true };
}

/** SOLO PROTOTIPO (riquadro «Prototype only»): il budget raggiunto, per vedere cosa succede. Nessuna voce. */
export async function simulateBudgetReached(on: boolean): Promise<InstanceResult> {
  const me = await writer("instance.simulateBudgetReached");
  if (!canI(me, "settings.manage")) return refuse.forbidden();
  state.instance.simulate.budgetReached = on;
  return { ok: true };
}
