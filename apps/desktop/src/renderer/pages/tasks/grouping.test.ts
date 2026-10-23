import { describe, expect, it } from "vitest";
import type { Department, Milestone, Person, ProjectStatus } from "../../data/types";
import { makeTask } from "../../domain/fixtures";
import { groupTasks, sortTasks, type GroupContext } from "./grouping";

const statuses: ProjectStatus[] = [
  { id: "s-todo", projectId: "p1", name: "To do", family: "todo", order: 0 },
  { id: "s-active", projectId: "p1", name: "In progress", family: "active", order: 1 },
  { id: "s-review", projectId: "p1", name: "In review", family: "active", order: 2 },
  { id: "s-closed", projectId: "p1", name: "Done", family: "closed", order: 3 },
];
const people: Person[] = [
  { id: "u2", name: "Bruno Verdi", initials: "BV", departmentIds: [], isClaude: false, presetRole: "x" },
  { id: "u1", name: "Anna Rossi", initials: "AR", departmentIds: [], isClaude: false, presetRole: "x" },
];
const departments: Department[] = [
  { id: "d2", name: "Sales", colorToken: "--dept-2" },
  { id: "d1", name: "Marketing", colorToken: "--dept-1" },
];
const milestones: Milestone[] = [
  { id: "m2", projectId: "p1", name: "Launch", description: "", dueDate: "2026-12-01", closed: false },
  { id: "m1", projectId: "p1", name: "Beta", description: "", dueDate: "2026-11-01", closed: false },
];

const ctx: GroupContext = {
  statuses,
  people,
  departments,
  milestones,
  labels: {
    all: "All tasks",
    noAssignee: "No assignee",
    noMilestone: "No milestone",
    noWeek: "No week",
    other: "Other",
    family: (f) => f,
    week: (w) => `week ${w}`,
  },
};

