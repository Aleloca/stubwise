import type {
  Department,
  GroupBy,
  Milestone,
  Person,
  ProjectStatus,
  StatusFamily,
  Task,
} from "../../data/types";
import { SIZE_WEIGHT } from "../../domain/load";
import { compareWeeks } from "../../domain/weeks";

/** Ciò che serve per dare un nome e un ordine ai gruppi (dati già letti + testi tradotti). */
export interface GroupContext {
  /** Gli stati dei progetti delle task, ciascuno col suo `order`. */
  statuses: ProjectStatus[];
  people: Person[];
  /** I reparti nell'ordine di configurazione. */
  departments: Department[];
  milestones: Milestone[];
  labels: {
    all: string;
    noAssignee: string;
    noMilestone: string;
    noWeek: string;
    /** I gruppi di ciò che il contesto non conosce (uno stato o un reparto appena tolto…). */
    other: string;
    family(family: StatusFamily): string;
    week(week: string): string;
  };
}

export interface TaskGroup {
  key: string;
  label: string;
  tasks: Task[];
}

const FAMILIES: StatusFamily[] = ["todo", "active", "closed"];
/** La chiave dei «senza» (assegnatario, traguardo, settimana): sempre l'ultimo gruppo. */
const NONE = "none";

/** Più di un progetto fra gli stati delle task: gli stati non si confrontano, le famiglie sì. */
function spansProjects(tasks: Task[]): boolean {
  return new Set(tasks.map((t) => t.projectId)).size > 1;
}

function familyOf(task: Task, ctx: GroupContext): StatusFamily | undefined {
  return ctx.statuses.find((s) => s.id === task.statusId)?.family;
}

/**
 * Le task in gruppi, nell'ordine che il raggruppamento promette: stati
 * nell'ordine del progetto (per famiglia se le task sono di più progetti),
 * persone per nome, reparti nell'ordine di configurazione, traguardi per
 * data, settimane in ordine cronologico. I «senza» stanno in fondo. Dentro
 * un gruppo le task restano nell'ordine in cui arrivano (già ordinate da
 * chi chiama). I gruppi vuoti non ci sono, e nessuna task resta fuori: le
 * chiavi che il contesto non conosce vanno nel gruppo «Other», ultimo.
 */
export function groupTasks(tasks: Task[], by: GroupBy, ctx: GroupContext): TaskGroup[] {
  if (by === "none") return tasks.length ? [{ key: "all", label: ctx.labels.all, tasks }] : [];

  const buckets = new Map<string, Task[]>();
  const keyOf = (task: Task): string => {
    switch (by) {
      case "status":
        return spansProjects(tasks) ? (familyOf(task, ctx) ?? NONE) : task.statusId;
      case "assignee":
        return task.assigneeId ?? NONE;
      case "department":
        return task.departmentId;
      case "milestone":
        return task.milestoneId ?? NONE;
      case "week":
        return task.plannedWeek ?? NONE;
    }
  };
  for (const task of tasks) {
    const key = keyOf(task);
    buckets.set(key, [...(buckets.get(key) ?? []), task]);
  }

  // Nessuna task si perde: ciò che il contesto non nomina finisce in fondo, in «Other».
  const ordered = (keys: { key: string; label: string }[]): TaskGroup[] => {
    const known = new Set(keys.map((k) => k.key));
    const groups = keys.flatMap(({ key, label }) => {
      const list = buckets.get(key);
      return list ? [{ key, label, tasks: list }] : [];
    });
    const leftover = [...buckets].filter(([key]) => !known.has(key)).flatMap(([, list]) => list);
    return leftover.length
      ? [...groups, { key: "other", label: ctx.labels.other, tasks: leftover }]
      : groups;
  };

  switch (by) {
    case "status":
      if (spansProjects(tasks)) {
        return ordered(FAMILIES.map((f) => ({ key: f, label: ctx.labels.family(f) })));
      }
      return ordered(
        [...ctx.statuses].sort((a, b) => a.order - b.order).map((s) => ({ key: s.id, label: s.name })),
      );
    case "assignee":
      return ordered([
        ...[...ctx.people]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => ({ key: p.id, label: p.name })),
        { key: NONE, label: ctx.labels.noAssignee },
      ]);
    case "department":
      return ordered(ctx.departments.map((d) => ({ key: d.id, label: d.name })));
    case "milestone":
      return ordered([
        ...[...ctx.milestones]
          .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"))
          .map((m) => ({ key: m.id, label: m.name })),
        { key: NONE, label: ctx.labels.noMilestone },
      ]);
    case "week":
      return ordered([
        ...[...buckets.keys()]
          .filter((k) => k !== NONE)
          .sort(compareWeeks)
          .map((w) => ({ key: w, label: ctx.labels.week(w) })),
        { key: NONE, label: ctx.labels.noWeek },
      ]);
  }
}

export type SortKey = "code" | "title" | "status" | "assignee" | "size" | "due";
export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

const codeNumber = (code: string) => Number(code.slice(code.lastIndexOf("-") + 1));
const codePrefix = (code: string) => code.slice(0, code.lastIndexOf("-"));

/**
 * Le task ordinate per una colonna. I valori mancanti (senza scadenza, senza
 * taglia, senza assegnatario) restano in fondo in entrambi i versi: invertire
 * l'ordine non porta in cima ciò che non ha il dato. A parità, il codice.
 */
export function sortTasks(tasks: Task[], sort: SortState, ctx: GroupContext): Task[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const statusOrder = (t: Task) => {
    const s = ctx.statuses.find((x) => x.id === t.statusId);
    // Fra progetti diversi conta la famiglia, poi l'ordine nel progetto.
    return s ? FAMILIES.indexOf(s.family) * 100 + s.order : null;
  };
  const value = (t: Task): string | number | null => {
    switch (sort.key) {
      case "code":
        return codeNumber(t.code);
      case "title":
        return t.title.toLocaleLowerCase();
      case "status":
        return statusOrder(t);
      case "assignee":
        return t.assigneeId
          ? (ctx.people.find((p) => p.id === t.assigneeId)?.name ?? null)
          : null;
      case "size":
        return t.size ? SIZE_WEIGHT[t.size] : null;
      case "due":
        return t.dueDate;
    }
  };
  return [...tasks].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) {
      const cmp =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb));
      return sign * cmp;
    }
    return codePrefix(a.code).localeCompare(codePrefix(b.code)) || codeNumber(a.code) - codeNumber(b.code);
  });
}
