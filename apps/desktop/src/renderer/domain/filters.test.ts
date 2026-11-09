import { describe, expect, it } from "vitest";
import type { FilterCriteria, Task } from "../data/model";
import { familyOfStub, makeTask } from "./fixtures";
import {
  canUseStatusIds,
  matches,
  parseCriteria,
  periodRange,
  type FilterContext,
} from "./filters";

const ctx: FilterContext = {
  familyOf: familyOfStub,
  isStalled: (t) => t.id === "stalled",
  projectName: (id) => `Progetto ${id}`,
};

const ok = (t: Task, c: FilterCriteria) => matches(t, c, ctx);

describe("matches", () => {
  it("nessun criterio = tutto", () => {
    expect(ok(makeTask(), {})).toBe(true);
    expect(ok(makeTask(), { projectIds: [], text: "  " })).toBe(true);
  });

  it("progetto e reparto: OR dentro l'elenco", () => {
    const t = makeTask({ projectId: "p2", departmentId: "d3" });
    expect(ok(t, { projectIds: ["p1", "p2"] })).toBe(true);
    expect(ok(t, { projectIds: ["p1"] })).toBe(false);
    expect(ok(t, { departmentIds: ["d3"] })).toBe(true);
    expect(ok(t, { departmentIds: ["d1"] })).toBe(false);
  });

  it("assegnatario, con 'none' per le non assegnate", () => {
    const mine = makeTask({ assigneeId: "u1" });
    const nobody = makeTask({ assigneeId: null });
    expect(ok(nobody, { assigneeIds: ["none"] })).toBe(true);
    expect(ok(mine, { assigneeIds: ["none"] })).toBe(false);
    expect(ok(mine, { assigneeIds: ["none", "u1"] })).toBe(true);
    expect(ok(nobody, { assigneeIds: ["u1"] })).toBe(false);
  });

  it("famiglia e stato", () => {
    const t = makeTask({ statusId: "s-closed" });
    expect(ok(t, { families: ["closed"] })).toBe(true);
    expect(ok(t, { families: ["todo", "active"] })).toBe(false);
    expect(ok(t, { statusIds: ["s-closed"] })).toBe(true);
    expect(ok(t, { statusIds: ["s-active"] })).toBe(false);
  });

  it("taglia, con 'none' per le senza stima", () => {
    expect(ok(makeTask({ size: null }), { sizes: ["none"] })).toBe(true);
    expect(ok(makeTask({ size: "M" }), { sizes: ["none"] })).toBe(false);
    expect(ok(makeTask({ size: "M" }), { sizes: ["S", "M"] })).toBe(true);
    expect(ok(makeTask({ size: null }), { sizes: ["S"] })).toBe(false);
  });

  it("tipo e priorità: OR dentro l'elenco, AND fra i due", () => {
    const t = makeTask({ type: "bug", priority: "high" });
    expect(ok(t, { types: ["bug", "activity"] })).toBe(true);
    expect(ok(t, { types: ["feature"] })).toBe(false);
    expect(ok(t, { priorities: ["high", "urgent"] })).toBe(true);
    expect(ok(t, { priorities: ["low"] })).toBe(false);
    expect(ok(t, { types: ["bug"], priorities: ["low"] })).toBe(false);
    expect(ok(t, { types: [], priorities: [] })).toBe(true);
  });

  it("milestone: una task senza milestone non corrisponde mai a un elenco", () => {
    expect(ok(makeTask({ milestoneId: "m1" }), { milestoneIds: ["m1"] })).toBe(true);
    expect(ok(makeTask({ milestoneId: "m2" }), { milestoneIds: ["m1"] })).toBe(false);
    expect(ok(makeTask({ milestoneId: null }), { milestoneIds: ["m1"] })).toBe(false);
  });

  it("ferme: true prende le ferme, false le non ferme", () => {
    const s = makeTask({ id: "stalled" });
    const n = makeTask({ id: "fine" });
    expect(ok(s, { stalled: true })).toBe(true);
    expect(ok(n, { stalled: true })).toBe(false);
    expect(ok(s, { stalled: false })).toBe(false);
    expect(ok(n, { stalled: false })).toBe(true);
  });

  it("testo: case-insensitive su codice e titolo", () => {
    const t = makeTask({ code: "MKX-12", title: "Rifare la Landing" });
    expect(ok(t, { text: "mkx-12" })).toBe(true);
    expect(ok(t, { text: "LANDING" })).toBe(true);
    expect(ok(t, { text: "altro" })).toBe(false);
  });

  it("periodo: campo e intervallo, task senza il campo escluse", () => {
    const closed = makeTask({ closedAt: "2026-10-05T12:00:00Z" });
    const open = makeTask({ closedAt: null });
    const p: FilterCriteria["period"] = { field: "closed", kind: "relative", preset: "thisMonth" };
    expect(ok(closed, { period: p })).toBe(true);
    expect(ok(open, { period: p })).toBe(false);
    expect(ok(makeTask({ closedAt: "2026-09-30T12:00:00Z" }), { period: p })).toBe(false);

    const due = makeTask({ dueDate: "2026-10-25" });
    expect(
      ok(due, { period: { field: "due", kind: "absolute", from: "2026-10-25", to: "2026-10-26" } }),
    ).toBe(true);
    expect(
      ok(due, { period: { field: "due", kind: "absolute", from: "2026-10-26", to: "2026-10-27" } }),
    ).toBe(false);

    const created = makeTask({ createdAt: "2026-10-17T00:00:00Z" });
    expect(ok(created, { period: { field: "created", kind: "relative", preset: "last7" } })).toBe(
      true,
    );

    const planned = makeTask({ plannedWeek: "2026-W43" });
    expect(
      ok(planned, { period: { field: "plannedWeek", kind: "relative", preset: "thisWeek" } }),
    ).toBe(true);
    expect(
      ok(planned, { period: { field: "plannedWeek", kind: "relative", preset: "nextWeek" } }),
    ).toBe(false);
  });

  it("AND fra criteri diversi", () => {
    const t = makeTask({ projectId: "p1", assigneeId: null, size: "S" });
    expect(ok(t, { projectIds: ["p1"], assigneeIds: ["none"], sizes: ["S"] })).toBe(true);
    expect(ok(t, { projectIds: ["p1"], assigneeIds: ["none"], sizes: ["L"] })).toBe(false);
  });
});

