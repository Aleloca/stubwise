import { TEMPLATE_MODULES, TEMPLATE_STATUSES } from "../domain/templates";
import { DEPARTMENTS } from "./seed/departments";
import { PEOPLE } from "./seed/people";
import { copy, familyOf, gate, newId, now, reindex, state, visibleProjectIds } from "./store";
import type {
  ActivityEntry,
  DecisionRequest,
  HomeBlockRef,
  NewProjectInput,
  NewTaskInput,
  PersonalHome,
  Project,
  ProjectRequest,
  ProjectStatus,
  SavedFilter,
  StatusFamily,
  StatusInput,
  Task,
  TaskPatch,
} from "./types";
import { can, canInDepartment, grantProjectRole, viewerFor, type Permission } from "./viewer";

// Le scritture del «server» finto. Ognuna passa da `gate()` (quindi `failNext`
// la fa fallire), legge chi agisce dalla sessione e verifica il permesso come
// farebbe il server — con `can()` sul viewer della persona, non fidandosi
// della UI — rifiutando con `Error("forbidden")`. Un oggetto che la persona
// non vede è `Error("not_found")`. Ogni controllo precede ogni scrittura:
// dopo un rifiuto lo stato è intatto.

const forbidden = () => new Error("forbidden");
const notFound = () => new Error("not_found");
const invalid = (what: string) => new Error(`invalid: ${what}`);

function need(me: string, perm: Permission, projectId?: string): void {
  if (!can(viewerFor(me), perm, projectId)) throw forbidden();
}

const isFullAdmin = (me: string) =>
  viewerFor(me).instancePermissions.includes("instance.full_admin");

function taskFor(me: string, id: string): Task {
  const task = state.tasksById.get(id);
  if (!task || !visibleProjectIds(me).has(task.projectId)) throw notFound();
  return task;
}

function requestFor(me: string, id: string): ProjectRequest {
  const request = state.requests.find((r) => r.id === id);
  if (!request || !visibleProjectIds(me).has(request.projectId)) throw notFound();
  return request;
}

function filterFor(me: string, id: string): SavedFilter {
  const filter = state.filters.find((f) => f.id === id);
  if (!filter || (filter.visibility !== "public" && filter.ownerId !== me)) throw notFound();
  return filter;
}

function projectFor(me: string, id: string): Project {
  const project = state.projectsById.get(id);
  if (!project || !visibleProjectIds(me).has(id)) throw notFound();
  return project;
}

function publish(kind: string, task: Task, recipientId: string, title: string, body: string): void {
  const project = state.projectsById.get(task.projectId)!;
  state.notifications.push({
    id: newId("n"),
    kind,
    projectId: task.projectId,
    objectCode: task.code,
    departmentId: task.departmentId,
    recipientIds: [recipientId],
    title,
    body,
    createdAt: now(),
    read: false,
    archived: false,
    snoozedUntil: null,
    link: `#/p/${project.code}/tasks`,
  });
}

const personName = (id: string | null) => PEOPLE.find((p) => p.id === id)?.name ?? null;

// --- task -------------------------------------------------------------------

function buildTask(me: string, input: NewTaskInput): Task {
  const project = projectFor(me, input.projectId);
  need(me, "tickets.create", project.id);
  if (!input.title.trim()) throw invalid("title");
  const statuses = state.statuses
    .filter((s) => s.projectId === project.id)
    .sort((a, b) => a.order - b.order);
  const status = input.statusId
    ? statuses.find((s) => s.id === input.statusId)
    : statuses.find((s) => s.family === "todo");
  if (!status) throw invalid("status");
  const departmentId =
    input.departmentId ?? PEOPLE.find((p) => p.id === me)?.departmentIds[0] ?? DEPARTMENTS[0]!.id;
  const max = state.tasks
    .filter((t) => t.projectId === project.id)
    .reduce((m, t) => Math.max(m, Number(t.code.split("-").at(-1)) || 0), 0);
  const n = max + 1;
  const at = now();
  return {
    id: `t-${project.code.toLowerCase()}-${n}`,
    code: `${project.code}-${n}`,
    projectId: project.id,
    title: input.title.trim(),
    description: input.description ?? "",
    statusId: status.id,
    departmentId,
    assigneeId: input.assigneeId ?? null,
    createdById: me,
    followerIds: [me],
    size: input.size ?? null,
    dueDate: input.dueDate ?? null,
    plannedWeek: input.plannedWeek ?? null,
    slipCount: 0,
    milestoneId: input.milestoneId ?? null,
    labels: input.labels ?? [],
    type: input.type ?? "activity",
    priority: input.priority ?? "medium",
    requestId: input.requestId ?? null,
    links: [],
    attachments: [],
    manualStall: null,
    claude: "none",
    createdAt: at,
    closedAt: status.family === "closed" ? at : null,
    lastActivityAt: at,
  };
}

