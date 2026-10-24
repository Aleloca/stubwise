import { describe, expect, it } from "vitest";
import type { Person } from "../data/model";
import { makeTask } from "./fixtures";
import { busiestCell, canMove, isToPlan, peopleLoad, planBlock, type PlanRights } from "./planning";

const person = (id: string): Person => ({
  id,
  name: id,
  initials: id.slice(0, 2).toUpperCase(),
  departmentIds: [],
  isClaude: false,
  presetRole: "developer",
});

const W43 = "2026-W43";
const W44 = "2026-W44";
const CLOSED = "2026-10-20T10:00:00Z";

describe("peopleLoad", () => {
  const people = [person("u1"), person("u2")];
  const tasks = [
    makeTask({ id: "a", assigneeId: "u1", projectId: "p1", plannedWeek: W43, size: "M" }),
    makeTask({ id: "b", assigneeId: "u1", projectId: "p2", plannedWeek: W43, size: "L" }),
    makeTask({ id: "c", assigneeId: "u1", projectId: "p1", plannedWeek: W43, size: null }),
    makeTask({ id: "d", assigneeId: "u1", projectId: "p1", plannedWeek: W44, size: "S", slipCount: 2 }),
    makeTask({ id: "e", assigneeId: "u1", projectId: "p1", plannedWeek: null, size: "XL" }),
    // Chiusa: non pesa e non conta.
    makeTask({ id: "f", assigneeId: "u1", projectId: "p1", plannedWeek: W43, size: "XL", closedAt: CLOSED }),
    // Persona fuori dalla vista: ignorata.
    makeTask({ id: "g", assigneeId: "u9", projectId: "p1", plannedWeek: W43, size: "M" }),
    makeTask({ id: "h", assigneeId: null, projectId: "p1", plannedWeek: W43, size: "M" }),
  ];

  it("conta qui e ovunque, e le slittate di questo progetto", () => {
    const u1 = peopleLoad(tasks, people, [W43, W44], { projectId: "p1" }).get("u1")!;
    expect(u1.openHere).toBe(4);
    expect(u1.openEverywhere).toBe(5);
    expect(u1.slipped).toBe(1);
  });

  it("per settimana: peso di tutti i progetti, la parte di questo a sé, senza stima a parte", () => {
    const u1 = peopleLoad(tasks, people, [W43, W44], { projectId: "p1" }).get("u1")!;
    expect(u1.byWeek[W43]).toEqual({ weight: 8, hereWeight: 3, count: 3, unsized: 1, slipped: 0 });
    expect(u1.byWeek[W44]).toEqual({ weight: 2, hereWeight: 2, count: 1, unsized: 0, slipped: 1 });
  });

  it("chi non ha task ha zeri; senza progetto «qui» è ovunque", () => {
    const loads = peopleLoad(tasks, people, [W43], {});
    expect(loads.get("u2")).toEqual({
      openHere: 0,
      openEverywhere: 0,
      slipped: 0,
      byWeek: { [W43]: { weight: 0, hereWeight: 0, count: 0, unsized: 0, slipped: 0 } },
    });
    expect(loads.get("u1")!.openHere).toBe(5);
    expect(loads.get("u1")!.byWeek[W43]!.hereWeight).toBe(8);
  });

  it("la cella più carica della vista fa da massimo", () => {
    const loads = peopleLoad(tasks, people, [W43, W44], { projectId: "p1" });
    expect(busiestCell(loads, [W43, W44])).toBe(8);
    expect(busiestCell(loads, [W44])).toBe(2);
  });
});

describe("isToPlan", () => {
  it("aperte senza settimana o senza persona, e slittate ancora nella settimana corrente", () => {
    expect(isToPlan(makeTask({ plannedWeek: null }), W43)).toBe(true);
    expect(isToPlan(makeTask({ plannedWeek: W43, assigneeId: null }), W43)).toBe(true);
    expect(isToPlan(makeTask({ plannedWeek: W43, slipCount: 1 }), W43)).toBe(true);
    expect(isToPlan(makeTask({ plannedWeek: W44, slipCount: 1 }), W43)).toBe(false);
    expect(isToPlan(makeTask({ plannedWeek: W43 }), W43)).toBe(false);
    expect(isToPlan(makeTask({ plannedWeek: null, closedAt: CLOSED }), W43)).toBe(false);
  });
});

describe("planBlock", () => {
  const lead: PlanRights = { me: "u1", others: true, edit: true, members: ["u1", "u2"] };
  const member: PlanRights = { me: "u1", others: false, edit: true, members: ["u1", "u2"] };

  it("con planning.others: chiunque sia membro, o nessuno", () => {
    const task = makeTask({ assigneeId: "u2" });
    expect(planBlock(task, "u1", lead)).toBeNull();
    expect(planBlock(task, "u3", lead)).toBe("member");
    expect(planBlock(makeTask({ assigneeId: null }), null, lead)).toBeNull();
  });

  it("senza: solo il proprio, o prendere per sé una non assegnata", () => {
    expect(planBlock(makeTask({ assigneeId: "u1" }), "u1", member)).toBeNull();
    expect(planBlock(makeTask({ assigneeId: "u1" }), null, member)).toBeNull();
    expect(planBlock(makeTask({ assigneeId: "u1" }), "u2", member)).toBe("others");
    expect(planBlock(makeTask({ assigneeId: "u2" }), "u1", member)).toBe("others");
    expect(planBlock(makeTask({ assigneeId: null }), "u1", member)).toBeNull();
    expect(planBlock(makeTask({ assigneeId: null }), "u1", { ...member, edit: false })).toBe("others");
    expect(planBlock(makeTask({ assigneeId: null }), null, member)).toBe("others");
  });

  it("canMove: le chiuse mai; le altrui solo con planning.others", () => {
    expect(canMove(makeTask({ assigneeId: "u2" }), lead)).toBe(true);
    expect(canMove(makeTask({ assigneeId: "u2" }), member)).toBe(false);
    expect(canMove(makeTask({ assigneeId: "u1" }), member)).toBe(true);
    expect(canMove(makeTask({ assigneeId: "u1", closedAt: CLOSED }), lead)).toBe(false);
  });
});
