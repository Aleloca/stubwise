import type { Person, Task } from "../data/model";
import { SIZE_WEIGHT } from "./load";
import { compareWeeks } from "./weeks";

// Planning (spec §5): il carico delle persone per settimana e le regole di
// chi può spostare cosa. Puro: la pagina ci passa le task che vede e i
// permessi già risolti per progetto.

/** Il carico di una persona in una settimana: tutte le task aperte, di ogni progetto. */
export interface WeekLoad {
  /** Peso in taglie, tutti i progetti. */
  weight: number;
  /** Di cui in questo progetto (nella vista trasversale: tutto). */
  hereWeight: number;
  count: number;
  /** Senza stima: non pesano, si contano a parte. */
  unsized: number;
  slipped: number;
}

export interface PersonLoad {
  /** Aperte assegnate alla persona, in questo progetto (trasversale: ovunque). */
  openHere: number;
  /** Aperte assegnate alla persona, in tutti i progetti visibili. */
  openEverywhere: number;
  /** Aperte slittate (`slipCount > 0`), in questo progetto. */
  slipped: number;
  byWeek: Record<string, WeekLoad>;
}

const isOpen = (task: Task) => task.closedAt === null;

const emptyWeek = (): WeekLoad => ({ weight: 0, hereWeight: 0, count: 0, unsized: 0, slipped: 0 });

/**
 * Il carico di ogni persona: quante aperte ha qui e ovunque, quante sono
 * slittate e, per ogni settimana chiesta, il peso in taglie (con la parte
 * di questo progetto a sé, per i due tratti della barra). Senza
 * `scope.projectId` (vista trasversale) «qui» vuol dire ovunque.
 */
export function peopleLoad(
  tasks: Task[],
  people: Person[],
  weeks: string[],
  scope: { projectId?: string },
): Map<string, PersonLoad> {
  const out = new Map<string, PersonLoad>();
  for (const person of people) {
    const byWeek: Record<string, WeekLoad> = {};
    for (const week of weeks) byWeek[week] = emptyWeek();
    out.set(person.id, { openHere: 0, openEverywhere: 0, slipped: 0, byWeek });
  }
  for (const task of tasks) {
    if (!isOpen(task) || !task.assigneeId) continue;
    const row = out.get(task.assigneeId);
    if (!row) continue;
    const here = !scope.projectId || task.projectId === scope.projectId;
    row.openEverywhere += 1;
    if (here) {
      row.openHere += 1;
      if (task.slipCount > 0) row.slipped += 1;
    }
    const cell = task.plannedWeek ? row.byWeek[task.plannedWeek] : undefined;
    if (!cell) continue;
    cell.count += 1;
    if (task.slipCount > 0) cell.slipped += 1;
    if (!task.size) {
      cell.unsized += 1;
      continue;
    }
    cell.weight += SIZE_WEIGHT[task.size];
    if (here) cell.hereWeight += SIZE_WEIGHT[task.size];
  }
  return out;
}

/** Il peso della cella più carica della vista: la barra è relativa a quella, non a una capacità. */
export function busiestCell(loads: Map<string, PersonLoad>, weeks: string[]): number {
  let max = 0;
  for (const row of loads.values()) {
    for (const week of weeks) max = Math.max(max, row.byWeek[week]?.weight ?? 0);
  }
  return max;
}

/**
 * «To plan»: le aperte senza settimana o senza persona, e le slittate che
 * stanno ancora nella settimana in cui sono arrivate da sole (la corrente).
 * Una slittata ripianificata più avanti esce dalla vasca; `slipCount` resta,
 * perché racconta la sua storia.
 */
export function isToPlan(task: Task, currentWeek: string): boolean {
  if (!isOpen(task)) return false;
  if (task.plannedWeek === null || task.assigneeId === null) return true;
  return task.slipCount > 0 && compareWeeks(task.plannedWeek, currentWeek) <= 0;
}

/** Ciò che serve per decidere chi guarda cosa può muovere, su una task. */
export interface PlanRights {
  me: string;
  /** `planning.others` nel progetto della task. */
  others: boolean;
  /** `tickets.edit` nel progetto della task (prendere per sé una non assegnata). */
  edit: boolean;
  /** I membri del progetto della task. */
  members: readonly string[];
}

/** Perché uno spostamento non si può fare: `others` = serve `planning.others`; `member` = non è del progetto. */
export type PlanBlock = "others" | "member";

/**
 * Le stesse regole di `planTask` (R-B1): con `planning.others` si pianifica
 * per chiunque sia membro del progetto (o per nessuno); senza, solo il
 * proprio — una task già mia, che resta mia o torna senza settimana, o una
 * non assegnata che prendo per me con `tickets.edit`. `target` è la persona
 * di destinazione (`null` = la vasca, che toglie la settimana e tiene la persona).
 */
export function planBlock(task: Task, target: string | null, rights: PlanRights): PlanBlock | null {
  const assignee = target === null ? task.assigneeId : target;
  if (rights.others) {
    return assignee === null || rights.members.includes(assignee) ? null : "member";
  }
  const mine = task.assigneeId === rights.me && assignee === rights.me;
  const take = task.assigneeId === null && assignee === rights.me && rights.edit;
  return mine || take ? null : "others";
}

/** Vero se chi guarda può spostare la task da qualche parte. */
export function canMove(task: Task, rights: PlanRights): boolean {
  if (!isOpen(task)) return false;
  return rights.others || planBlock(task, rights.me, rights) === null;
}