function addTask(task: Task): void {
  state.tasks.push(task);
  reindex();
}

export async function createTask(input: NewTaskInput): Promise<Task> {
  const me = await gate("createTask");
  const task = buildTask(me, input);
  addTask(task);
  return copy(task);
}

/** Il nome del campo come lo mostra la cronologia (lo stesso del seed). */
const FIELD_LABEL: Partial<Record<keyof TaskPatch, string>> = {
  statusId: "status",
  departmentId: "department",
  assigneeId: "assignee",
  dueDate: "due",
  plannedWeek: "week",
  milestoneId: "milestone",
};

function describeValue(key: keyof TaskPatch, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (key) {
    case "statusId":
      return state.statusById.get(value as string)?.name ?? String(value);
    case "departmentId":
      return DEPARTMENTS.find((d) => d.id === value)?.name ?? String(value);
    case "assigneeId":
      return personName(value as string) ?? String(value);
    case "milestoneId":
      return state.milestones.find((m) => m.id === value)?.name ?? String(value);
    case "labels":
    case "followerIds":
      return (value as string[]).join(", ");
    case "links":
      return (value as Task["links"]).map((l) => `${l.kind}:${l.taskId}`).join(", ");
    case "attachments":
      return (value as Task["attachments"]).map((a) => a.name).join(", ");
    case "manualStall":
      return (value as NonNullable<Task["manualStall"]>).reason;
    default:
      return String(value);
  }
}

interface Diff {
  key: keyof TaskPatch;
  from: unknown;
  to: unknown;
}

/** Controlla chi può cambiare cosa e ricava i campi che cambiano davvero; non scrive. */
function prepareTaskPatch(me: string, task: Task, patch: TaskPatch): Diff[] {
  const keys = (Object.keys(patch) as (keyof TaskPatch)[]).filter((k) => patch[k] !== undefined);
  const diffs: Diff[] = keys
    .filter((k) => JSON.stringify(task[k]) !== JSON.stringify(patch[k]))
    .map((key) => ({ key, from: task[key], to: patch[key] }));
  // Seguire sé stessi (o smettere) è di chiunque veda la task; il resto è `tickets.edit`.
  const followOnly =
    diffs.every((d) => d.key === "followerIds") &&
    diffs.every((d) => {
      const before = new Set(d.from as string[]);
      const after = new Set(d.to as string[]);
      const changed = [...before, ...after].filter((id) => before.has(id) !== after.has(id));
      return changed.every((id) => id === me);
    });
  if (!followOnly) need(me, "tickets.edit", task.projectId);
  const statusDiff = diffs.find((d) => d.key === "statusId");
  if (statusDiff) {
    const status = state.statusById.get(statusDiff.to as string);
    if (!status || status.projectId !== task.projectId) throw invalid("status");
  }
  return diffs;
}

function commitTaskPatch(me: string, task: Task, diffs: Diff[]): void {
  if (diffs.length === 0) return;
  const at = now();
  const oldFamily = familyOf(task);
  for (const { key, from, to } of diffs) {
    state.activity.push({
      id: newId("act"),
      taskId: task.id,
      kind: "field_change",
      authorId: me,
      at,
      field: FIELD_LABEL[key] ?? key,
      from: describeValue(key, from),
      to: describeValue(key, to),
    });
    (task as unknown as Record<string, unknown>)[key] = structuredClone(to);
  }
  task.lastActivityAt = at;
  setClosedAt(task, oldFamily, at);
  // Le sistemazioni nei giorni valevano per quella settimana e quell'assegnatario.
  if (diffs.some((d) => d.key === "plannedWeek" || d.key === "assigneeId")) {
    state.arrangements = state.arrangements.filter((a) => a.taskId !== task.id);
  }
}

