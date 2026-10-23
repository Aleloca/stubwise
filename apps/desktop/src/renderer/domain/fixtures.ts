import type { StatusFamily, Task } from "../data/model";

/** Task di prova per i test del dominio. */
export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    code: "ABC-1",
    projectId: "p1",
    title: "Titolo",
    description: "",
    statusId: "s-active",
    departmentId: "d1",
    assigneeId: "u1",
    createdById: "u1",
    followerIds: [],
    size: null,
    dueDate: null,
    plannedWeek: null,
    slipCount: 0,
    milestoneId: null,
    labels: [],
    type: "feature",
    priority: "medium",
    requestId: null,
    links: [],
    attachments: [],
    manualStall: null,
    claude: "none",
    createdAt: "2026-10-01T09:00:00Z",
    closedAt: null,
    lastActivityAt: "2026-10-22T09:00:00Z",
    ...over,
  };
}

/** Famiglia dallo `statusId` di prova: `s-todo`, `s-active`, `s-closed`. */
export function familyOfStub(task: Task): StatusFamily {
  return task.statusId.replace("s-", "") as StatusFamily;
}
