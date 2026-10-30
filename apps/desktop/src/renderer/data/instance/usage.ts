import type { AiOperation } from "@stubwise/shared";
import type { Conversation, ModelUsage } from "../model";
import { eventsOf, gate, newId, now, state, visibleProjectIds } from "../store";
import { can, viewerFor } from "../viewer";
import { forbidden } from "../writer";
import { OPERATION_OF_KIND, modelIdFor } from "./models";
import type { UsageRecord } from "./state";

// I consumi d'istanza (area 9b, Task 2): la lettura della scheda Usage, lo
// speso del mese per il budget (Task 3) e la scrittura di una voce (Task 6,
// ogni run AI che il prototipo simula). Solo letture e una scrittura senza
// registro: un consumo non è una modifica che qualcuno ha fatto.
//
// R-G5: le voci di un progetto che chi guarda non vede diventano UNA riga,
// `key: "other"`. Con `groupBy` diverso da `project` contano nei totali e
// nelle righe senza rivelare niente: né il codice, né il nome, né l'id.

export type UsageDimension = "day" | "model" | "project" | "provider" | "operation";
export type UsageRange = { days: 7 | 30 | 90 } | { month: true } | { from: string; to: string };

export interface UsageRow {
  key: string | null;
  /** Un nome (modello, provider, progetto) o la chiave stessa (giorno, operazione: le parole sono della UI). */
  label: string;
  costUsd: number;
  /** Token in ingresso e in uscita; la cache letta ha il suo conteggio nei totali. */
  tokens: number;
  runs: number;
}

export interface UsageView {
  totals: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    runs: number;
  };
  /** Un punto per ogni giorno dell'intervallo, anche a zero. */
  byDay: { day: string; costUsd: number }[];
  rows: (UsageRow & { children: UsageRow[] })[];
}

export const OTHER_PROJECTS_KEY = "other";
export const OTHER_PROJECTS_LABEL = "Other projects";
/** Un intervallo libero non porta mai più di un anno di punti. */
const MAX_SPAN_DAYS = 366;

const DAY_MS = 86_400_000;
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const dayOf = (at: string): string => at.slice(0, 10);

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Gli estremi (inclusivi) dell'intervallo, rispetto a `now()`. */
function boundsOf(range: UsageRange): { from: string; to: string } {
  const today = dayOf(now());
  if ("days" in range) return { from: addDays(today, -(range.days - 1)), to: today };
  if ("month" in range) return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: range.from, to: range.to };
}

/** «claude-sonnet-4-5» → «Sonnet 4.5»; un id che non ha quella forma resta com'è. */
function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : model;
}

interface Key {
  key: string | null;
  label: string;
}

/** La chiave di una voce su una dimensione, per chi guarda (`visible` = i suoi progetti). */
function keyOf(r: UsageRecord, dim: UsageDimension, visible: Set<string>): Key {
  switch (dim) {
    case "day":
      return { key: dayOf(r.at), label: dayOf(r.at) };
    case "model":
      return { key: r.model, label: modelLabel(r.model) };
    case "operation":
      return { key: r.operation, label: r.operation };
    case "provider": {
      const p = state.instance.providers.find((x) => x.id === r.providerId);
      return { key: r.providerId, label: p?.name ?? r.providerId };
    }
    case "project": {
      if (r.projectId === null) return { key: null, label: "No project" };
      if (!visible.has(r.projectId))
        return { key: OTHER_PROJECTS_KEY, label: OTHER_PROJECTS_LABEL };
      const name = state.projects.find((p) => p.id === r.projectId)?.name ?? r.projectId;
      return { key: r.projectId, label: name };
    }
  }
}

function rowsOf(records: UsageRecord[], dim: UsageDimension, visible: Set<string>): UsageRow[] {
  const groups = new Map<string | null, UsageRow>();
  for (const r of records) {
    const { key, label } = keyOf(r, dim, visible);
    const row = groups.get(key) ?? { key, label, costUsd: 0, tokens: 0, runs: 0 };
    row.costUsd += r.costUsd;
    row.tokens += r.inputTokens + r.outputTokens;
    row.runs += 1;
    groups.set(key, row);
  }
  const rows = [...groups.values()].map((row) => ({ ...row, costUsd: round6(row.costUsd) }));
  // I giorni dal più recente; il resto per costo. «Other projects» chiude sempre.
  const rank = (row: UsageRow) => (row.key === OTHER_PROJECTS_KEY && dim === "project" ? 1 : 0);
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (dim === "day"
        ? (b.key ?? "").localeCompare(a.key ?? "")
        : b.costUsd - a.costUsd || a.label.localeCompare(b.label)),
  );
}