/** Passare a una famiglia `closed` imposta `closedAt`, uscirne lo azzera. */
function setClosedAt(task: Task, oldFamily: StatusFamily, at: string): void {
  const newFamily = familyOf(task);
  if (newFamily === "closed" && oldFamily !== "closed") task.closedAt = at;
  else if (newFamily !== "closed") task.closedAt = null;
}

export async function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  const me = await gate("updateTask");
  const task = taskFor(me, id);
  commitTaskPatch(me, task, prepareTaskPatch(me, task, patch));
  return copy(task);
}

/** Tutto o niente: si controllano tutte prima di scriverne una. */
export async function bulkUpdateTasks(ids: string[], patch: TaskPatch): Promise<Task[]> {
  const me = await gate("bulkUpdateTasks");
  const tasks = [...new Set(ids)].map((id) => taskFor(me, id));
  const prepared = tasks.map((task) => ({ task, diffs: prepareTaskPatch(me, task, patch) }));
  for (const { task, diffs } of prepared) commitTaskPatch(me, task, diffs);
  return tasks.map(copy);
}

/**
 * Pianifica una task: chi ha `planning.others` nel progetto pianifica per
 * chiunque; gli altri solo per sé, e solo su una task loro o non assegnata.
 */
export async function planTask(
  id: string,
  plan: { assigneeId: string | null; week: string | null },
): Promise<Task> {
  const me = await gate("planTask");
  const task = taskFor(me, id);
  const forOthers = can(viewerFor(me), "planning.others", task.projectId);
  const members = state.projectsById.get(task.projectId)!.memberIds;
  if (forOthers) {
    if (plan.assigneeId !== null && !members.includes(plan.assigneeId)) throw invalid("assignee");
  } else {
    // Senza `planning.others` si muove solo il proprio: una task già mia (spostarla
    // o lasciarla), o una non assegnata che prendo per me con `tickets.edit`.
    const mine = task.assigneeId === me && (plan.assigneeId === me || plan.assigneeId === null);
    const take =
      task.assigneeId === null &&
      plan.assigneeId === me &&
      can(viewerFor(me), "tickets.edit", task.projectId);
    if (!mine && !take) throw forbidden();
  }
  const previousAssigneeId = task.assigneeId;
  const diffs: Diff[] = (
    [
      { key: "assigneeId", from: task.assigneeId, to: plan.assigneeId },
      { key: "plannedWeek", from: task.plannedWeek, to: plan.week },
    ] as Diff[]
  ).filter((d) => d.from !== d.to);
  commitTaskPatch(me, task, diffs);
  // Chi viene spostato è avvisato: in una riassegnazione sia chi perde la task sia chi la prende.
  const reassigned = diffs.some((d) => d.key === "assigneeId");
  const interested = new Set(
    diffs.length === 0
      ? []
      : reassigned
        ? [previousAssigneeId, plan.assigneeId]
        : [task.assigneeId],
  );
  for (const person of interested) {
    if (!person || person === me) continue;
    publish(
      "planning.changed",
      task,
      person,
      "Planning changed",
      `${personName(me)} planned ${task.code} for ${plan.week ?? "no week"}.`,
    );
  }
  return copy(task);
}

/** Il giorno della settimana in cui l'assegnatario si mette una task: personale. */
export async function setDay(
  taskId: string,
  week: string,
  day: 1 | 2 | 3 | 4 | 5 | null,
): Promise<void> {
  const me = await gate("setDay");
  const task = taskFor(me, taskId);
  if (task.assigneeId !== me) throw forbidden();
  const rest = state.arrangements.filter(
    (a) => !(a.personId === me && a.taskId === taskId && a.week === week),
  );
  state.arrangements = [...rest, { personId: me, taskId, week, day }];
}

// --- commenti ---------------------------------------------------------------

