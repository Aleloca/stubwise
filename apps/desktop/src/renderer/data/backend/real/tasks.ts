import { ApiError, taskListQuery, type TaskListFilters } from "@stubwise/api-client";
import type { Stall, StallReason, TaskViewData } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { FilterCriteria, Task, TaskPatch } from "../../types";
import { appClient } from "./client";
import { NotIntegratedError } from "./notIntegrated";

// Le task della build app (integrazione area 2, fetta 1), da `/api/tasks`:
// il server le dà già nella forma del prototipo (stati per progetto, tipi
// mostrati, taglie, ferme, stato di Claude), e qui si leggono. Le regole
// derivate (cosa è fermo, chi può) le calcola il server, mai il client.

/**
 * Il codice di ogni task letta (`id` → `AUD-12`): le scritture dedicate
 * (seguire, allegati, collegamenti) non restituiscono la task, e la si rilegge
 * per codice. Si svuota al cambio di sessione (`forgetTaskCodes`).
 */
const codeById = new Map<string, string>();

export function forgetTaskCodes(): void {
  codeById.clear();
  truncatedByQuery.clear();
}

/**
 * Se l'ultima lettura di una query è arrivata troncata (oltre le 2000 righe il
 * server dice `truncated`), per la query della lista: `tasksTruncated` lo
 * legge dopo la `listTasks` che l'ha scritto. Si svuota al cambio di sessione.
 */
const truncatedByQuery = new Map<string, boolean>();

/** Una vista del server come `Task` del prototipo: 1:1, la settimana arriva con la fetta 2. */
export function toTask(view: TaskViewData): Task {
  codeById.set(view.id, view.code);
  return {
    id: view.id,
    code: view.code,
    projectId: view.projectId,
    title: view.title,
    description: view.description,
    statusId: view.statusId,
    departmentId: view.departmentId,
    assigneeId: view.assigneeId,
    createdById: view.createdById,
    followerIds: view.followerIds,
    size: view.size,
    dueDate: view.dueDate,
    plannedWeek: null,
    slipCount: 0,
    milestoneId: view.milestoneId,
    labels: view.labels,
    type: view.type,
    priority: view.priority,
    requestId: view.requestId,
    links: view.links,
    attachments: view.attachments,
    manualStall: view.manualStall,
    claude: view.claude,
    createdAt: view.createdAt,
    closedAt: view.closedAt,
    lastActivityAt: view.lastActivityAt,
    occurrences: view.occurrences,
    ...(view.source ? { source: view.source } : {}),
    ...(view.technical !== undefined ? { technical: view.technical } : {}),
    ...(view.assigneeStatus !== undefined ? { assigneeStatus: view.assigneeStatus } : {}),
  } as Task;
}

/** I criteri dei filtri del prototipo sono già la query di `/api/tasks`. */
export const filtersOf = (criteria?: FilterCriteria): TaskListFilters =>
  (criteria ?? {}) as TaskListFilters;

/** Il numero, senza le viste: oltre le 2000 righe il server dice `truncated`. */
export const countTasks: typeof Fake.countTasks = async (criteria) => {
  const page = await appClient().request<{ items: unknown[]; truncated?: boolean }>(
    "GET",
    `/api/tasks${taskListQuery(filtersOf(criteria))}`,
  );
  return { count: page.items.length, truncated: page.truncated === true };
};

export const listTasks: typeof Fake.listTasks = async (criteria) => {
  const filters = filtersOf(criteria);
  const page = await appClient().tasks.list(filters);
  truncatedByQuery.set(taskListQuery(filters), page.truncated === true);
  return page.items.map((v) => toTask(v as TaskViewData));
};

export const tasksTruncated: typeof Fake.tasksTruncated = (criteria) =>
  truncatedByQuery.get(taskListQuery(filtersOf(criteria))) === true;

