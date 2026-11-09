import { TODAY } from "@backend/clock";
import {
  canUseStatusIds as sharedCanUseStatusIds,
  parseCriteria as sharedParseCriteria,
  periodRange as sharedPeriodRange,
  taskInPeriod,
  type Period,
} from "@stubwise/shared";
import type { FilterCriteria, StatusFamily, Task } from "../data/model";

// Le regole pure dei criteri (periodi, schema dei criteri, stati per
// progetto) stanno in `@stubwise/shared` (integrazione area 2, fetta 3): una
// regola, un posto, la usa anche il server. Qui resta `matches`, del finto, e
// gli adattatori che leggono «oggi».

export interface FilterContext {
  familyOf(task: Task): StatusFamily;
  isStalled(task: Task): boolean;
  projectName(id: string): string;
}

/** Intervallo (estremi inclusi, ISO) di un periodo, rispetto a `today`. */
export function periodRange(p: Period, today: string = TODAY): { from: string; to: string } {
  return sharedPeriodRange(p, today);
}

/** AND fra i criteri presenti, OR dentro ogni elenco; un elenco vuoto non filtra. */
export function matches(task: Task, c: FilterCriteria, ctx: FilterContext): boolean {
  if (c.projectIds?.length && !c.projectIds.includes(task.projectId)) return false;
  if (c.departmentIds?.length && !c.departmentIds.includes(task.departmentId)) return false;
  if (c.assigneeIds?.length && !c.assigneeIds.includes(task.assigneeId ?? "none")) return false;
  if (c.families?.length && !c.families.includes(ctx.familyOf(task))) return false;
  if (c.statusIds?.length && !c.statusIds.includes(task.statusId)) return false;
  if (c.sizes?.length && !c.sizes.includes(task.size ?? "none")) return false;
  if (c.types?.length && !c.types.includes(task.type)) return false;
  if (c.priorities?.length && !c.priorities.includes(task.priority)) return false;
  if (c.milestoneIds?.length && (!task.milestoneId || !c.milestoneIds.includes(task.milestoneId))) {
    return false;
  }
  if (c.stalled !== undefined && ctx.isStalled(task) !== c.stalled) return false;
  const text = c.text?.trim().toLowerCase();
  if (text && !task.code.toLowerCase().includes(text) && !task.title.toLowerCase().includes(text)) {
    return false;
  }
  if (c.period && !taskInPeriod(task, c.period, TODAY)) return false;
  return true;
}

/** Gli stati sono per progetto: filtrarli ha senso solo con un progetto scelto. */
export function canUseStatusIds(c: FilterCriteria): boolean {
  return sharedCanUseStatusIds(c);
}

/**
 * I criteri letti da fuori (la ricerca `filters=` dell'indirizzo): si tiene
 * ciò che ha la forma giusta e si scarta il resto, chiave per chiave, così un
 * indirizzo scritto a mano o vecchio non rompe la pagina. `null` se non è
 * nemmeno un oggetto. La regola è `parseCriteria` di `@stubwise/shared`.
 */
export function parseCriteria(raw: unknown): FilterCriteria | null {
  return sharedParseCriteria(raw) as FilterCriteria | null;
}