/** I consumi nell'intervallo, raggruppati (e, con `thenBy`, sotto-raggruppati). */
export async function getUsage(input: {
  range: UsageRange;
  groupBy: UsageDimension;
  thenBy?: UsageDimension;
}): Promise<UsageView> {
  const me = await gate("instance.getUsage");
  if (!can(viewerFor(me), "usage.view")) throw forbidden();
  const visible = visibleProjectIds(me);
  const { from, to } = boundsOf(input.range);
  const inRange = state.instance.usage.filter((r) => dayOf(r.at) >= from && dayOf(r.at) <= to);

  const totals = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, runs: 0 };
  const perDay = new Map<string, number>();
  for (const r of inRange) {
    totals.costUsd += r.costUsd;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cacheReadTokens += r.cacheReadTokens;
    totals.runs += 1;
    perDay.set(dayOf(r.at), (perDay.get(dayOf(r.at)) ?? 0) + r.costUsd);
  }
  totals.costUsd = round6(totals.costUsd);

  const byDay: UsageView["byDay"] = [];
  for (let day = from, i = 0; day <= to && i < MAX_SPAN_DAYS; day = addDays(day, 1), i++)
    byDay.push({ day, costUsd: round6(perDay.get(day) ?? 0) });

  const thenBy = input.thenBy && input.thenBy !== input.groupBy ? input.thenBy : null;
  const rows = rowsOf(inRange, input.groupBy, visible).map((row) => {
    const children = thenBy
      ? rowsOf(
          inRange.filter((r) => keyOf(r, input.groupBy, visible).key === row.key),
          thenBy,
          visible,
        )
      : [];
    return { ...row, children };
  });
  return { totals, byDay, rows };
}

// Lo speso del mese sta nel modulo foglia dei blocchi: lo legge `budgetReached`.
export { spentThisMonthUsd } from "./blocks";

/** Aggiunge una voce di consumo (ogni run AI simulata): l'id lo dà il prototipo. */
export function recordUsage(r: Omit<UsageRecord, "id">): void {
  state.instance.usage.push({ ...r, id: newId("usage") });
}

/**
 * I consumi finti di una fase, per famiglia di modello: plausibili e fissi,
 * così i test li sommano. Un id che non è di una famiglia nota conta come
 * Sonnet.
 */
function fakeUsage(model: string): Omit<ModelUsage, "model"> {
  if (/haiku/.test(model))
    return { inputTokens: 14_200, outputTokens: 1_600, cacheReadTokens: 0, costUsd: 0.03 };
  if (/opus/.test(model))
    return { inputTokens: 61_000, outputTokens: 5_400, cacheReadTokens: 128_000, costUsd: 2.4 };
  return { inputTokens: 52_000, outputTokens: 4_800, cacheReadTokens: 118_000, costUsd: 0.62 };
}

/**
 * Le operazioni di una sessione, con il modello di ciascuna: la prima è
 * quella con cui è partita (`c.model`); in una `task_run` l'esecuzione gira
 * come `fix_execute`, col modello che ha adesso. Una correzione nasce già in
 * esecuzione: il suo `c.model` è già quello di `fix_execute`.
 */
function phasesOf(c: Conversation, model: string): { operation: AiOperation; model: string }[] {
  if (c.kind !== "task_run") return [{ operation: OPERATION_OF_KIND[c.kind], model }];
  const phases = new Set(eventsOf(c.id).flatMap((e) => (e.type === "phase" ? [e.phase] : [])));
  if (!phases.has("plan")) return [{ operation: "fix_execute", model }];
  const out = [{ operation: "fix_plan" as AiOperation, model }];
  if (phases.has("execution") || phases.has("correction"))
    out.push({ operation: "fix_execute", model: modelIdFor("fix_execute") });
  return out;
}

/**
 * A fine sessione (area 9b, Task 6): i consumi della sessione col modello
 * con cui ha girato — nella sessione (la tabella «AI usage» della task) e
 * nei consumi d'istanza (`recordUsage`, che il budget somma). Solo le
 * sessioni nate con un modello (le nuove). Una sessione senza provider (la
 * catena vuota, ruling 11) non ha un account a cui addebitarli: restano
 * solo nella sessione.
 */
export function recordSessionUsage(c: Conversation): void {
  // L'analisi di un server conta da sé i suoi consumi, sotto il suo tetto (area 8b).
  if (!c.model || c.kind === "server_analysis") return;
  // Fermata mentre aspettava la coda: non ha mai girato, niente da addebitare.
  if (!eventsOf(c.id).some((e) => e.type !== "phase")) return;
  const rows = phasesOf(c, c.model).map(({ operation, model }) => ({
    operation,
    usage: { model, ...fakeUsage(model) },
  }));
  const usage = (c.usage ?? []).map((u) => ({ ...u }));
  for (const { usage: u } of rows) {
    const same = usage.find((x) => x.model === u.model);
    if (!same) {
      usage.push({ ...u });
      continue;
    }
    same.inputTokens += u.inputTokens;
    same.outputTokens += u.outputTokens;
    same.cacheReadTokens += u.cacheReadTokens;
    same.costUsd = round6(same.costUsd + u.costUsd);
  }
  c.usage = usage;
  const providerId = c.provider?.id;
  if (!providerId) return;
  for (const { operation, usage: u } of rows)
    recordUsage({
      at: now(),
      operation,
      model: u.model,
      projectId: c.projectId ?? c.contextProjectId,
      providerId,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      costUsd: u.costUsd,
      conversationId: c.id,
    });
}
