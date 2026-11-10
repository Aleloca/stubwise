import type { TFunction } from "i18next";
import type { Task } from "../data/types";

// Assegnato a Claude, ma il lavoro non è partito (build app, review dell'area
// 3, punto 5): la scrittura risponde `claudeRun: "refused:<codice>"`.
// L'assegnazione è scritta; qui la frase del codice. Un codice che il client
// non conosce (un server più nuovo) ha la frase generica.

const KNOWN = new Set(["job_in_flight"]);

/** Il codice del rifiuto, o null se il lavoro è partito (o la task non è stata assegnata a Claude). */
export function claudeRunRefusal(task: Pick<Task, "claudeRun">): string | null {
  const run = task.claudeRun;
  return run?.startsWith("refused:") ? run.slice("refused:".length) : null;
}

/** La frase per una task, o null. */
export function claudeRunText(t: TFunction, task: Pick<Task, "claudeRun" | "code">): string | null {
  const code = claudeRunRefusal(task);
  if (code === null) return null;
  return t(`tasks.claudeRun.${KNOWN.has(code) ? code : "other"}`, { code: task.code });
}

/** La frase per un blocco: quante task assegnate a Claude non sono partite, o null. */
export function claudeRunBulkText(t: TFunction, tasks: readonly Pick<Task, "claudeRun">[]): string | null {
  const count = tasks.filter((task) => claudeRunRefusal(task) !== null).length;
  return count > 0 ? t("tasks.claudeRun.bulk", { count }) : null;
}