describe("periodRange", () => {
  it("relativi a TODAY (2026-10-23, venerdì)", () => {
    expect(periodRange({ kind: "relative", preset: "thisMonth" })).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(periodRange({ kind: "relative", preset: "lastMonth" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(periodRange({ kind: "relative", preset: "last7" })).toEqual({
      from: "2026-10-17",
      to: "2026-10-23",
    });
    expect(periodRange({ kind: "relative", preset: "last30" })).toEqual({
      from: "2026-09-24",
      to: "2026-10-23",
    });
    expect(periodRange({ kind: "relative", preset: "thisWeek" })).toEqual({
      from: "2026-10-19",
      to: "2026-10-25",
    });
    expect(periodRange({ kind: "relative", preset: "nextWeek" })).toEqual({
      from: "2026-10-26",
      to: "2026-11-01",
    });
  });

  it("l'oggi si può passare, e gennaio guarda a dicembre", () => {
    expect(periodRange({ kind: "relative", preset: "lastMonth" }, "2027-01-15")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });

  it("l'assoluto è com'è", () => {
    expect(periodRange({ kind: "absolute", from: "2026-01-01", to: "2026-02-01" })).toEqual({
      from: "2026-01-01",
      to: "2026-02-01",
    });
  });
});

describe("canUseStatusIds", () => {
  it("solo con esattamente un progetto", () => {
    expect(canUseStatusIds({})).toBe(false);
    expect(canUseStatusIds({ projectIds: [] })).toBe(false);
    expect(canUseStatusIds({ projectIds: ["p1"] })).toBe(true);
    expect(canUseStatusIds({ projectIds: ["p1", "p2"] })).toBe(false);
  });
});

describe("parseCriteria", () => {
  it("tiene i criteri ben formati e scarta il resto", () => {
    expect(
      parseCriteria({
        families: ["todo", "nope"],
        assigneeIds: ["p-1", "none", 3],
        sizes: ["XS", "XXL", "none"],
        types: ["bug", "task"],
        priorities: ["urgent", "critical", 2],
        stalled: true,
        text: "invoice",
        period: { field: "due", kind: "relative", preset: "thisWeek" },
        other: 1,
      }),
    ).toEqual({
      families: ["todo"],
      assigneeIds: ["p-1", "none"],
      sizes: ["XS", "none"],
      types: ["bug"],
      priorities: ["urgent"],
      stalled: true,
      text: "invoice",
      period: { field: "due", kind: "relative", preset: "thisWeek" },
    });
  });

  it("un periodo malformato o un valore che non è un oggetto non passano", () => {
    expect(parseCriteria({ period: { field: "due", kind: "relative", preset: "x" } })).toEqual({});
    expect(
      parseCriteria({ period: { field: "closed", kind: "absolute", from: "2026-10-01", to: "x" } }),
    ).toEqual({});
    expect(parseCriteria("{}")).toBeNull();
    expect(parseCriteria(["todo"])).toBeNull();
    expect(parseCriteria(null)).toBeNull();
  });
});
