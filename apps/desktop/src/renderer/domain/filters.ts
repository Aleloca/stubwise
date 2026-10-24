import { TODAY } from "../data/seed/dates";
import type {
  FilterCriteria,
  PeriodField,
  RelativePeriod,
  StatusFamily,
  Task,
  TaskPriority,
  TaskType,
} from "../data/model";
import { weekDays } from "./weeks";

export interface FilterContext {
  familyOf(task: Task): StatusFamily;
  isStalled(task: Task): boolean;
  projectName(id: string): string;
}

type Period =
  | { kind: "relative"; preset: RelativePeriod }
  | { kind: "absolute"; from: string; to: string };

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (date: string, days: number) =>
  iso(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS));

function mondayOfDate(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return shift(date, -(dow - 1));
}

function monthRange(date: string, offset: number): { from: string; to: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return { from: iso(first), to: iso(last) };
}

/** Intervallo (estremi inclusi, ISO) di un periodo, rispetto a `today`. */
export function periodRange(p: Period, today: string = TODAY): { from: string; to: string } {
  if (p.kind === "absolute") return { from: p.from, to: p.to };
  switch (p.preset) {
    case "last7":
      return { from: shift(today, -6), to: today };
    case "last30":
      return { from: shift(today, -29), to: today };
    case "thisWeek": {
      const monday = mondayOfDate(today);
      return { from: monday, to: shift(monday, 6) };
    }
    case "nextWeek": {
      const monday = shift(mondayOfDate(today), 7);
      return { from: monday, to: shift(monday, 6) };
    }
    case "thisMonth":
      return monthRange(today, 0);
    case "lastMonth":
      return monthRange(today, -1);
  }
}

/** Le date della task per un campo di periodo (una settimana pianificata è un intervallo). */
function fieldRange(task: Task, field: PeriodField): { from: string; to: string } | null {
  switch (field) {
    case "created":
      return { from: task.createdAt.slice(0, 10), to: task.createdAt.slice(0, 10) };
    case "closed":
      return task.closedAt
        ? { from: task.closedAt.slice(0, 10), to: task.closedAt.slice(0, 10) }
        : null;
    case "due":
      return task.dueDate ? { from: task.dueDate, to: task.dueDate } : null;
    case "plannedWeek": {
      if (!task.plannedWeek) return null;
      const monday = weekDays(task.plannedWeek)[0]!;
      return { from: monday, to: shift(monday, 6) };
    }
  }
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
  if (c.period) {
    const want = periodRange(c.period);
    const got = fieldRange(task, c.period.field);
    if (!got || got.to < want.from || got.from > want.to) return false;
  }
  return true;
}

/** Gli stati sono per progetto: filtrarli ha senso solo con un progetto scelto. */
export function canUseStatusIds(c: FilterCriteria): boolean {
  return c.projectIds?.length === 1;
}

const FAMILIES: readonly StatusFamily[] = ["todo", "active", "closed"];
const SIZES_OR_NONE: readonly string[] = ["XS", "S", "M", "L", "XL", "none"];
const TYPES: readonly TaskType[] = ["bug", "feature", "activity"];
const PRIORITIES: readonly TaskPriority[] = ["low", "medium", "high", "urgent"];
const PERIOD_FIELDS: readonly PeriodField[] = ["created", "closed", "plannedWeek", "due"];
const PRESETS: readonly RelativePeriod[] = [
  "last7",
  "last30",
  "thisWeek",
  "nextWeek",
  "thisMonth",
  "lastMonth",
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function strings(x: unknown, allowed?: readonly string[]): string[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out = x.filter(
    (v): v is string => typeof v === "string" && (!allowed || allowed.includes(v)),
  );
  return out.length ? out : undefined;
}

function parsePeriod(x: unknown): FilterCriteria["period"] {
  if (!isRecord(x) || !PERIOD_FIELDS.includes(x.field as PeriodField)) return undefined;
  const field = x.field as PeriodField;
  if (x.kind === "relative" && PRESETS.includes(x.preset as RelativePeriod)) {
    return { field, kind: "relative", preset: x.preset as RelativePeriod };
  }
  if (
    x.kind === "absolute" &&
    typeof x.from === "string" &&
    typeof x.to === "string" &&
    DATE_RE.test(x.from) &&
    DATE_RE.test(x.to)
  ) {
    return { field, kind: "absolute", from: x.from, to: x.to };
  }
  return undefined;
}

/**
 * I criteri letti da fuori (la ricerca `filters=` dell'indirizzo): si tiene
 * ciò che ha la forma giusta e si scarta il resto, chiave per chiave, così un
 * indirizzo scritto a mano o vecchio non rompe la pagina. `null` se non è
 * nemmeno un oggetto.
 */
export function parseCriteria(raw: unknown): FilterCriteria | null {
  if (!isRecord(raw)) return null;
  const out: FilterCriteria = {
    projectIds: strings(raw.projectIds),
    departmentIds: strings(raw.departmentIds),
    assigneeIds: strings(raw.assigneeIds),
    families: strings(raw.families, FAMILIES) as StatusFamily[] | undefined,
    statusIds: strings(raw.statusIds),
    sizes: strings(raw.sizes, SIZES_OR_NONE) as FilterCriteria["sizes"],
    types: strings(raw.types, TYPES) as TaskType[] | undefined,
    priorities: strings(raw.priorities, PRIORITIES) as TaskPriority[] | undefined,
    milestoneIds: strings(raw.milestoneIds),
    stalled: typeof raw.stalled === "boolean" ? raw.stalled : undefined,
    text: typeof raw.text === "string" && raw.text !== "" ? raw.text : undefined,
    period: parsePeriod(raw.period),
  };
  for (const key of Object.keys(out) as (keyof FilterCriteria)[]) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}