function commentFor(me: string, id: string): { entry: ActivityEntry; task: Task } {
  const entry = state.activity.find((a) => a.id === id && a.kind === "comment");
  if (!entry) throw notFound();
  return { entry, task: taskFor(me, entry.taskId) };
}

export async function addComment(
  taskId: string,
  body: string,
  replyToId?: string,
): Promise<ActivityEntry> {
  const me = await gate("addComment");
  const task = taskFor(me, taskId);
  need(me, "tickets.comment", task.projectId);
  if (!body.trim()) throw invalid("body");
  const at = now();
  const entry: ActivityEntry = {
    id: newId("act"),
    taskId,
    kind: "comment",
    authorId: me,
    at,
    body: body.trim(),
    ...(replyToId ? { replyToId } : {}),
  };
  state.activity.push(entry);
  task.lastActivityAt = at;
  return copy(entry);
}

export async function editComment(id: string, body: string): Promise<ActivityEntry> {
  const me = await gate("editComment");
  const { entry } = commentFor(me, id);
  if (entry.authorId !== me || entry.deletedAt) throw forbidden();
  if (!body.trim()) throw invalid("body");
  entry.body = body.trim();
  entry.editedAt = now();
  return copy(entry);
}

/** L'autore o chi modera; il testo sparisce dal dato (`body = ""`). */
export async function deleteComment(id: string): Promise<void> {
  const me = await gate("deleteComment");
  const { entry, task } = commentFor(me, id);
  if (entry.authorId !== me && !can(viewerFor(me), "tickets.moderate", task.projectId)) {
    throw forbidden();
  }
  entry.body = "";
  entry.deletedAt = now();
  entry.deletedById = me;
}

// --- richieste di decisione ---------------------------------------------------

export async function askDecision(input: {
  taskId: string;
  askedOfId: string;
  question: string;
  options: string[];
}): Promise<DecisionRequest> {
  const me = await gate("askDecision");
  const task = taskFor(me, input.taskId);
  need(me, "tickets.comment", task.projectId);
  if (!input.question.trim()) throw invalid("question");
  if (!state.projectsById.get(task.projectId)!.memberIds.includes(input.askedOfId)) {
    throw invalid("askedOfId");
  }
  if (
    state.decisions.some(
      (d) =>
        d.taskId === task.id &&
        d.askedOfId === input.askedOfId &&
        d.answer === null &&
        d.withdrawnAt === null,
    )
  ) {
    throw new Error("duplicate");
  }
  const at = now();
  const request: DecisionRequest = {
    id: newId("dr"),
    taskId: input.taskId,
    askedById: me,
    askedOfId: input.askedOfId,
    question: input.question.trim(),
    options: input.options.map((o) => o.trim()).filter(Boolean),
    createdAt: at,
    withdrawnAt: null,
    answer: null,
  };
  state.decisions.push(request);
  task.lastActivityAt = at;
  return copy(request);
}

function decisionFor(me: string, id: string): { request: DecisionRequest; task: Task } {
  const request = state.decisions.find((d) => d.id === id);
  if (!request) throw notFound();
  return { request, task: taskFor(me, request.taskId) };
}

/** Risponde solo chi è stato interpellato; la risposta entra nell'attività e avvisa chi ha chiesto. */
export async function answerDecision(
  id: string,
  answer: { optionIndex: number } | { text: string },
): Promise<DecisionRequest> {
  const me = await gate("answerDecision");
  const { request, task } = decisionFor(me, id);
  if (request.askedOfId !== me) throw forbidden();
  if (request.answer !== null || request.withdrawnAt !== null) throw invalid("closed");
  const at = now();
  let optionIndex: number | null = null;
  let text: string | null = null;
  if ("optionIndex" in answer) {
    if (!Number.isInteger(answer.optionIndex) || !request.options[answer.optionIndex]) {
      throw invalid("optionIndex");
    }
    optionIndex = answer.optionIndex;
  } else {
    text = answer.text.trim();
    if (!text) throw invalid("text");
  }
  request.answer = { optionIndex, text, at, byId: me };
  state.activity.push({
    id: newId("act"),
    taskId: task.id,
    kind: "decision",
    authorId: me,
    at,
    decisionRequestId: request.id,
  });
  task.lastActivityAt = at;
  if (request.askedById !== me) {
    publish(
      "decision.answered",
      task,
      request.askedById,
      "Decision answered",
      `${personName(me)} answered your question on ${task.code}.`,
    );
  }
  return copy(request);
}