/** Una task invisibile risponde come una che non esiste: `null` (404 `not_found`). */
export const getTaskByCode: typeof Fake.getTaskByCode = async (code) => {
  try {
    return toTask((await appClient().tasks.byCode(code.toUpperCase())) as TaskViewData);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
};

/**
 * Il motivo largo del server (`stallReasonSchema`) nel motivo stretto del
 * prototipo; `null` per un motivo che questa app non conosce (lettore:
 * `UNKNOWN`), che allora non si mostra fra le ferme.
 */
export function toStallReason(wide: {
  kind: string;
  reason?: string;
  note?: string;
  personId?: string;
  taskId?: string;
}): StallReason | null {
  switch (wide.kind) {
    case "manual":
      return { kind: "manual", reason: wide.reason ?? "", note: wide.note ?? "" };
    case "decision":
      return wide.personId ? { kind: "decision", personId: wide.personId } : null;
    case "blocked_by":
      return wide.taskId ? { kind: "blocked_by", taskId: wide.taskId } : null;
    case "claude_question":
    case "unassigned":
    case "idle":
      return { kind: wide.kind };
    default:
      return null;
  }
}

export const listStalled: typeof Fake.listStalled = async (criteria) => {
  const rows = await appClient().tasks.stalled(filtersOf(criteria));
  return rows.flatMap((row) => {
    const reason = toStallReason(row.stall.reason as Parameters<typeof toStallReason>[0]);
    if (!reason) return [];
    const stall: Stall = { reason, since: row.stall.since, days: row.stall.days };
    return [{ task: toTask(row.task as TaskViewData), stall }];
  });
};

/** I campi che `PATCH /api/tasks/:id` accetta (la settimana è della fetta 2). */
const PATCHABLE = [
  "title",
  "description",
  "statusId",
  "departmentId",
  "assigneeId",
  "size",
  "dueDate",
  "milestoneId",
  "labels",
  "type",
  "priority",
] as const;

/** Follower, ferma, allegati e collegamenti hanno scritture loro (`followTask`, `setManualStall`…). */
function serverPatch(patch: TaskPatch): Record<string, unknown> {
  const own = Object.keys(patch).filter((k) => !(PATCHABLE as readonly string[]).includes(k));
  if (own.length > 0) throw new NotIntegratedError(`updateTask(${own.join(", ")})`);
  return patch as Record<string, unknown>;
}

export const updateTask: typeof Fake.updateTask = async (id, patch) =>
  toTask((await appClient().tasks.update(id, serverPatch(patch))) as TaskViewData);

/** Tutto o niente lato server: una task non modificabile → 403 e nessuna scrittura. */
export const bulkUpdateTasks: typeof Fake.bulkUpdateTasks = async (ids, patch) => {
  const rows = await appClient().tasks.bulkUpdate(ids, serverPatch(patch) as never);
  return rows.map((v) => toTask(v as TaskViewData));
};

/**
 * «New task»: nasce nel primo reparto di chi la crea e nel primo stato
 * `todo` se non li si sceglie (lo decide il server). Una task creata qui non
 * va mai all'intake del backlog.
 */
export const createTask: typeof Fake.createTask = async (input) => {
  const view = await appClient().tasks.create({
    projectId: input.projectId,
    title: input.title,
    type: input.type ?? "activity",
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.departmentId ? { departmentId: input.departmentId } : {}),
    ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
    ...(input.size !== undefined ? { size: input.size } : {}),
    ...(input.statusId ? { statusId: input.statusId } : {}),
    ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  } as never);
  return toTask(view as TaskViewData);
};

/**
 * La task com'è adesso, dopo una scrittura che non la restituisce. Si legge
 * per codice (`GET /api/tasks/by-code/:code`): basta vederla. Una PATCH vuota
 * vorrebbe `tickets.edit`, che chi segue o carica un allegato può non avere.
 */
export const reread = async (id: string): Promise<Task> => {
  const code = codeById.get(id);
  if (!code) throw new Error("not_found");
  return toTask((await appClient().tasks.byCode(code)) as TaskViewData);
};

export const followTask: typeof Fake.followTask = async (id, follow) => {
  if (follow) await appClient().tasks.follow(id);
  else await appClient().tasks.unfollow(id);
  return reread(id);
};

export const setManualStall: typeof Fake.setManualStall = async (id, input) =>
  toTask(
    (await appClient().tasks.setManualStall(id, {
      reason: input.reason,
      ...(input.note ? { note: input.note } : {}),
    })) as TaskViewData,
  );

export const clearManualStall: typeof Fake.clearManualStall = async (id) =>
  toTask((await appClient().tasks.clearManualStall(id)) as TaskViewData);
