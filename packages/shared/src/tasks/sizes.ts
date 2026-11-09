/**
 * Taglie delle task (integrazione area 2): XS–XL al posto dello sforzo 1–5,
 * sulla colonna `tickets.effort` di oggi (nessuna colonna nuova: triage AI e
 * gate dell'auto-fix — `effort <= maxEffort` — restano invariati).
 */
export const TASK_SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];

/** 1→XS … 5→XL; null o fuori scala → null. */
export function sizeFromEffort(effort: number | null): TaskSize | null {
  if (effort === null || !Number.isInteger(effort) || effort < 1 || effort > 5) return null;
  return TASK_SIZES[effort - 1]!;
}

/** XS→1 … XL→5; null → null. */
export function effortFromSize(size: TaskSize | null): number | null {
  if (size === null) return null;
  return TASK_SIZES.indexOf(size) + 1;
}