export async function withdrawDecision(id: string): Promise<DecisionRequest> {
  const me = await gate("withdrawDecision");
  const { request } = decisionFor(me, id);
  if (request.askedById !== me) throw forbidden();
  if (request.answer !== null || request.withdrawnAt !== null) throw invalid("closed");
  request.withdrawnAt = now();
  return copy(request);
}

// --- richieste (backlog) ------------------------------------------------------

export async function createRequest(input: {
  projectId: string;
  title: string;
  description?: string;
  urgency?: ProjectRequest["urgency"];
}): Promise<ProjectRequest> {
  const me = await gate("createRequest");
  const project = projectFor(me, input.projectId);
  need(me, "backlog.create", project.id);
  if (!input.title.trim()) throw invalid("title");
  const request: ProjectRequest = {
    id: newId("req"),
    projectId: project.id,
    title: input.title.trim(),
    description: input.description ?? "",
    requesterIds: [me],
    status: "new",
    urgency: input.urgency ?? "medium",
    similarToId: null,
    mergedIntoId: null,
    taskIds: [],
    createdAt: now(),
  };
  state.requests.push(request);
  return copy(request);
}

export async function updateRequest(
  id: string,
  patch: Partial<Pick<ProjectRequest, "title" | "description" | "urgency">>,
): Promise<ProjectRequest> {
  const me = await gate("updateRequest");
  const request = requestFor(me, id);
  need(me, "backlog.edit", request.projectId);
  if (patch.title !== undefined && !patch.title.trim()) throw invalid("title");
  if (patch.title !== undefined) request.title = patch.title.trim();
  if (patch.description !== undefined) request.description = patch.description;
  if (patch.urgency !== undefined) request.urgency = patch.urgency;
  return copy(request);
}

/** `id` confluisce in `intoId`: i richiedenti si uniscono senza doppioni, `id` si archivia. */
export async function mergeRequest(id: string, intoId: string): Promise<ProjectRequest> {
  const me = await gate("mergeRequest");
  const source = requestFor(me, id);
  const target = requestFor(me, intoId);
  need(me, "backlog.edit", source.projectId);
  if (source.id === target.id || source.projectId !== target.projectId) throw invalid("target");
  if (source.status === "converted" || target.status === "archived") throw invalid("status");
  target.requesterIds = [...new Set([...target.requesterIds, ...source.requesterIds])];
  source.status = "archived";
  source.mergedIntoId = target.id;
  source.similarToId = target.id;
  return copy(target);
}

function setRequestStatus(
  me: string,
  id: string,
  allowed: ProjectRequest["status"][],
  next: ProjectRequest["status"],
): ProjectRequest {
  const request = requestFor(me, id);
  need(me, "backlog.edit", request.projectId);
  if (!allowed.includes(request.status)) throw invalid("status");
  request.status = next;
  return request;
}

export async function archiveRequest(id: string): Promise<ProjectRequest> {
  const me = await gate("archiveRequest");
  return copy(setRequestStatus(me, id, ["new", "refining", "ready"], "archived"));
}

export async function reopenRequest(id: string): Promise<ProjectRequest> {
  const me = await gate("reopenRequest");
  const request = setRequestStatus(me, id, ["archived"], "new");
  request.mergedIntoId = null;
  return copy(request);
}

export async function startRefine(id: string): Promise<ProjectRequest> {
  const me = await gate("startRefine");
  return copy(setRequestStatus(me, id, ["new", "ready"], "refining"));
}

/** Crea la task della richiesta (stesso progetto), le collega e porta la richiesta a `converted`. */
export async function convertRequest(
  id: string,
  input: Omit<NewTaskInput, "projectId" | "requestId">,
): Promise<Task> {
  const me = await gate("convertRequest");
  const request = requestFor(me, id);
  if (request.status === "converted" || request.status === "archived") throw invalid("status");
  const task = buildTask(me, { ...input, projectId: request.projectId, requestId: id });
  addTask(task);
  request.taskIds = [...request.taskIds, task.id];
  request.status = "converted";
  return copy(task);
}

