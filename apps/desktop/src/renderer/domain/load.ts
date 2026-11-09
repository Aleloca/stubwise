import type { StatusFamily, Task, TaskSize } from "../data/model";
import { addWeeks } from "./weeks";

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

/** Quante settimane passate fanno «la settimana solita». */
export const USUAL_WEEKS = 6;

/**
 * La settimana solita di una persona: la mediana del peso pianificato
 * (aperte e chiuse) nelle `USUAL_WEEKS` settimane prima di `week`, esclusa
 * `week`, contando solo le settimane con lavoro stimato. Con meno di due
 * settimane così non c'è una storia da cui dire «solita»: `null`, e la UI non
 * disegna la barra. `tasks` sono le task della persona.
 */
export function usualWeekWeight(tasks: Task[], week: string): number | null {
  const window = new Set(Array.from({ length: USUAL_WEEKS }, (_, i) => addWeeks(week, -(i + 1))));
  const perWeek = new Map<string, number>();
  for (const t of tasks) {
    if (!t.size || !t.plannedWeek || !window.has(t.plannedWeek)) continue;
    perWeek.set(t.plannedWeek, (perWeek.get(t.plannedWeek) ?? 0) + SIZE_WEIGHT[t.size]);
  }
  const weights = [...perWeek.values()].sort((a, b) => a - b);
  if (weights.length < 2) return null;
  const mid = Math.floor(weights.length / 2);
  return weights.length % 2 ? weights[mid]! : (weights[mid - 1]! + weights[mid]!) / 2;
}
