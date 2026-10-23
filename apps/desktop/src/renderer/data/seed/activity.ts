import type { ActivityEntry, Task } from "../types";
import { DECISION_REQUESTS } from "./decisions";
import { PROJECT_STATUSES } from "./statuses";
import { TASKS } from "./tasks";

const REFERENCE_PROJECTS = new Set(["prj-aud", "prj-stw", "prj-mkx"]);

const COMMENTS = [
  "I had a first look: it is smaller than it seemed.",
  "Can we keep the same layout as last time?",
  "Done on my side, waiting for a second pair of eyes.",
  "The client liked the direction, a few changes in the thread.",
  "Moving this to next week, the brief came in late.",
];

const HOUR = 3_600_000;
const plusHours = (iso: string, h: number) =>
  new Date(Date.parse(iso) + h * HOUR).toISOString().replace(".000Z", "Z");

function entriesOf(task: Task, n: number): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const statuses = PROJECT_STATUSES.filter((s) => s.projectId === task.projectId);
  const first = statuses[0]!;
  const current = statuses.find((s) => s.id === task.statusId)!;
  const author = task.assigneeId ?? task.createdById;
  const id = (k: string) => `act-${task.id}-${k}`;

  // Il cambio di stato che l'ha portata dove è, a metà fra creazione e ultima attività.
  if (current.id !== first.id) {
    const mid = new Date((Date.parse(task.createdAt) + Date.parse(task.lastActivityAt)) / 2);
    out.push({
      id: id("status"),
      taskId: task.id,
      kind: "field_change",
      authorId: author,
      at: mid.toISOString().replace(/\.\d{3}Z$/, "Z"),
      field: "status",
      from: first.name,
      to: current.name,
    });
  }
  if (task.size) {
    out.push({
      id: id("size"),
      taskId: task.id,
      kind: "field_change",
      authorId: task.createdById,
      at: plusHours(task.createdAt, 1),
      field: "size",
      from: null,
      to: task.size,
    });
  }
  if (n % 2 === 1) {
    out.push({
      id: id("c1"),
      taskId: task.id,
      kind: "comment",
      authorId: author,
      at: task.lastActivityAt,
      body: COMMENTS[n % COMMENTS.length]!,
    });
  }
  return out;
}

const generated = TASKS.filter((t) => REFERENCE_PROJECTS.has(t.projectId)).flatMap((t, i) =>
  entriesOf(t, i),
);

// Un filo con risposta, un commento modificato e uno eliminato (testo vuoto).
const extra: ActivityEntry[] = [
  {
    id: "act-mkx-6-q",
    taskId: "t-mkx-6",
    kind: "comment",
    authorId: "p-giulia",
    at: "2026-10-21T09:30:00Z",
    body: "Can we shorten the headline? It wraps on mobile.",
  },
  {
    id: "act-mkx-6-r",
    taskId: "t-mkx-6",
    kind: "comment",
    authorId: "p-elena",
    at: "2026-10-21T11:00:00Z",
    body: "Yes, I'll send two options this afternoon.",
    replyToId: "act-mkx-6-q",
    editedAt: "2026-10-21T11:05:00Z",
  },
  {
    id: "act-stw-3-del",
    taskId: "t-stw-3",
    kind: "comment",
    authorId: "p-simone",
    at: "2026-10-20T16:00:00Z",
    body: "",
    deletedAt: "2026-10-20T16:10:00Z",
    deletedById: "p-simone",
  },
];

// La risposta a una richiesta di decisione entra nell'attività della task.
const decisions: ActivityEntry[] = DECISION_REQUESTS.filter((d) => d.answer !== null).map((d) => ({
  id: `act-${d.id}`,
  taskId: d.taskId,
  kind: "decision",
  authorId: d.answer!.byId,
  at: d.answer!.at,
  decisionRequestId: d.id,
}));

/** Attività (commenti, cambi di campo, decisioni) delle task dei progetti di riferimento. */
export const ACTIVITY: ActivityEntry[] = [...generated, ...extra, ...decisions].sort((a, b) =>
  a.at.localeCompare(b.at),
);