// --- filtri salvati -----------------------------------------------------------

export async function saveFilter(
  input: Pick<SavedFilter, "name" | "visibility" | "criteria" | "view" | "groupBy">,
): Promise<SavedFilter> {
  const me = await gate("saveFilter");
  if (!input.name.trim()) throw invalid("name");
  const filter: SavedFilter = {
    ...copy(input),
    name: input.name.trim(),
    id: newId("flt"),
    ownerId: me,
  };
  state.filters.push(filter);
  return copy(filter);
}

function ownedFilter(me: string, id: string): SavedFilter {
  const filter = filterFor(me, id);
  if (filter.ownerId !== me && !isFullAdmin(me)) throw forbidden();
  return filter;
}

export async function updateFilter(
  id: string,
  patch: Partial<Pick<SavedFilter, "name" | "visibility" | "criteria" | "view" | "groupBy">>,
): Promise<SavedFilter> {
  const me = await gate("updateFilter");
  const filter = ownedFilter(me, id);
  if (patch.name !== undefined && !patch.name.trim()) throw invalid("name");
  Object.assign(filter, copy(patch));
  if (patch.name !== undefined) filter.name = patch.name.trim();
  return copy(filter);
}

export async function deleteFilter(id: string): Promise<void> {
  const me = await gate("deleteFilter");
  ownedFilter(me, id);
  state.filters = state.filters.filter((f) => f.id !== id);
  for (const [personId, ids] of state.pinnedFilters) {
    state.pinnedFilters.set(
      personId,
      ids.filter((x) => x !== id),
    );
  }
}

/** Fissare un filtro è personale: non lo cambia per gli altri. */
export async function setFilterPinned(filterId: string, pinned: boolean): Promise<void> {
  const me = await gate("setFilterPinned");
  filterFor(me, filterId);
  const mine = state.pinnedFilters.get(me) ?? [];
  state.pinnedFilters.set(
    me,
    pinned ? [...new Set([...mine, filterId])] : mine.filter((id) => id !== filterId),
  );
}

// --- Home -----------------------------------------------------------------------

export async function setPersonalHome(blocks: HomeBlockRef[]): Promise<PersonalHome> {
  const me = await gate("setPersonalHome");
  const existing = state.personalHomes.find((h) => h.personId === me);
  if (existing) {
    existing.blocks = copy({ blocks }).blocks;
    return copy(existing);
  }
  const home: PersonalHome = {
    personId: me,
    blocks: copy({ blocks }).blocks,
    seenDepartmentUpdates: {},
  };
  state.personalHomes.push(home);
  return copy(home);
}

/** Torna alla Home del reparto. */
export async function resetPersonalHome(): Promise<void> {
  const me = await gate("resetPersonalHome");
  state.personalHomes = state.personalHomes.filter((h) => h.personId !== me);
}

export async function setDepartmentHome(
  departmentId: string,
  blocks: HomeBlockRef[],
): Promise<void> {
  const me = await gate("setDepartmentHome");
  if (!DEPARTMENTS.some((d) => d.id === departmentId)) throw notFound();
  if (!canInDepartment(viewerFor(me), "department.home.manage", departmentId)) throw forbidden();
  const updatedAt = now();
  const home = state.departmentHomes.find((h) => h.departmentId === departmentId);
  const next = copy({ blocks }).blocks;
  if (home) {
    home.blocks = next;
    home.updatedAt = updatedAt;
  } else {
    state.departmentHomes.push({ departmentId, blocks: next, updatedAt });
  }
}

/**
 * Chi ha la Home personalizzata ha visto l'ultima modifica di quella del
 * reparto. Chi usa quella del reparto non ha nulla da segnare.
 */
export async function markDepartmentHomeSeen(departmentId: string): Promise<void> {
  const me = await gate("markDepartmentHomeSeen");
  const personal = state.personalHomes.find((h) => h.personId === me);
  const dept = state.departmentHomes.find((h) => h.departmentId === departmentId);
  if (personal && dept) personal.seenDepartmentUpdates[departmentId] = dept.updatedAt;
}

