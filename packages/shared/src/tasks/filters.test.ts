import { describe, expect, it } from "vitest";
import { filterCriteriaSchema, parseCriteria } from "../schemas/task-filter.js";
import { canUseStatusIds, periodRange, taskInPeriod } from "./filters.js";

/**
 * I criteri dei filtri salvati (integrazione area 2, fetta 3): spostati da
 * `apps/desktop/src/renderer/domain/filters.ts`, una regola in un posto per
 * il finto, il server e l'app.
 */

const TODAY = "2026-11-11"; // un mercoledì

describe("periodRange", () => {
  it("i periodi relativi, rispetto a oggi, estremi inclusi", () => {
    const r = (p: Parameters<typeof periodRange>[0]) => periodRange(p, TODAY);
    expect(r({ kind: "relative", preset: "last7" })).toEqual({ from: "2026-11-05", to: "2026-11-11" });
    expect(r({ kind: "relative", preset: "last30" })).toEqual({ from: "2026-10-13", to: "2026-11-11" });
    expect(r({ kind: "relative", preset: "thisWeek" })).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(r({ kind: "relative", preset: "nextWeek" })).toEqual({ from: "2026-11-16", to: "2026-11-22" });
    expect(r({ kind: "relative", preset: "thisMonth" })).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(r({ kind: "relative", preset: "lastMonth" })).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("un periodo assoluto resta com'è; il mese scorso di gennaio è dicembre dell'anno prima; la domenica è nella sua settimana", () => {
    expect(periodRange({ kind: "absolute", from: "2026-01-01", to: "2026-02-01" }, TODAY)).toEqual({
      from: "2026-01-01",
      to: "2026-02-01",
    });
    expect(periodRange({ kind: "relative", preset: "lastMonth" }, "2027-01-15")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(periodRange({ kind: "relative", preset: "thisWeek" }, "2026-11-15")).toEqual({
      from: "2026-11-09",
      to: "2026-11-15",
    });
  });
});

describe("taskInPeriod", () => {
  const task = {
    createdAt: "2026-11-10T09:00:00.000Z",
    closedAt: null as string | null,
    dueDate: "2026-11-30" as string | null,
    plannedWeek: "2026-W44" as string | null, // 26 ott – 1 nov
  };
  const thisMonth = { kind: "relative", preset: "thisMonth" } as const;

  it("creata, chiusa, scadenza: il giorno cade nel periodo", () => {
    expect(taskInPeriod(task, { field: "created", ...thisMonth }, TODAY)).toBe(true);
    expect(taskInPeriod(task, { field: "created", kind: "relative", preset: "lastMonth" }, TODAY)).toBe(false);
    expect(taskInPeriod(task, { field: "due", ...thisMonth }, TODAY)).toBe(true);
    // Senza data di chiusura non è «chiusa in» nessun periodo.
    expect(taskInPeriod(task, { field: "closed", ...thisMonth }, TODAY)).toBe(false);
    expect(taskInPeriod({ ...task, closedAt: "2026-11-01T00:30:00.000Z" }, { field: "closed", ...thisMonth }, TODAY)).toBe(
      true,
    );
  });

  it("la settimana pianificata è un intervallo: basta che si sovrapponga", () => {
    // La W44 finisce domenica 1 novembre: si sovrappone a novembre e a ottobre.
    expect(taskInPeriod(task, { field: "plannedWeek", ...thisMonth }, TODAY)).toBe(true);
    expect(taskInPeriod(task, { field: "plannedWeek", kind: "relative", preset: "lastMonth" }, TODAY)).toBe(true);
    expect(taskInPeriod(task, { field: "plannedWeek", kind: "relative", preset: "thisWeek" }, TODAY)).toBe(false);
    expect(taskInPeriod({ ...task, plannedWeek: null }, { field: "plannedWeek", ...thisMonth }, TODAY)).toBe(false);
  });
});

describe("filterCriteriaSchema e parseCriteria", () => {
  it("lo schema accetta i criteri del prototipo e rifiuta una famiglia o un periodo sbagliati", () => {
    const seeds = [
      { families: ["todo", "active"] },
      { families: ["closed"], period: { field: "closed", kind: "relative", preset: "thisMonth" } },
      { stalled: true },
      { families: ["todo", "active"], sizes: ["none"] },
      { families: ["todo", "active"], assigneeIds: ["none"] },
      { departmentIds: ["dep-marketing"], period: { field: "plannedWeek", kind: "absolute", from: "2026-11-01", to: "2026-11-30" } },
    ];
    for (const s of seeds) expect(filterCriteriaSchema.parse(s)).toEqual(s);
    expect(filterCriteriaSchema.safeParse({ families: ["boh"] }).success).toBe(false);
    expect(filterCriteriaSchema.safeParse({ period: { field: "created", kind: "relative", preset: "ieri" } }).success).toBe(
      false,
    );
    expect(
      filterCriteriaSchema.safeParse({ period: { field: "created", kind: "absolute", from: "1/11", to: "2026-11-30" } })
        .success,
    ).toBe(false);
  });

  it("parseCriteria tiene ciò che ha la forma giusta, chiave per chiave, e scarta il resto", () => {
    expect(parseCriteria(null)).toBeNull();
    expect(parseCriteria([1])).toBeNull();
    expect(
      parseCriteria({
        families: ["todo", "boh"],
        sizes: ["XL", 3],
        types: [],
        stalled: "sì",
        text: "",
        priorities: ["urgent"],
        period: { field: "created", kind: "relative", preset: "ieri" },
        sconosciuta: 1,
      }),
    ).toEqual({ families: ["todo"], sizes: ["XL"], priorities: ["urgent"] });
    expect(parseCriteria({ text: "login", stalled: false, period: { field: "due", kind: "relative", preset: "last7" } })).toEqual({
      text: "login",
      stalled: false,
      period: { field: "due", kind: "relative", preset: "last7" },
    });
  });

  it("canUseStatusIds: gli stati hanno senso solo con un progetto scelto", () => {
    expect(canUseStatusIds({ projectIds: ["a"] })).toBe(true);
    expect(canUseStatusIds({ projectIds: ["a", "b"] })).toBe(false);
    expect(canUseStatusIds({})).toBe(false);
  });
});
