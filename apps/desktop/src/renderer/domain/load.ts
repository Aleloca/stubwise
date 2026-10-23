import type { StatusFamily, Task, TaskSize } from "../data/model";

/** Il peso delle taglie; nella UI non compare mai come numero. */
export const SIZE_WEIGHT: Record<TaskSize, number> = { XS: 1, S: 2, M: 3, L: 5, XL: 8 };

/** Carico di un insieme di task: le senza stima non pesano, si contano a parte. */
export function load(tasks: Task[]): { weight: number; count: number; unsized: number } {
  let weight = 0;
  let unsized = 0;
  for (const t of tasks) {
    if (t.size) weight += SIZE_WEIGHT[t.size];
    else unsized += 1;
  }
  return { weight, count: tasks.length, unsized };
}

/** Avanzamento a peso: chiuso su totale, le senza stima fuori dai pesi. */
export function progress(
  tasks: Task[],
  familyOf: (task: Task) => StatusFamily,
): { doneWeight: number; totalWeight: number; unsized: number } {
  let doneWeight = 0;
  let totalWeight = 0;
  let unsized = 0;
  for (const t of tasks) {
    if (!t.size) {
      unsized += 1;
      continue;
    }
    const w = SIZE_WEIGHT[t.size];
    totalWeight += w;
    if (familyOf(t) === "closed") doneWeight += w;
  }
  return { doneWeight, totalWeight, unsized };
}
