import type { Department } from "../types";

// Le tinte dei reparti, senza stato: `departments.ts` le ri-esporta.

/** Le otto tinte dei reparti (`DESIGN.md`). */
export const DEPARTMENT_COLORS: readonly Department["colorToken"][] = [
  "--dept-1",
  "--dept-2",
  "--dept-3",
  "--dept-4",
  "--dept-5",
  "--dept-6",
  "--dept-7",
  "--dept-8",
];