describe("groupTasks", () => {
  it("per stato: nell'ordine del progetto, non in quello delle task", () => {
    const tasks = [
      makeTask({ id: "a", statusId: "s-closed" }),
      makeTask({ id: "b", statusId: "s-review" }),
      makeTask({ id: "c", statusId: "s-todo" }),
      makeTask({ id: "d", statusId: "s-review" }),
    ];
    const groups = groupTasks(tasks, "status", ctx);
    expect(groups.map((g) => g.label)).toEqual(["To do", "In review", "Done"]);
    expect(groups[1]!.tasks.map((t) => t.id)).toEqual(["b", "d"]);
  });

  it("per stato con task di più progetti: per famiglia", () => {
    const other: ProjectStatus = {
      id: "s-x",
      projectId: "p2",
      name: "Draft",
      family: "active",
      order: 1,
    };
    const tasks = [
      makeTask({ id: "a", statusId: "s-x", projectId: "p2" }),
      makeTask({ id: "b", statusId: "s-todo" }),
      makeTask({ id: "c", statusId: "s-active" }),
    ];
    const groups = groupTasks(tasks, "status", { ...ctx, statuses: [...statuses, other] });
    expect(groups.map((g) => g.key)).toEqual(["todo", "active"]);
    expect(groups[1]!.tasks.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("per settimana in ordine cronologico: 2027-W01 dopo 2026-W53, «No week» ultimo", () => {
    const tasks = [
      makeTask({ id: "a", plannedWeek: "2027-W01" }),
      makeTask({ id: "b", plannedWeek: null }),
      makeTask({ id: "c", plannedWeek: "2026-W53" }),
      makeTask({ id: "d", plannedWeek: "2026-W09" }),
    ];
    const groups = groupTasks(tasks, "week", ctx);
    expect(groups.map((g) => g.key)).toEqual(["2026-W09", "2026-W53", "2027-W01", "none"]);
    expect(groups.at(-1)!.label).toBe("No week");
    expect(groups[0]!.label).toBe("week 2026-W09");
  });

  it("per assegnatario: in ordine di nome, «No assignee» ultimo", () => {
    const tasks = [
      makeTask({ id: "a", assigneeId: null }),
      makeTask({ id: "b", assigneeId: "u2" }),
      makeTask({ id: "c", assigneeId: "u1" }),
    ];
    const groups = groupTasks(tasks, "assignee", ctx);
    expect(groups.map((g) => g.label)).toEqual(["Anna Rossi", "Bruno Verdi", "No assignee"]);
  });

  it("per reparto nell'ordine di configurazione; per traguardo per data, «No milestone» ultimo", () => {
    const tasks = [
      makeTask({ id: "a", departmentId: "d1", milestoneId: null }),
      makeTask({ id: "b", departmentId: "d2", milestoneId: "m2" }),
      makeTask({ id: "c", departmentId: "d1", milestoneId: "m1" }),
    ];
    expect(groupTasks(tasks, "department", ctx).map((g) => g.label)).toEqual([
      "Sales",
      "Marketing",
    ]);
    expect(groupTasks(tasks, "milestone", ctx).map((g) => g.label)).toEqual([
      "Beta",
      "Launch",
      "No milestone",
    ]);
  });

  it("senza raggruppamento: un gruppo solo; nessun gruppo vuoto", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    expect(groupTasks(tasks, "none", ctx)).toEqual([
      { key: "all", label: "All tasks", tasks },
    ]);
    expect(groupTasks([], "status", ctx)).toEqual([]);
  });
});

describe("groupTasks non perde task", () => {
  it("chiavi che il contesto non conosce finiscono in «Other», ultimo", () => {
    const tasks = [
      makeTask({ id: "a", statusId: "s-todo", departmentId: "d1", assigneeId: "u1", milestoneId: "m1" }),
      makeTask({ id: "b", statusId: "s-gone", departmentId: "d-gone", assigneeId: "u-gone", milestoneId: "m-gone" }),
    ];
    for (const by of ["status", "department", "assignee", "milestone"] as const) {
      const groups = groupTasks(tasks, by, ctx);
      expect(groups.flatMap((g) => g.tasks.map((t) => t.id)).sort(), by).toEqual(["a", "b"]);
      expect(groups.at(-1), by).toEqual({ key: "other", label: "Other", tasks: [tasks[1]] });
    }
  });
});

describe("sortTasks", () => {
  it("per codice in ordine numerico, e al contrario", () => {
    const tasks = [
      makeTask({ id: "a", code: "AUD-10" }),
      makeTask({ id: "b", code: "AUD-9" }),
      makeTask({ id: "c", code: "AUD-100" }),
    ];
    expect(sortTasks(tasks, { key: "code", dir: "asc" }, ctx).map((t) => t.code)).toEqual([
      "AUD-9",
      "AUD-10",
      "AUD-100",
    ]);
    expect(sortTasks(tasks, { key: "code", dir: "desc" }, ctx).map((t) => t.code)).toEqual([
      "AUD-100",
      "AUD-10",
      "AUD-9",
    ]);
  });

  it("per scadenza e per taglia: i vuoti in fondo in entrambi i versi", () => {
    const tasks = [
      makeTask({ id: "a", dueDate: null, size: "S" }),
      makeTask({ id: "b", dueDate: "2026-11-02", size: null }),
      makeTask({ id: "c", dueDate: "2026-10-25", size: "XL" }),
    ];
    expect(sortTasks(tasks, { key: "due", dir: "asc" }, ctx).map((t) => t.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(sortTasks(tasks, { key: "due", dir: "desc" }, ctx).map((t) => t.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(sortTasks(tasks, { key: "size", dir: "desc" }, ctx).map((t) => t.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("per stato nell'ordine del progetto", () => {
    const tasks = [
      makeTask({ id: "a", statusId: "s-closed" }),
      makeTask({ id: "b", statusId: "s-todo" }),
    ];
    expect(sortTasks(tasks, { key: "status", dir: "asc" }, ctx).map((t) => t.id)).toEqual([
      "b",
      "a",
    ]);
  });
});