// --- progetti ---------------------------------------------------------------------

const CODE_PATTERN = /^[A-Z]{2,4}$/;

export async function createProject(input: NewProjectInput): Promise<Project> {
  const me = await gate("createProject");
  need(me, "projects.create");
  if (!CODE_PATTERN.test(input.code)) throw invalid("code");
  if (state.projects.some((p) => p.code === input.code)) throw invalid("code_taken");
  if (!input.name.trim()) throw invalid("name");
  const id = `prj-${input.code.toLowerCase()}`;
  const project: Project = {
    id,
    code: input.code,
    name: input.name.trim(),
    kind: input.clientName ? "client" : "internal",
    template: input.template,
    modules: [...(input.modules ?? TEMPLATE_MODULES[input.template])],
    memberIds: [me],
    stallThresholds: { activeDays: 7, todoDays: 14 },
    signals: { claudeWorking: false },
  };
  if (input.clientName) project.clientName = input.clientName;
  state.projects.push(project);
  state.statuses.push(
    ...TEMPLATE_STATUSES[input.template].map((s, i) => ({
      id: `st-${input.code.toLowerCase()}-${i + 1}`,
      projectId: id,
      name: s.name,
      family: s.family,
      order: i,
    })),
  );
  reindex();
  // Chi crea il progetto ne è il project lead.
  grantProjectRole(me, id, "project_lead");
  return copy(project);
}

const FAMILIES: StatusFamily[] = ["todo", "active", "closed"];

/**
 * Sostituisce gli stati del progetto. Ogni famiglia deve restarne
 * rappresentata; le task di uno stato tolto vanno su quello indicato in
 * `reassign`. Se qualcosa non torna non si scrive niente.
 */
export async function setProjectStatuses(
  projectId: string,
  statuses: StatusInput[],
  reassign: Record<string, string>,
): Promise<ProjectStatus[]> {
  const me = await gate("setProjectStatuses");
  const project = projectFor(me, projectId);
  need(me, "project.settings.manage", projectId);
  const current = state.statuses.filter((s) => s.projectId === projectId);
  if (statuses.some((s) => !s.name.trim())) throw invalid("name");
  if (!FAMILIES.every((f) => statuses.some((s) => s.family === f))) throw invalid("family");
  const keptIds = new Set(statuses.flatMap((s) => (s.id ? [s.id] : [])));
  if ([...keptIds].some((id) => !current.some((s) => s.id === id))) throw invalid("status");
  const removed = current.filter((s) => !keptIds.has(s.id));
  for (const status of removed) {
    const inUse = state.tasks.some((t) => t.statusId === status.id);
    if (inUse && !keptIds.has(reassign[status.id] ?? "")) throw invalid("reassign");
  }

  const at = now();
  const oldFamilies = new Map(
    state.tasks.filter((t) => t.projectId === projectId).map((t) => [t.id, familyOf(t)]),
  );
  const next: ProjectStatus[] = statuses.map((s, order) => ({
    id: s.id ?? newId(`st-${project.code.toLowerCase()}`),
    projectId,
    name: s.name.trim(),
    family: s.family,
    order,
  }));
  state.statuses = [...state.statuses.filter((s) => s.projectId !== projectId), ...next];
  reindex();
  for (const task of state.tasks) {
    if (task.projectId !== projectId) continue;
    const target = reassign[task.statusId];
    if (!state.statusById.has(task.statusId) && target) task.statusId = target;
    setClosedAt(task, oldFamilies.get(task.id)!, at);
  }
  return next.map(copy);
}

export async function setStallThresholds(
  projectId: string,
  thresholds: { activeDays: number; todoDays: number },
): Promise<Project> {
  const me = await gate("setStallThresholds");
  const project = projectFor(me, projectId);
  need(me, "project.settings.manage", projectId);
  const ok = (n: number) => Number.isInteger(n) && n >= 1;
  if (!ok(thresholds.activeDays) || !ok(thresholds.todoDays)) throw invalid("thresholds");
  project.stallThresholds = { ...thresholds };
  return copy(project);
}
