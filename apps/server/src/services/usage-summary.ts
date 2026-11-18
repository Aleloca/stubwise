import { agentRuns, aiProviders, projects, type Db } from "@stubwise/db";
import { USAGE_NONE_KEY, USAGE_OTHER_KEY, type UsageDimension, type UsageRange, type UsageSummary } from "@stubwise/shared";
import { and, gte, lt, sql, type SQL } from "drizzle-orm";
import { inProjects } from "../auth/access.js";

/**
 * Area 9, F4: AI → Usage nell'app, nella forma della scheda del prototipo.
 * Fonte: `agent_runs`, la stessa del web vecchio (`/api/ai-usage/costs`), con
 * la stessa regola di accesso (`usageScope`: tutta l'istanza con `usage.view`,
 * altrimenti i soli progetti con `project.usage.view`). R-G5: un progetto che
 * chi guarda non vede diventa la riga `other`, senza codice, nome né id; con
 * un'altra dimensione conta nei totali e nelle righe senza rivelare niente.
 */

export const USAGE_MAX_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** L'intervallo in giorni UTC: `[from, toExclusive)` e l'elenco dei giorni (per i punti a zero). Lancia su un intervallo non valido. */
export function usageDays(range: UsageRange, now: Date): { from: Date; toExclusive: Date; days: string[] } {
  const today = startOfUtcDay(now);
  let from: Date;
  let to: Date; // compreso
  if ("days" in range) {
    to = today;
    from = new Date(today.getTime() - (range.days - 1) * DAY_MS);
  } else if ("month" in range) {
    to = today;
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else {
    from = new Date(`${range.from}T00:00:00.000Z`);
    to = new Date(`${range.to}T00:00:00.000Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw new Error("invalid_range");
    if ((to.getTime() - from.getTime()) / DAY_MS + 1 > USAGE_MAX_DAYS) throw new Error("range_too_long");
  }
  const days: string[] = [];
  for (let d = from.getTime(); d <= to.getTime(); d += DAY_MS) days.push(isoDay(new Date(d)));
  return { from, toExclusive: new Date(to.getTime() + DAY_MS), days };
}

export interface UsageRawRow {
  a: string | null;
  b: string | null;
  cost: number;
  tokens: number;
  runs: number;
}

export interface UsageNames {
  /** I progetti che chi guarda vede: id → { nome, codice }. Gli altri diventano `other`. */
  visibleProjects: Map<string, { name: string; code: string }>;
  providers: Map<string, string>;
}

type Leaf = UsageSummary["rows"][number]["children"][number];

/** La chiave e l'etichetta di un valore di una dimensione, con la regola R-G5 sui progetti. */
export function keyOf(dim: UsageDimension, value: string | null, names: UsageNames): Pick<Leaf, "key" | "label" | "code"> {
  if (value === null) return { key: USAGE_NONE_KEY, label: USAGE_NONE_KEY, code: null };
  if (dim === "project") {
    const p = names.visibleProjects.get(value);
    return p ? { key: value, label: p.name, code: p.code } : { key: USAGE_OTHER_KEY, label: USAGE_OTHER_KEY, code: null };
  }
  if (dim === "provider") return { key: value, label: names.providers.get(value) ?? value, code: null };
  return { key: value, label: value, code: null };
}

/** Per costo decrescente, poi per etichetta; il giorno dal più recente. */
const order = (dim: UsageDimension) => (x: Leaf, y: Leaf) => (dim === "day" ? y.key.localeCompare(x.key) : y.costUsd - x.costUsd || x.label.localeCompare(y.label));

function merge(into: Map<string, Leaf>, k: Pick<Leaf, "key" | "label" | "code">, r: Pick<UsageRawRow, "cost" | "tokens" | "runs">): Leaf {
  const prev = into.get(k.key) ?? { ...k, costUsd: 0, tokens: 0, runs: 0 };
  const next = { ...prev, costUsd: prev.costUsd + r.cost, tokens: prev.tokens + r.tokens, runs: prev.runs + r.runs };
  into.set(k.key, next);
  return next;
}

/** Le righe raggruppate (e i sotto-gruppi), con `other` e `none` fusi. */
export function usageRows(raw: UsageRawRow[], groupBy: UsageDimension, thenBy: UsageDimension | null, names: UsageNames): UsageSummary["rows"] {
  const top = new Map<string, Leaf>();
  const kids = new Map<string, Map<string, Leaf>>();
  for (const r of raw) {
    const k = keyOf(groupBy, r.a, names);
    merge(top, k, r);
    if (thenBy) {
      const sub = kids.get(k.key) ?? new Map<string, Leaf>();
      merge(sub, keyOf(thenBy, r.b, names), r);
      kids.set(k.key, sub);
    }
  }
  return [...top.values()].sort(order(groupBy)).map((row) => ({ ...row, children: thenBy ? [...(kids.get(row.key)?.values() ?? [])].sort(order(thenBy)) : [] }));
}

const DIM_SQL: Record<UsageDimension, SQL> = {
  day: sql`to_char(${agentRuns.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
  model: sql`${agentRuns.model}`,
  project: sql`${agentRuns.projectId}::text`,
  provider: sql`${agentRuns.providerId}::text`,
  operation: sql`${agentRuns.operation}`,
};

export async function usageSummary(
  db: Db,
  input: { range: UsageRange; groupBy: UsageDimension; thenBy: UsageDimension | null; scope: "all" | string[]; visibleProjectIds: "all" | string[] },
  now = new Date(),
): Promise<UsageSummary> {
  const { from, toExclusive, days } = usageDays(input.range, now);
  const where = and(gte(agentRuns.createdAt, from), lt(agentRuns.createdAt, toExclusive), inProjects(agentRuns.projectId, input.scope));
  const cost = sql<string>`coalesce(sum(coalesce(${agentRuns.costUsd}, 0)), 0)`;
  const [tot] = await db
    .select({ cost, input: sql<string>`coalesce(sum(${agentRuns.inputTokens}), 0)`, output: sql<string>`coalesce(sum(${agentRuns.outputTokens}), 0)`, cache: sql<string>`coalesce(sum(${agentRuns.cacheReadTokens}), 0)`, runs: sql<string>`count(*)` })
    .from(agentRuns)
    .where(where);
  const perDay = await db.select({ day: DIM_SQL.day, cost, runs: sql<string>`count(*)` }).from(agentRuns).where(where).groupBy(DIM_SQL.day);
  const dayMap = new Map(perDay.map((d) => [d.day as unknown as string, d]));

  const a = DIM_SQL[input.groupBy];
  const b = input.thenBy ? DIM_SQL[input.thenBy] : sql`NULL::text`;
  const raw = await db
    .select({ a: sql<string | null>`${a}`, b: sql<string | null>`${b}`, cost, tokens: sql<string>`coalesce(sum(${agentRuns.inputTokens} + ${agentRuns.outputTokens}), 0)`, runs: sql<string>`count(*)` })
    .from(agentRuns)
    .where(where)
    .groupBy(a, b);

  const projectRows = await db.select({ id: projects.id, name: projects.name, code: projects.code }).from(projects);
  const visible = input.visibleProjectIds === "all" ? null : new Set(input.visibleProjectIds);
  const names: UsageNames = {
    visibleProjects: new Map(projectRows.filter((p) => !visible || visible.has(p.id)).map((p) => [p.id, { name: p.name, code: p.code }])),
    providers: new Map((await db.select({ id: aiProviders.id, label: aiProviders.label }).from(aiProviders)).map((p) => [p.id, p.label])),
  };

  return {
    totals: { costUsd: Number(tot?.cost ?? 0), inputTokens: Number(tot?.input ?? 0), outputTokens: Number(tot?.output ?? 0), cacheReadTokens: Number(tot?.cache ?? 0), runs: Number(tot?.runs ?? 0) },
    byDay: days.map((day) => ({ day, costUsd: Number(dayMap.get(day)?.cost ?? 0), runs: Number(dayMap.get(day)?.runs ?? 0) })),
    rows: usageRows(
      raw.map((r) => ({ a: r.a, b: r.b, cost: Number(r.cost), tokens: Number(r.tokens), runs: Number(r.runs) })),
      input.groupBy,
      input.thenBy,
      names,
    ),
  };
}
