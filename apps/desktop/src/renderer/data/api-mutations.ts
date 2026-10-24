import { wouldCycle } from "../domain/decisionLog";
import { findSimilarRequest } from "../domain/requests";
import { TEMPLATE_MODULES, TEMPLATE_STATUSES } from "../domain/templates";
import { respond, type ReadApi, type T } from "../domain/claude/intents";
import i18n from "../i18n";
// Le letture servono al motore di intenti (a nome di chi conversa): si usano
// solo dentro le funzioni, quindi l'import circolare con `api.ts` è innocuo.
import * as reads from "./api";
import * as scripts from "./conversation-scripts";
import { COMMITS } from "./seed/commits";
import { TODAY } from "./seed/dates";
import { DEPARTMENTS } from "./seed/departments";
import { DOC_PAGES } from "./seed/docPages";
import { PEOPLE } from "./seed/people";
import { getSessionPersonId, setSessionPersonId } from "./session";
import {
  canSeeConversation,
  conversationPermissions,
  copy,
  currentPhase,
  eventsOf,
  familyOf,
  gate,
  hasOpenPr,
  hasRepository,
  lastEvent,
  latestRunOf,
  newId,
  runPreconditions,
  now,
  objectCodeOf,
  onStoreReset,
  pendingPlan,
  proposalExpired,
  reindex,
  state,
  visibleProjectIds,
} from "./store";
import { interruptScripts, notifyConversationChange, releaseHeld, runScript } from "./stream";
import type {
  ActivityEntry,
  Attachment,
  Conversation,
  ConversationEvent,
  DailyReport,
  DecisionDraft,
  DecisionLogEntry,
  DecisionRequest,
  HomeBlockRef,
  Milestone,
  MilestoneInput,
  MilestonePatch,
  NewProjectInput,
  NewTaskInput,
  PersonalHome,
  Project,
  ProjectRequest,
  ProjectStatus,
  ProposedAction,
  RequestLevel,
  RequestPatch,
  SavedFilter,
  ScriptStep,
  SetVisibilityResult,
  StatusFamily,
  StatusInput,
  StoredLinkKind,
  Task,
  TaskPatch,
  TaskSize,
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
    // Apre la task stessa, non solo l'elenco del progetto.
    link: `#/p/${project.code}/tasks?task=${task.code}`,
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
    source: "manual",
    occurrences: 1,
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

const STORED_LINK_KINDS: StoredLinkKind[] = ["blocks", "relates", "parent"];

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
  // Un collegamento si salva una volta, sulla task che lo tiene: niente inversi, niente sé stessa.
  const linksDiff = diffs.find((d) => d.key === "links");
  if (linksDiff) {
    const rows = linksDiff.to as Task["links"];
    const keys = rows.map((l) => `${l.kind}:${l.taskId}`);
    const ok = rows.every((l) => STORED_LINK_KINDS.includes(l.kind) && l.taskId !== task.id);
    if (!ok || new Set(keys).size !== keys.length) throw invalid("links");
    // Le righe nuove puntano a task che chi agisce vede: un'altra è «non trovata».
    // Quelle che c'erano già restano anche se oggi non le vede.
    const before = new Set((linksDiff.from as Task["links"]).map((l) => l.taskId));
    const visible = visibleProjectIds(me);
    for (const l of rows) {
      if (before.has(l.taskId)) continue;
      const other = state.tasksById.get(l.taskId);
      if (!other || !visible.has(other.projectId)) throw notFound();
    }
  }
  // Reparto e assegnatario devono esistere (la corsia «Other» della board non è un valore).
  const departmentDiff = diffs.find((d) => d.key === "departmentId");
  if (departmentDiff && !DEPARTMENTS.some((d) => d.id === departmentDiff.to)) {
    throw invalid("department");
  }
  const assigneeDiff = diffs.find((d) => d.key === "assigneeId");
  if (assigneeDiff && assigneeDiff.to !== null && !PEOPLE.some((p) => p.id === assigneeDiff.to)) {
    throw invalid("assignee");
  }
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

function updateTaskAs(me: string, id: string, patch: TaskPatch): Task {
  const task = taskFor(me, id);
  commitTaskPatch(me, task, prepareTaskPatch(me, task, patch));
  return task;
}

export async function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  const me = await gate("updateTask");
  return copy(updateTaskAs(me, id, patch));
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
  return copy(planTaskAs(me, id, plan));
}

function planTaskAs(
  me: string,
  id: string,
  plan: { assigneeId: string | null; week: string | null },
): Task {
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
      `${task.code} · ${task.title}: ${personName(me)} planned it for ${plan.week ?? "no week"}.`,
    );
  }
  return task;
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
  return copy(addCommentAs(me, taskId, body, replyToId));
}

function addCommentAs(me: string, taskId: string, body: string, replyToId?: string): ActivityEntry {
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
  return entry;
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
      `${task.code} · ${task.title}: ${personName(me)} answered your question.`,
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

interface NewRequestInput {
  projectId: string;
  title: string;
  description?: string;
  urgency?: ProjectRequest["urgency"];
}

export async function createRequest(input: NewRequestInput): Promise<ProjectRequest> {
  const me = await gate("createRequest");
  return copy(createRequestAs(me, input));
}

function createRequestAs(me: string, input: NewRequestInput): ProjectRequest {
  const project = projectFor(me, input.projectId);
  need(me, "backlog.create", project.id);
  if (!input.title.trim()) throw invalid("title");
  // Al posto dell'intake: la richiesta aperta dello stesso progetto con più parole in comune.
  const similar = findSimilarRequest(input.title, project.id, state.requests);
  // Il numero dopo il più alto del progetto: le richieste non si cancellano,
  // quindi un codice non torna mai libero.
  const last = state.requests
    .filter((r) => r.projectId === project.id)
    .reduce((m, r) => Math.max(m, Number(r.code.split("-R").at(-1)) || 0), 0);
  const request: ProjectRequest = {
    id: newId("req"),
    code: `${project.code}-R${last + 1}`,
    projectId: project.id,
    title: input.title.trim(),
    description: input.description ?? "",
    requesterIds: [me],
    status: "new",
    urgency: input.urgency ?? "medium",
    size: null,
    risk: null,
    riskNote: null,
    similarToId: similar?.id ?? null,
    mergedIntoId: null,
    taskIds: [],
    createdAt: now(),
  };
  state.requests.push(request);
  return request;
}

const LEVELS: RequestLevel[] = ["low", "medium", "high"];
const SIZES: TaskSize[] = ["XS", "S", "M", "L", "XL"];

export async function updateRequest(id: string, patch: RequestPatch): Promise<ProjectRequest> {
  const me = await gate("updateRequest");
  const request = requestFor(me, id);
  need(me, "backlog.edit", request.projectId);
  if (patch.title !== undefined && !patch.title.trim()) throw invalid("title");
  if (patch.urgency !== undefined && !LEVELS.includes(patch.urgency)) throw invalid("urgency");
  if (patch.risk != null && !LEVELS.includes(patch.risk)) throw invalid("risk");
  if (patch.size != null && !SIZES.includes(patch.size)) throw invalid("size");
  // Trasformata o archiviata, la richiesta è in sola lettura: i metadati non si cambiano più.
  const meta = (["urgency", "size", "risk", "riskNote"] as const).some(
    (k) => patch[k] !== undefined,
  );
  if (meta && (request.status === "converted" || request.status === "archived")) {
    throw invalid("status");
  }
  if (patch.title !== undefined) request.title = patch.title.trim();
  if (patch.description !== undefined) request.description = patch.description;
  if (patch.urgency !== undefined) request.urgency = patch.urgency;
  if (patch.size !== undefined) request.size = patch.size;
  if (patch.risk !== undefined) request.risk = patch.risk;
  if (patch.riskNote !== undefined)
    request.riskNote = patch.riskNote?.trim() ? patch.riskNote.trim() : null;
  return copy(request);
}

/** `id` confluisce in `intoId`: i richiedenti si uniscono senza doppioni, `id` si archivia. */
export async function mergeRequest(id: string, intoId: string): Promise<ProjectRequest> {
  const me = await gate("mergeRequest");
  const source = requestFor(me, id);
  const target = requestFor(me, intoId);
  need(me, "backlog.edit", source.projectId);
  if (source.id === target.id || source.projectId !== target.projectId) throw invalid("target");
  // Si fonde solo una richiesta ancora aperta, in una non archiviata.
  if (
    source.status === "converted" ||
    source.status === "archived" ||
    target.status === "archived"
  ) {
    throw invalid("status");
  }
  target.requesterIds = [...new Set([...target.requesterIds, ...source.requesterIds])];
  source.status = "archived";
  source.mergedIntoId = target.id;
  source.similarToId = target.id;
  closeRefineOfRequest(source.id);
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
  const request = setRequestStatus(me, id, ["new", "refining", "ready"], "archived");
  closeRefineOfRequest(request.id);
  return copy(request);
}

export async function reopenRequest(id: string): Promise<ProjectRequest> {
  const me = await gate("reopenRequest");
  const request = setRequestStatus(me, id, ["archived"], "new");
  request.mergedIntoId = null;
  return copy(request);
}

/**
 * L'«Undo» di un'archiviazione: la richiesta torna allo stato aperto che
 * aveva prima (nuova, in rifinitura, pronta), non a «nuova» come con
 * «Reopen». Solo una richiesta archiviata a mano: una fusa si riapre.
 */
export async function restoreRequest(
  id: string,
  status: "new" | "refining" | "ready",
): Promise<ProjectRequest> {
  const me = await gate("restoreRequest");
  const request = requestFor(me, id);
  need(me, "backlog.edit", request.projectId);
  if (!["new", "refining", "ready"].includes(status)) throw invalid("status");
  if (request.status !== "archived" || request.mergedIntoId !== null) throw invalid("status");
  request.status = status;
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
  const task = convertRequestAs(me, id, input);
  closeRefineOfRequest(id);
  return copy(task);
}

function convertRequestAs(
  me: string,
  id: string,
  input: Omit<NewTaskInput, "projectId" | "requestId">,
): Task {
  const request = requestFor(me, id);
  if (request.status === "converted" || request.status === "archived") throw invalid("status");
  const task = buildTask(me, { ...input, projectId: request.projectId, requestId: id });
  addTask(task);
  request.taskIds = [...request.taskIds, task.id];
  request.status = "converted";
  return task;
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
  // Chi personalizza parte da ciò che vede ora: le Home dei suoi reparti
  // sono già «viste», nella stessa scrittura (nessun avviso «è cambiata»
  // per una modifica che c'era già prima di personalizzare).
  const departmentIds = PEOPLE.find((p) => p.id === me)?.departmentIds ?? [];
  const seenDepartmentUpdates: Record<string, string> = {};
  for (const h of state.departmentHomes) {
    if (departmentIds.includes(h.departmentId)) seenDepartmentUpdates[h.departmentId] = h.updatedAt;
  }
  const home: PersonalHome = {
    personId: me,
    blocks: copy({ blocks }).blocks,
    seenDepartmentUpdates,
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
 * `reassign` — un id che resta, o la `key` di uno stato nuovo dello stesso
 * elenco. Id e chiavi ripetuti sono rifiutati. Se qualcosa non torna non si
 * scrive niente.
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
  const ids = statuses.flatMap((s) => (s.id ? [s.id] : []));
  const keptIds = new Set(ids);
  if (keptIds.size !== ids.length) throw invalid("status");
  if (ids.some((id) => !current.some((s) => s.id === id))) throw invalid("status");
  const keys = statuses.flatMap((s) => (!s.id && s.key ? [s.key] : []));
  const newKeys = new Set(keys);
  if (newKeys.size !== keys.length || keys.some((k) => keptIds.has(k))) throw invalid("status");
  const removed = current.filter((s) => !keptIds.has(s.id));
  for (const status of removed) {
    const inUse = state.tasks.some((t) => t.statusId === status.id);
    const target = reassign[status.id] ?? "";
    if (inUse && !keptIds.has(target) && !newKeys.has(target)) throw invalid("reassign");
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
  // La chiave di uno stato nuovo diventa il suo id appena creato.
  const idOfKey = new Map(
    statuses.flatMap((s, i) => (!s.id && s.key ? [[s.key, next[i]!.id] as const] : [])),
  );
  state.statuses = [...state.statuses.filter((s) => s.projectId !== projectId), ...next];
  reindex();
  for (const task of state.tasks) {
    if (task.projectId !== projectId) continue;
    const raw = reassign[task.statusId];
    const target = raw ? (idOfKey.get(raw) ?? raw) : undefined;
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

// --- registro decisioni ---------------------------------------------------------

/**
 * Registra a mano una decisione (`decisions.record`): una voce `manual`, di
 * chi la scrive, con il testo che ha scritto — nessun testo generato entra
 * qui. Se ne supera un'altra dello stesso progetto, quella resta nel
 * registro con il suo «superata da».
 */
export async function recordDecision(
  projectId: string,
  draft: DecisionDraft,
): Promise<DecisionLogEntry> {
  const me = await gate("recordDecision");
  projectFor(me, projectId);
  need(me, "decisions.record", projectId);
  if (!draft.title.trim()) throw invalid("title");
  if (!draft.decision.trim()) throw invalid("decision");
  if (draft.taskId) {
    const task = taskFor(me, draft.taskId);
    if (task.projectId !== projectId) throw invalid("task");
  }
  const superseded = draft.supersedesId
    ? state.decisionLog.find((d) => d.id === draft.supersedesId && d.projectId === projectId)
    : null;
  if (draft.supersedesId && !superseded) throw invalid("supersedes");
  const entry: DecisionLogEntry = {
    id: newId("dl"),
    projectId,
    source: "manual",
    taskId: draft.taskId ?? null,
    title: draft.title.trim(),
    context: draft.context?.trim() ? draft.context.trim() : null,
    decision: draft.decision.trim(),
    decidedById: me,
    decidedAt: now(),
    supersededById: null,
  };
  state.decisionLog.push(entry);
  if (superseded) superseded.supersededById = entry.id;
  return copy(entry);
}

/**
 * Cambia il «superata da» di una voce già nel registro (`decisions.record`):
 * un'altra voce dello stesso progetto, o `null` se vale di nuovo. Non si
 * riscrive il fatto, solo il legame: niente sé stessa, niente giri.
 */
export async function setDecisionSuperseded(
  id: string,
  supersededById: string | null,
): Promise<DecisionLogEntry> {
  const me = await gate("setDecisionSuperseded");
  const entry = state.decisionLog.find((d) => d.id === id);
  if (!entry || !visibleProjectIds(me).has(entry.projectId)) throw notFound();
  need(me, "decisions.record", entry.projectId);
  if (supersededById !== null) {
    const by = state.decisionLog.find((d) => d.id === supersededById);
    if (!by || by.projectId !== entry.projectId || by.id === id) throw invalid("supersededBy");
    if (wouldCycle(state.decisionLog, id, supersededById)) throw invalid("cycle");
  }
  entry.supersededById = supersededById;
  return copy(entry);
}

// --- traguardi --------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function milestoneFor(me: string, id: string): Milestone {
  const milestone = state.milestones.find((m) => m.id === id);
  if (!milestone || !visibleProjectIds(me).has(milestone.projectId)) throw notFound();
  return milestone;
}

function checkMilestone(input: { name?: string; dueDate?: string | null }): void {
  if (input.name !== undefined && !input.name.trim()) throw invalid("name");
  if (input.dueDate && !DATE_RE.test(input.dueDate)) throw invalid("dueDate");
}

export async function createMilestone(
  projectId: string,
  input: MilestoneInput,
): Promise<Milestone> {
  const me = await gate("createMilestone");
  projectFor(me, projectId);
  need(me, "tickets.edit", projectId);
  checkMilestone(input);
  const milestone: Milestone = {
    id: newId("ms"),
    projectId,
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    dueDate: input.dueDate || null,
    closed: false,
  };
  state.milestones.push(milestone);
  return copy(milestone);
}

/** Modifica, chiude o riapre un traguardo (`tickets.edit`). */
export async function updateMilestone(id: string, patch: MilestonePatch): Promise<Milestone> {
  const me = await gate("updateMilestone");
  const milestone = milestoneFor(me, id);
  need(me, "tickets.edit", milestone.projectId);
  checkMilestone(patch);
  if (patch.name !== undefined) milestone.name = patch.name.trim();
  if (patch.description !== undefined) milestone.description = patch.description.trim();
  if (patch.dueDate !== undefined) milestone.dueDate = patch.dueDate || null;
  if (patch.closed !== undefined) milestone.closed = patch.closed;
  return copy(milestone);
}

/** Elimina un traguardo (`tickets.edit`): le sue task restano, senza traguardo. */
export async function deleteMilestone(id: string): Promise<void> {
  const me = await gate("deleteMilestone");
  const milestone = milestoneFor(me, id);
  need(me, "tickets.edit", milestone.projectId);
  state.milestones = state.milestones.filter((m) => m.id !== id);
  for (const task of state.tasks) {
    if (task.milestoneId === id) task.milestoneId = null;
  }
}

// --- conversazioni con Claude -------------------------------------------------
//
// Ogni evento nuovo o cambiato del flusso passa da `runScript` (R-E1): la
// scrittura ne aspetta la promessa per i passi che la registrano (il
// messaggio, la risposta, la decisione, lo stato della proposta); il lavoro
// che Claude fa dopo (l'esecuzione dopo l'approvazione, una correzione) va in
// coda dietro con `follow`, e non fa fallire la scrittura. I permessi sono
// quelli del server di oggi, da `conversationPermissions` (store) o da
// `need()`: la UI legge i flag, non li deduce.

/** Chi ha già preso una risposta, una decisione o una conferma (chiave → persona). */
const claims = new Map<string, string>();
onStoreReset(() => claims.clear());

function alreadyAnswered(byId: string | undefined): Error {
  return Object.assign(new Error("already_answered"), { byId: byId ?? null });
}

const conflict = () => new Error("conflict");

function conversationFor(me: string, id: string): Conversation {
  const c = state.conversations.find((x) => x.id === id);
  if (!c || !canSeeConversation(me, c)) throw notFound();
  return c;
}

/** Una conversazione libera dell'autore: rinominare, archiviare, eliminare, pubblicare. */
function ownFreeConversation(me: string, id: string): Conversation {
  const c = conversationFor(me, id);
  if (!conversationPermissions(me, c).canManage) throw forbidden();
  return c;
}

/** Il seguito di Claude, in coda dietro ai passi della scrittura. */
function follow(conversationId: string, steps: ScriptStep[], then?: () => void): void {
  runScript(conversationId, steps)
    .then(then)
    .catch(() => undefined);
}

/**
 * Le letture del livello dati a nome di `me`, per il motore di intenti:
 * ogni lettura legge la persona della sessione in modo sincrono all'inizio
 * (in `gate`), quindi la si fissa solo per quell'istante. Un cambio di
 * «vedi come» mentre Claude risponde non gli fa leggere i dati di un altro.
 */
function readsAs(me: string): ReadApi {
  const bind =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      const previous = getSessionPersonId();
      setSessionPersonId(me);
      try {
        return fn(...args);
      } finally {
        setSessionPersonId(previous);
      }
    };
  return {
    listProjects: bind(reads.listProjects),
    listPinnedProjectIds: bind(reads.listPinnedProjectIds),
    listProjectPulses: bind(reads.listProjectPulses),
    listProjectStatuses: bind(reads.listProjectStatuses),
    getLatestBrief: bind(reads.getLatestBrief),
    listPeople: bind(reads.listPeople),
    listTasks: bind(reads.listTasks),
    getTaskByCode: bind(reads.getTaskByCode),
    getRequest: bind(reads.getRequest),
    getRequestByCode: bind(reads.getRequestByCode),
    listDecisionRequests: bind(reads.listDecisionRequests),
    listDocPages: bind(reads.listDocPages),
  };
}

/** Il titolo automatico di una libera: la prima riga della prima domanda, ~60 caratteri. */
function titleFrom(text: string, attachments: Attachment[]): string {
  const line = text.split("\n")[0]!.trim();
  if (!line) return attachments[0]?.name ?? "";
  return line.length > 60 ? `${cutAtWord(line, 59)}…` : line;
}

/** Taglia a una parola intera entro `max` caratteri (o a `max` se la parola è una sola). */
function cutAtWord(text: string, max: number): string {
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  return (space > max / 2 ? head.slice(0, space) : head).trimEnd().replace(/[,;:]$/, "");
}

/**
 * Il titolo breve che sostituisce quello automatico dopo la prima risposta:
 * la prima frase della domanda senza i convenevoli («Can you…», «Puoi…»),
 * senza il punto di domanda, al più ~44 caratteri.
 */
function shortTitleFrom(text: string, attachments: Attachment[]): string {
  const line = text.split("\n")[0]!.trim();
  if (!line) return attachments[0]?.name ?? "";
  let s = line.split(/(?<=[.?!])\s+/)[0]!;
  s = s
    .replace(/^(hi|hello|hey|ciao|buongiorno)\b[,!.]?\s*/i, "")
    .replace(/^(please\s+)?(can|could|would|will)\s+you\s+(please\s+)?/i, "")
    .replace(/^please,?\s+/i, "")
    .replace(/^(per favore,?\s+)?(mi\s+)?(puoi|potresti)\s+/i, "")
    .replace(/[?.!\s]+$/, "")
    .trim();
  if (!s) return titleFrom(text, attachments);
  if (s.length > 44) s = `${cutAtWord(s, 43)}…`;
  return s.charAt(0).toLocaleUpperCase() + s.slice(1);
}

/** I progetti che i passi di una risposta leggono o toccano: citazioni e proposte. */
function projectsOfSteps(steps: ScriptStep[]): string[] {
  const out = new Set<string>();
  const ofTask = (id: unknown) => state.tasksById.get(id as string)?.projectId;
  const ofRequest = (id: unknown) => state.requests.find((r) => r.id === id)?.projectId;
  const add = (id: string | undefined) => {
    if (id) out.add(id);
  };
  for (const step of steps) {
    if (step.step !== "event") continue;
    const e = step.event;
    if (e.type === "citation") {
      for (const ref of e.refs) {
        if (ref.kind === "task") add(ofTask(ref.id));
        else if (ref.kind === "request") add(ofRequest(ref.id));
        else if (ref.kind === "project") add(ref.id);
        else if (ref.kind === "doc") add(DOC_PAGES.find((d) => d.id === ref.id)?.projectId);
      }
    }
    if (e.type === "proposal") {
      for (const a of e.actions) {
        add(a.args.projectId as string | undefined);
        add(ofTask(a.args.taskId) ?? ofTask(a.args.id) ?? ofRequest(a.args.id));
      }
    }
  }
  return [...out];
}

/**
 * Aggiunge i progetti toccati. Se una conversazione pubblica ne tocca uno
 * nuovo, il flusso resta privato dell'autore finché non riconferma l'elenco
 * (R-E6): la parte già pubblica resta visibile. Se il seguito è già
 * trattenuto (il turno in corso) resta da lì; altrimenti diventa privato da
 * ADESSO — mai più indietro, perché gli eventi fino a qui chi guarda li ha
 * già ricevuti.
 */
function touchProjects(c: Conversation, projectIds: string[]): boolean {
  const fresh = projectIds.filter((id) => !c.touchedProjectIds.includes(id));
  if (fresh.length === 0) return false;
  c.touchedProjectIds = [...c.touchedProjectIds, ...fresh];
  if (c.visibility === "public" && c.privateFromIndex === null) {
    c.privateFromIndex = eventsOf(c.id).length;
  }
  notifyConversationChange(c.id);
  return true;
}

/** I turni della conversazione libera, uno alla volta (R-E8). */
const turns = new Map<string, Promise<unknown>>();
/** Per conversazione libera: cambia a ogni «Ferma»; i turni accodati prima non rispondono. */
const freeCuts = new Map<string, number>();
/** Le libere in cui un turno sta scrivendo la risposta (e lo stream va interrotto). */
const replying = new Set<string>();
onStoreReset(() => {
  turns.clear();
  freeCuts.clear();
  replying.clear();
});
const freeCut = (id: string) => freeCuts.get(id) ?? 0;

/**
 * Esegue un turno dopo quelli già in coda nella stessa conversazione:
 * Claude risponde a un messaggio alla volta, e il messaggio dopo aspetta
 * (la sua scrittura resta in corso) finché il precedente non ha la risposta.
 */
function inTurn<R>(conversationId: string, turn: () => Promise<R>): Promise<R> {
  const previous = turns.get(conversationId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(turn);
  turns.set(conversationId, next);
  return next;
}

/** Il seguito trattenuto in via provvisoria è pubblico: si consegna a chi guarda. */
function releaseHold(c: Conversation, fromIndex: number): void {
  if (c.privateFromIndex !== fromIndex) return;
  c.privateFromIndex = null;
  releaseHeld(c.id, fromIndex);
  notifyConversationChange(c.id);
}

/**
 * Il gate del piano quando arriva: senza gate se chi ha avviato ha
 * `plans.approve`; approvato in anticipo se qualcuno l'ha fatto; altrimenti
 * aspetta l'approvazione. Si calcola quando il piano arriva, non prima.
 */
function planGateFor(c: Conversation, task: Task): scripts.PlanGate {
  if (can(viewerFor(c.ownerId), "plans.approve", task.projectId)) {
    return { status: "approved", by: c.ownerId };
  }
  const by = state.preApprovedPlans.get(c.id);
  return by ? { status: "pre_approved", by } : { status: "awaiting", by: c.ownerId };
}

/**
 * Claude riprende il lavoro dalla fase in cui era, fino a uno stato
 * coerente (in attesa dell'approvazione, o concluso): dopo una risposta, un
 * messaggio che riprende una pausa, «Ferma e scrivi».
 */
function continueWork(c: Conversation, task: Task, ack: string): void {
  const phase = currentPhase(eventsOf(c.id));
  const software = hasRepository(task.projectId);
  if (phase === "plan") {
    follow(c.id, [{ step: "say", text: ack }], () =>
      follow(c.id, scripts.planGate(task, planGateFor(c, task), software)),
    );
    return;
  }
  follow(c.id, scripts.resume(task, phase, ack, software));
}

/** Il piano che Claude scrive nel refine quando la richiesta non ne ha uno (mai approvato). */
const REFINE_PLAN = [
  "1. Write down the behaviour agreed in the design, with its edge cases.",
  "2. Change what it touches, behind a setting where it makes sense.",
  "3. Cover the new behaviour with tests.",
  "4. Tell the people who asked when it is ready to try.",
].join("\n");

/**
 * La risposta di Claude in un refine: scrive nel design il punto appena
 * detto, poi la stima se manca o il piano se manca, e torna ad aspettare.
 * Ogni scrittura è una riga già eseguita che porta i campi che cambia
 * (`requestPatch`): il motore dello stream li applica alla richiesta nello
 * stesso passo. Si costruisce dopo il turno di prima (la coda è seriale),
 * quindi parte dal design già scritto.
 */
function refineReply(c: Conversation, said: string): ScriptStep[] {
  const request = state.requests.find((r) => r.id === c.requestId);
  const code = request?.code ?? objectCodeOf(c) ?? "";
  const point = said.replace(/\s+/g, " ").trim().slice(0, 200);
  const design = [request?.design?.trim(), point ? `- ${point}` : ""].filter(Boolean).join("\n");
  const steps: ScriptStep[] = [
    { step: "state", state: "working" },
    { step: "deliver" },
    { step: "action", tool: "stubwise.set_design", label: `Updates the design of ${code}` },
    {
      step: "event",
      event: {
        type: "work_result",
        kind: "design_updated",
        text: `Updated the design of ${code}`,
        requestPatch: { design },
      },
    },
  ];
  let tail = "Anything else?";
  if (request && !request.size) {
    const risk = request.risk ?? "low";
    steps.push(
      { step: "action", tool: "stubwise.set_metadata", label: `Estimates ${code}` },
      {
        step: "event",
        event: {
          type: "work_result",
          kind: "estimate_updated",
          text: `Updated the size of ${code} · M`,
          requestPatch: { size: "M", risk },
        },
      },
    );
    tail = "I sized it M. Anything else?";
  } else if (request && !request.plan?.trim()) {
    steps.push(
      { step: "action", tool: "stubwise.set_plan", label: `Writes the plan of ${code}` },
      {
        step: "event",
        event: {
          type: "work_result",
          kind: "plan_updated",
          text: `Updated the plan of ${code}`,
          requestPatch: { plan: REFINE_PLAN },
        },
      },
    );
    tail = "I wrote a first plan: it is not approved, it is a starting point. Anything else?";
  }
  steps.push(
    { step: "say", text: `I have added it to the design of ${code}. ${tail}` },
    { step: "state", state: "idle" },
  );
  return steps;
}

function newConversation(
  me: string,
  fields: Pick<Conversation, "kind" | "title"> & Partial<Conversation>,
): Conversation {
  const at = now();
  const c: Conversation = {
    id: newId("cv"),
    ownerId: me,
    projectId: null,
    contextProjectId: null,
    taskId: null,
    requestId: null,
    state: "idle",
    outcome: null,
    visibility: fields.kind === "free" ? "private" : "project",
    publishedAt: null,
    publishedById: null,
    touchedProjectIds: [],
    privateFromIndex: null,
    publishedProjectIds: [],
    continuesFromId: null,
    createdAt: at,
    updatedAt: at,
    archived: false,
    ...fields,
  };
  state.conversations.push(c);
  state.conversationEvents.set(c.id, []);
  notifyConversationChange(c.id);
  return c;
}

/** Una conversazione libera nuova, con un contesto di progetto facoltativo (visibile). */
export async function createConversation(
  input: { contextProjectId?: string | null } = {},
): Promise<Conversation> {
  const me = await gate("createConversation");
  const contextProjectId = input.contextProjectId ?? null;
  if (contextProjectId !== null) projectFor(me, contextProjectId);
  return copy(newConversation(me, { kind: "free", title: "", contextProjectId }));
}

/**
 * Scrive in una conversazione (`canWrite`). Nella libera Claude risponde col
 * motore di intenti, leggendo come chi scrive; in una sessione di lavoro il
 * messaggio entra nel turno (in attesa → consegnato). In una pubblica di un
 * altro non si scrive: si continua (`continueConversation`).
 */
export async function sendMessage(
  id: string,
  message: { text: string; attachments?: Attachment[] },
): Promise<void> {
  // Finché l'invio è in viaggio la conversazione conta come «con un
  // messaggio» negli elenchi (una nuova, vuota, non si nasconde a metà).
  const sendingTo = state.sendingTo;
  sendingTo.set(id, (sendingTo.get(id) ?? 0) + 1);
  try {
    await sendMessageNow(id, message);
  } finally {
    const left = (sendingTo.get(id) ?? 1) - 1;
    if (left > 0) sendingTo.set(id, left);
    else sendingTo.delete(id);
  }
}

async function sendMessageNow(
  id: string,
  message: { text: string; attachments?: Attachment[] },
): Promise<void> {
  const me = await gate("sendMessage");
  const c = conversationFor(me, id);
  if (!conversationPermissions(me, c).canWrite) throw forbidden();
  const text = message.text.trim();
  const attachments = (message.attachments ?? []).map(copy);
  if (!text && attachments.length === 0) throw invalid("text");
  const user: ScriptStep = {
    step: "event",
    event: { type: "user", authorId: me, text, attachments, delivery: "pending" },
  };

  if (c.kind === "free") {
    await sendFree(me, c, text, attachments);
    return;
  }

  const resuming = c.state === "paused";
  await runScript(id, [user]);
  if (c.kind === "refine") {
    await runScript(id, refineReply(c, text));
    return;
  }
  const task = c.taskId ? state.tasksById.get(c.taskId) : undefined;
  if (resuming && task) {
    // Il messaggio riprende la pausa: Claude riparte dalla fase in cui era.
    await runScript(id, [{ step: "state", state: "working" }, { step: "deliver" }]);
    continueWork(c, task, "Got it. I am resuming from your message.");
    return;
  }
  // Al lavoro: il messaggio entra nel turno, e il lavoro in corso prosegue.
  await runScript(id, [
    { step: "deliver" },
    { step: "say", text: "Got it, I am taking it into account in this step." },
  ]);
}

function stopSteps(me: string, c: Conversation): ScriptStep[] {
  return [
    { step: "finish_action", outcome: "failed", result: "Stopped" },
    {
      step: "event",
      event: {
        type: "phase",
        phase: currentPhase(eventsOf(c.id)) ?? "execution",
        outcome: "stopped",
        stoppedById: me,
      },
    },
    { step: "state", state: c.kind === "refine" ? "idle" : "paused" },
  ];
}

/**
 * Un turno della conversazione libera: il messaggio, la risposta del motore
 * di intenti, i passi. Gira in coda (`inTurn`), quindi nessun altro turno
 * aggiunge eventi in mezzo.
 */
async function freeTurn(
  me: string,
  c: Conversation,
  text: string,
  attachments: Attachment[],
  cut: number,
) {
  const id = c.id;
  // Nel frattempo poteva essere archiviata o eliminata.
  if (!state.conversations.includes(c) || !conversationPermissions(me, c).canWrite) {
    throw forbidden();
  }
  if (freeCut(id) !== cut) {
    // «Ferma» è arrivato mentre il messaggio aspettava il suo turno: resta
    // nel flusso (nulla di scritto si perde), non consegnato e con il motivo.
    await runScript(id, [
      {
        step: "event",
        event: {
          type: "user",
          authorId: me,
          text,
          attachments,
          delivery: "undelivered",
          undeliveredReason: i18n.t("claude.conversation.delivery.stoppedBeforeTurn"),
        },
      },
    ]);
    return;
  }
  const user: ScriptStep = {
    step: "event",
    event: { type: "user", authorId: me, text, attachments, delivery: "pending" },
  };
  const messageIndex = eventsOf(id).length;
  // Il primo turno: dopo la risposta il titolo automatico (se nessuno l'ha
  // cambiato) diventa un titolo breve.
  const firstTurn = !eventsOf(id).some((e) => e.type === "user");
  // In una pubblica non si sa ancora se il messaggio tocca un progetto
  // nuovo (lo dice la risposta): finché non lo si sa resta privato, così
  // chi guarda non lo riceve né lo legge (R-E6). Se non tocca nulla di
  // nuovo, gli eventi trattenuti si consegnano dopo.
  const held = c.visibility === "public" && c.privateFromIndex === null;
  if (held) c.privateFromIndex = messageIndex;
  let steps: ScriptStep[];
  try {
    await runScript(id, [user, { step: "state", state: "working" }]);
    steps = await respond(text, {
      personId: me,
      contextProjectId: c.contextProjectId,
      read: readsAs(me),
      t: i18n.t.bind(i18n) as T,
      seed: `${id}-${eventsOf(id).length}`,
    });
  } catch (error) {
    if (held) releaseHold(c, messageIndex);
    throw error;
  }
  if (freeCut(id) !== cut) {
    // Fermata mentre Claude pensava: il messaggio l'aveva ricevuto, la
    // risposta calcolata dopo «Ferma» non entra nel flusso.
    if (held) releaseHold(c, messageIndex);
    await runScript(id, [{ step: "deliver" }]);
    return;
  }
  const touchedNew = touchProjects(c, projectsOfSteps(steps));
  // Si consegna solo la trattenuta di QUESTO turno, se c'è ancora (una
  // riconferma nel frattempo l'ha già consegnata).
  if (held && !touchedNew) releaseHold(c, messageIndex);
  replying.add(id);
  try {
    await runScript(id, steps);
  } finally {
    replying.delete(id);
  }
  if (firstTurn && c.title === titleFrom(text, attachments)) {
    const short = shortTitleFrom(text, attachments);
    if (short && short !== c.title) {
      c.title = short;
      notifyConversationChange(id);
    }
  }
}

/**
 * «Ferma» nella libera: vale per la risposta in corso e per quelle in coda
 * (R-E8). Il taglio è subito — un turno che ha già la risposta smette di
 * scriverla, uno che la sta calcolando la butta, uno in coda non risponde —
 * mentre la fase «fermata» entra nella coda dei turni, dopo di loro: nessun
 * evento di un turno fermato può arrivare dopo.
 */
async function stopFree(me: string, c: Conversation): Promise<void> {
  freeCuts.set(c.id, freeCut(c.id) + 1);
  // Si interrompe lo stream solo se un turno sta scrivendo la risposta: il
  // messaggio di chi scrive (che entra prima) non va mai tagliato.
  if (replying.has(c.id)) interruptScripts(c.id);
  await inTurn(c.id, () =>
    runScript(c.id, [
      { step: "finish_action", outcome: "failed", result: "Stopped" },
      {
        step: "event",
        event: { type: "phase", phase: "reply", outcome: "stopped", stoppedById: me },
      },
      { step: "state", state: "idle" },
    ]),
  );
}

/** Un messaggio nella libera: un turno in coda, con il titolo dalla prima domanda. */
async function sendFree(
  me: string,
  c: Conversation,
  text: string,
  attachments: Attachment[],
): Promise<void> {
  if (!c.title) c.title = titleFrom(text, attachments);
  const cut = freeCut(c.id);
  await inTurn(c.id, () => freeTurn(me, c, text, attachments, cut));
}

/** «Ferma» (`canInterrupt`): Claude si ferma al passo in corso; la task si ferma con lui. */
export async function stop(id: string): Promise<void> {
  const me = await gate("stop");
  const c = conversationFor(me, id);
  if (!conversationPermissions(me, c).canInterrupt) throw forbidden();
  if (c.kind === "free") {
    await stopFree(me, c);
    return;
  }
  interruptScripts(id);
  await runScript(id, stopSteps(me, c));
}

/** «Ferma e scrivi» (`canInterrupt`): Claude si ferma e riparte dal messaggio. */
export async function stopAndSend(id: string, text: string): Promise<void> {
  const me = await gate("stopAndSend");
  const c = conversationFor(me, id);
  if (!conversationPermissions(me, c).canInterrupt) throw forbidden();
  if (!text.trim()) throw invalid("text");
  if (c.kind === "free") {
    // Ferma, poi un messaggio come un altro: in coda, con le regole della
    // pubblica (trattenuto finché non si sa cosa tocca).
    await stopFree(me, c);
    await sendFree(me, c, text.trim(), []);
    return;
  }
  interruptScripts(id);
  await runScript(id, [
    ...stopSteps(me, c),
    {
      step: "event",
      event: {
        type: "user",
        authorId: me,
        text: text.trim(),
        attachments: [],
        delivery: "delivered",
      },
    },
  ]);
  const task = c.taskId ? state.tasksById.get(c.taskId) : undefined;
  if (c.kind === "refine" || !task) {
    follow(id, refineReply(c, text));
    return;
  }
  await runScript(id, [{ step: "state", state: "working" }]);
  continueWork(c, task, "Stopped. I am starting again from your message.");
}

/**
 * Risponde alla domanda di Claude: il richiedente o chi ha `plans.approve`
 * nel progetto. Una seconda risposta (anche concorrente) riceve
 * `already_answered` con chi ha risposto (`byId`). La risposta va nel
 * registro decisioni con un testo fisso, mai scritto dall'AI.
 */
export async function answerQuestion(
  id: string,
  questionId: string,
  answer: { optionIndex: number | null; text: string | null },
): Promise<void> {
  const me = await gate("answerQuestion");
  const c = conversationFor(me, id);
  const question = eventsOf(id).find((e) => e.type === "question" && e.questionId === questionId);
  if (!question || question.type !== "question") throw notFound();
  const key = `question:${id}:${questionId}`;
  if (question.answer !== null || claims.has(key)) {
    throw alreadyAnswered(question.answer?.byId ?? claims.get(key));
  }
  if (!conversationPermissions(me, c).canAnswer) throw forbidden();
  const text = answer.text?.trim() || null;
  const option = answer.optionIndex === null ? undefined : question.options[answer.optionIndex];
  if (answer.optionIndex !== null && !option) throw invalid("option");
  if (!option && !text) throw invalid("answer");

  claims.set(key, me);
  const at = now();
  const label = option?.label ?? text!;
  try {
    await runScript(id, [
      {
        step: "patch",
        eventId: question.id,
        patch: {
          type: "question",
          answer: { optionIndex: answer.optionIndex, text, byId: me, at },
        },
      },
      { step: "state", state: "working" },
    ]);
  } catch (error) {
    claims.delete(key);
    throw error;
  }
  if (c.projectId !== null) {
    state.decisionLog.push({
      id: newId("dec"),
      projectId: c.projectId,
      source: "ask_user",
      taskId: c.taskId,
      title: question.text,
      context: null,
      decision: text && option ? `${option.label} — ${text}` : label,
      decidedById: me,
      decidedAt: at,
      supersededById: null,
    });
  }
  const task = c.taskId ? state.tasksById.get(c.taskId) : undefined;
  // Il gate del piano è di chi ha avviato il lavoro (o dell'anticipo), non di chi risponde.
  if (task) continueWork(c, task, `Thanks: “${label}”. Continuing from there.`);
}

/**
 * Approva o rifiuta il piano che aspetta (`plans.approve` nel progetto: il
 * primo dei due divieti dell'operatore). Approvato, Claude esegue; rifiutato
 * con indicazioni, lo riscrive; rifiutato senza, la sessione si chiude.
 */
export async function decidePlan(
  id: string,
  decision: "approve" | "reject",
  instructions?: string,
  planId?: string,
): Promise<void> {
  const me = await gate("decidePlan");
  const c = conversationFor(me, id);
  if (c.kind !== "task_run" || c.projectId === null) throw invalid("kind");
  need(me, "plans.approve", c.projectId);
  const log = eventsOf(id);
  type PlanEvent = Extract<ConversationEvent, { type: "plan" }>;
  // Il piano che chi decide ha letto (`planId`): se nel frattempo un altro
  // l'ha deciso e Claude ne ha scritto un altro, la decisione NON passa sul
  // piano nuovo, che nessuno ha ancora letto — dice chi ha deciso il suo.
  if (planId !== undefined) {
    const seen = log.find((e): e is PlanEvent => e.type === "plan" && e.id === planId);
    if (!seen) throw notFound();
    const seenKey = `plan:${id}:${seen.id}`;
    if (seen.status !== "pending" || claims.has(seenKey)) {
      throw alreadyAnswered(claims.get(seenKey) ?? seen.decidedById);
    }
  }
  const plan = pendingPlan(log);
  const key = `plan:${id}:${plan?.id ?? ""}`;
  // Deciso da un altro (anche nello stesso istante): dice chi, come per una
  // domanda già risposta. Lo stesso piano sta in conversazione e in «Decide».
  if (plan && claims.has(key)) throw alreadyAnswered(claims.get(key));
  const decided = lastEvent(log, (e): e is PlanEvent => e.type === "plan");
  if (!plan && decided?.decidedById) throw alreadyAnswered(decided.decidedById);
  if (!plan || !conversationPermissions(me, c).canDecidePlan) {
    throw invalid("status");
  }
  const task = state.tasksById.get(c.taskId!)!;
  const note = instructions?.trim() || undefined;

  claims.set(key, me);
  const patch: ScriptStep = {
    step: "patch",
    eventId: plan.id,
    patch: {
      type: "plan",
      status: decision === "approve" ? "approved" : "rejected",
      decidedById: me,
      ...(note ? { instructions: note } : {}),
    },
  };
  try {
    if (decision === "approve" || note) {
      await runScript(id, [patch, { step: "state", state: "working" }]);
    } else {
      await runScript(id, [
        patch,
        {
          step: "event",
          event: { type: "phase", phase: "plan", outcome: "stopped", stoppedById: me },
        },
        { step: "state", state: "finished", outcome: "stopped" },
      ]);
    }
  } catch (error) {
    claims.delete(key);
    throw error;
  }
  state.decisionLog.push({
    id: newId("dec"),
    projectId: c.projectId,
    source: "plan_review",
    taskId: c.taskId,
    title: `Plan of ${task.code}`,
    context: null,
    decision: decision === "approve" ? "Approved" : note ? `Rejected: ${note}` : "Rejected",
    decidedById: me,
    decidedAt: now(),
    supersededById: null,
  });
  if (decision === "approve") follow(id, scripts.execution(task, hasRepository(task.projectId)));
  else if (note) follow(id, scripts.replanning(task, note));
}

/**
 * Approva in anticipo il piano che Claude sta scrivendo (`plans.approve`):
 * arriverà già approvato e Claude proseguirà da solo. Allarga COSA si
 * approva in anticipo, mai CHI approva.
 */
export async function preApprovePlan(id: string): Promise<void> {
  const me = await gate("preApprovePlan");
  const c = conversationFor(me, id);
  if (c.kind !== "task_run" || c.projectId === null) throw invalid("kind");
  need(me, "plans.approve", c.projectId);
  if (!conversationPermissions(me, c).canPreApprovePlan) throw invalid("status");
  state.preApprovedPlans.set(id, me);
  notifyConversationChange(id);
}

/** Toglie l'approvazione in anticipo, finché il piano non è arrivato. */
export async function revokePlanApproval(id: string): Promise<void> {
  const me = await gate("revokePlanApproval");
  const c = conversationFor(me, id);
  if (c.kind !== "task_run" || c.projectId === null) throw invalid("kind");
  need(me, "plans.approve", c.projectId);
  if (!state.preApprovedPlans.has(id)) throw invalid("status");
  // Il piano è già arrivato (approvato in anticipo): non c'è più nulla da revocare.
  if (!conversationPermissions(me, c).canRevokePlanApproval) throw conflict();
  state.preApprovedPlans.delete(id);
  notifyConversationChange(id);
}

type ProposalEvent = Extract<ConversationEvent, { type: "proposal" }>;

/** La proposta della conversazione: solo per chi l'ha chiesta, ancora aperta e non scaduta. */
function openProposalFor(
  me: string,
  id: string,
  proposalId: string,
): { proposal: ProposalEvent; key: string } {
  conversationFor(me, id);
  const log = eventsOf(id);
  const index = log.findIndex((e) => e.type === "proposal" && e.proposalId === proposalId);
  const proposal = log[index];
  if (!proposal || proposal.type !== "proposal") throw notFound();
  if (proposal.requesterId !== me) throw forbidden();
  const key = `proposal:${id}:${proposalId}`;
  if (proposalExpired(log, index)) throw new Error("expired");
  if (proposal.status !== "open" || claims.has(key)) throw invalid("status");
  return { proposal, key };
}

/** L'esito di una conferma: i codici degli oggetti, o perché non è stata eseguita. */
export type ProposalOutcome =
  | { status: "confirmed"; resultCodes: string[]; runConversationIds: string[] }
  | { status: "failed"; error: string };

/**
 * Conferma una proposta di Claude: solo chi l'ha chiesta. Le azioni girano
 * in ordine con le mutazioni di oggi, a nome di chi conferma, e TUTTE o
 * NESSUNA: se una fallisce (permesso perso, oggetto cambiato o sparito) lo
 * stato torna com'era e la proposta diventa `failed` con il motivo. Le
 * esecuzioni (`startRun`) partono solo dopo che tutto il resto è riuscito.
 */
export async function confirmProposal(
  id: string,
  proposalId: string,
  options: { actionIndexes?: number[] } = {},
): Promise<ProposalOutcome> {
  const me = await gate("confirmProposal");
  const { proposal, key } = openProposalFor(me, id, proposalId);
  const chosen = selectActions(proposal.actions, options.actionIndexes);
  claims.set(key, me);
  const result = applyActions(me, chosen.actions);
  if (!result.ok) {
    const error = i18n.t(`claude.proposalFailed.${result.code}`, {
      action: chosen.actions[result.index]?.summary ?? "",
    });
    await runScript(id, [
      { step: "patch", eventId: proposal.id, patch: { type: "proposal", status: "failed", error } },
    ]);
    return { status: "failed", error };
  }
  touchProjects(state.conversations.find((c) => c.id === id)!, result.projectIds);
  await runScript(id, [
    {
      step: "patch",
      eventId: proposal.id,
      patch: {
        type: "proposal",
        status: "confirmed",
        resultCodes: result.codes,
        ...(chosen.indexes ? { confirmedActions: chosen.indexes } : {}),
      },
    },
  ]);
  const runConversationIds: string[] = [];
  for (const task of result.runs) runConversationIds.push(await launchRun(me, task));
  return { status: "confirmed", resultCodes: result.codes, runConversationIds };
}

/**
 * Le azioni scelte con «Confirm selected» (tutte, senza `indexes`). Una
 * selezione vuota, fuori elenco o con un'esecuzione che parte da una task
 * NON scelta è `invalid`: prima di toccare qualunque cosa. I riferimenti
 * `taskFromAction` si rinumerano sulla selezione.
 */
function selectActions(
  actions: ProposedAction[],
  indexes: number[] | undefined,
): { actions: ProposedAction[]; indexes: number[] | null } {
  if (indexes === undefined) return { actions, indexes: null };
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  if (sorted.length === 0 || sorted.some((i) => !Number.isInteger(i) || !actions[i])) {
    throw invalid("selection");
  }
  if (sorted.length === actions.length) return { actions, indexes: null };
  const chosen = sorted.map((i) => {
    const action = actions[i]!;
    const from = action.args.taskFromAction;
    if (typeof from !== "number") return action;
    const at = sorted.indexOf(from);
    if (at === -1) throw invalid("selection");
    return { ...action, args: { ...action.args, taskFromAction: at } };
  });
  return { actions: chosen, indexes: sorted };
}

/**
 * «Modifica» salvata: chi l'ha chiesta ha eseguito l'azione dal dialogo
 * (con la mutazione di quel dialogo, a suo nome) e la proposta si chiude
 * «Done (edited)» con i codici di ciò che è nato. I codici devono essere di
 * oggetti che vede: la proposta non può citare ciò che non esiste.
 */
export async function completeEditedProposal(
  id: string,
  proposalId: string,
  resultCodes: string[],
): Promise<void> {
  const me = await gate("completeEditedProposal");
  const { proposal, key } = openProposalFor(me, id, proposalId);
  const visible = visibleProjectIds(me);
  const known = (code: string) =>
    state.tasks.some((t) => t.code === code && visible.has(t.projectId)) ||
    state.requests.some((r) => r.code === code && visible.has(r.projectId));
  if (resultCodes.length === 0 || !resultCodes.every(known)) throw invalid("resultCodes");
  claims.set(key, me);
  await runScript(id, [
    {
      step: "patch",
      eventId: proposal.id,
      patch: { type: "proposal", status: "confirmed", edited: true, resultCodes: [...resultCodes] },
    },
  ]);
}

/**
 * Il contesto di progetto di una libera (l'autore): decide le skill di «/».
 * Un progetto che non vede è `not_found`; `null` lo toglie.
 */
export async function setConversationContext(id: string, projectId: string | null): Promise<void> {
  const me = await gate("setConversationContext");
  const c = ownFreeConversation(me, id);
  if (c.archived) throw forbidden();
  if (projectId !== null) projectFor(me, projectId);
  c.contextProjectId = projectId;
  c.updatedAt = now();
  notifyConversationChange(id);
}

type FailureCode = "forbidden" | "not_found" | "invalid" | "conflict" | "other";

type Applied =
  | { ok: true; codes: string[]; projectIds: string[]; runs: Task[] }
  | { ok: false; index: number; code: FailureCode };

/**
 * Esegue le azioni di una proposta in una volta sola e senza attese (nessun
 * altro può scrivere in mezzo): prima tiene una copia di ciò che le
 * mutazioni toccano, e al primo errore la rimette.
 */
function applyActions(me: string, actions: ProposedAction[]): Applied {
  const snapshot = structuredClone({
    tasks: state.tasks,
    activity: state.activity,
    arrangements: state.arrangements,
    notifications: state.notifications,
    requests: state.requests,
    counter: state.counter,
  });
  const created: (Task | undefined)[] = [];
  const codes: string[] = [];
  const projectIds = new Set<string>();
  const runs: Task[] = [];
  // Le richieste chiuse dalla proposta: i loro refine si chiudono solo se va tutto bene.
  const closedRequests: string[] = [];
  let index = 0;
  try {
    for (; index < actions.length; index++) {
      const { fn, args } = actions[index]!;
      let task: Task | undefined;
      let request: ProjectRequest | undefined;
      switch (fn) {
        case "createTask":
          task = buildTask(me, args as unknown as NewTaskInput);
          addTask(task);
          created[index] = task;
          break;
        case "updateTask":
          task = updateTaskAs(me, args.id as string, args.patch as TaskPatch);
          break;
        case "planTask":
          task = planTaskAs(
            me,
            args.id as string,
            args.plan as { assigneeId: string | null; week: string | null },
          );
          break;
        case "addComment":
          addCommentAs(me, args.taskId as string, args.body as string);
          task = state.tasksById.get(args.taskId as string);
          break;
        case "createRequest":
          request = createRequestAs(me, args as unknown as NewRequestInput);
          break;
        case "convertRequest":
          task = convertRequestAs(
            me,
            args.id as string,
            args.input as Omit<NewTaskInput, "projectId" | "requestId">,
          );
          created[index] = task;
          closedRequests.push(args.id as string);
          break;
        case "archiveRequest":
          request = setRequestStatus(
            me,
            args.id as string,
            ["new", "refining", "ready"],
            "archived",
          );
          closedRequests.push(request.id);
          break;
        case "startRun": {
          const from = args.taskFromAction;
          task = typeof from === "number" ? created[from] : taskFor(me, args.taskId as string);
          if (!task) throw invalid("taskFromAction");
          prepareRun(me, task, runs);
          runs.push(task);
          break;
        }
        default:
          throw invalid("fn");
      }
      const code = task?.code ?? request?.code;
      if (code && !codes.includes(code)) codes.push(code);
      const projectId = task?.projectId ?? request?.projectId;
      if (projectId) projectIds.add(projectId);
    }
  } catch (error) {
    Object.assign(state, snapshot);
    reindex();
    return { ok: false, index, code: failureCode(error) };
  }
  for (const requestId of closedRequests) closeRefineOfRequest(requestId);
  return { ok: true, codes, projectIds: [...projectIds], runs };
}

function failureCode(error: unknown): FailureCode {
  const message = error instanceof Error ? error.message : "";
  if (message === "forbidden" || message === "not_found" || message === "conflict") return message;
  return message.startsWith("invalid") ? "invalid" : "other";
}

/** Annulla una proposta (solo chi l'ha chiesta): resta leggibile come annullata. */
export async function cancelProposal(id: string, proposalId: string): Promise<void> {
  const me = await gate("cancelProposal");
  const { proposal, key } = openProposalFor(me, id, proposalId);
  claims.set(key, me);
  await runScript(id, [
    { step: "patch", eventId: proposal.id, patch: { type: "proposal", status: "cancelled" } },
  ]);
}

/**
 * «Modifica» (solo chi l'ha chiesta): gli argomenti dell'azione, per aprire
 * il dialogo della stessa azione precompilato. Non cambia la proposta: il
 * dialogo salva con la sua mutazione.
 */
export async function editProposal(
  id: string,
  proposalId: string,
  actionIndex = 0,
): Promise<{ fn: ProposedAction["fn"]; args: Record<string, unknown> }> {
  const me = await gate("editProposal");
  const { proposal } = openProposalFor(me, id, proposalId);
  const action = proposal.actions[actionIndex];
  if (!action) throw notFound();
  return { fn: action.fn, args: copy(action.args) };
}

/**
 * Rende pubblica o privata una conversazione libera (l'autore). Pubblica
 * chiede prima di confermare i progetti che Claude ha letto o toccato:
 * senza `confirmedProjectIds` uguale all'elenco di adesso risponde
 * `needs_confirmation` con l'elenco, e non cambia nulla.
 */
export async function setVisibility(
  id: string,
  visibility: "public" | "private",
  options: { confirmedProjectIds?: string[] } = {},
): Promise<SetVisibilityResult> {
  const me = await gate("setVisibility");
  const c = ownFreeConversation(me, id);
  if (visibility === "private") {
    c.visibility = "private";
    c.publishedAt = null;
    c.publishedById = null;
    c.privateFromIndex = null;
    c.publishedProjectIds = [];
  } else {
    const touched = [...new Set(c.touchedProjectIds)].sort().join();
    const confirmed = [...new Set(options.confirmedProjectIds ?? [])].sort().join();
    if (options.confirmedProjectIds === undefined || touched !== confirmed) {
      return {
        status: "needs_confirmation",
        touchedProjects: c.touchedProjectIds.flatMap((pid) => {
          const p = state.projectsById.get(pid);
          return p ? [{ id: p.id, code: p.code, name: p.name }] : [];
        }),
      };
    }
    // Riconfermare l'elenco rende pubblico anche il seguito che era privato.
    if (c.visibility !== "public" || c.privateFromIndex === null) c.publishedAt = now();
    const heldFrom = c.visibility === "public" ? c.privateFromIndex : null;
    c.visibility = "public";
    c.publishedById = me;
    c.privateFromIndex = null;
    c.publishedProjectIds = [...c.touchedProjectIds];
    // Chi sta già guardando riceve il seguito che era privato, senza
    // doversi iscrivere di nuovo.
    if (heldFrom !== null) releaseHeld(id, heldFrom);
  }
  notifyConversationChange(id);
  return { status: "done", conversation: copy(c) };
}

/**
 * Continua una conversazione pubblica di un altro: nasce una conversazione
 * privata di chi scrive, che parte da quella (`continuesFromId`). L'originale
 * non cambia; da qui Claude legge e propone come il nuovo autore.
 */
export async function continueConversation(publicId: string): Promise<Conversation> {
  const me = await gate("continueConversation");
  const origin = conversationFor(me, publicId);
  if (!conversationPermissions(me, origin).canContinue) throw invalid("not_public");
  const context =
    origin.contextProjectId !== null && visibleProjectIds(me).has(origin.contextProjectId)
      ? origin.contextProjectId
      : null;
  return copy(
    newConversation(me, {
      kind: "free",
      title: origin.title,
      contextProjectId: context,
      continuesFromId: origin.id,
    }),
  );
}

export async function renameConversation(id: string, title: string): Promise<Conversation> {
  const me = await gate("renameConversation");
  const c = ownFreeConversation(me, id);
  if (!title.trim()) throw invalid("title");
  c.title = title.trim();
  notifyConversationChange(id);
  return copy(c);
}

export async function archiveConversation(id: string, archived = true): Promise<Conversation> {
  const me = await gate("archiveConversation");
  const c = ownFreeConversation(me, id);
  c.archived = archived;
  notifyConversationChange(id);
  return copy(c);
}

export async function deleteConversation(id: string): Promise<void> {
  const me = await gate("deleteConversation");
  ownFreeConversation(me, id);
  interruptScripts(id);
  state.conversations = state.conversations.filter((c) => c.id !== id);
  state.conversationEvents.delete(id);
  notifyConversationChange(id);
}

// --- sessioni di lavoro -------------------------------------------------------

/**
 * Controlla che Claude possa partire sulla task (`runs.start`): aperta, e
 * senza un lavoro già vivo (anche fra quelli della stessa proposta). Non scrive.
 */
function prepareRun(me: string, task: Task, pending: Task[] = []): void {
  need(me, "runs.start", task.projectId);
  if (familyOf(task) === "closed") throw invalid("status");
  const live = latestRunOf(task.id);
  if ((live && live.state !== "finished") || pending.some((t) => t.id === task.id)) {
    throw conflict();
  }
}

/**
 * Apre la sessione di lavoro di una task e la fa partire: la fase del piano
 * (che la scrittura aspetta), poi in coda Claude legge e scrive il piano. Il
 * gate si decide quando il piano arriva: chi ha avviato senza `plans.approve`
 * aspetta l'approvazione, salvo un'approvazione in anticipo.
 */
async function launchRun(me: string, task: Task, instructions?: string): Promise<string> {
  const c = newConversation(me, {
    kind: "task_run",
    title: task.title,
    projectId: task.projectId,
    taskId: task.id,
    state: "working",
  });
  task.claude = "working";
  await runScript(c.id, scripts.runOpening("plan", me, instructions));
  const software = hasRepository(task.projectId);
  follow(c.id, scripts.planReading(task, software), () =>
    follow(c.id, scripts.planGate(task, planGateFor(c, task), software)),
  );
  return c.id;
}

/** «Avvia»: Claude parte sulla task (`runs.start`). Restituisce la sessione. */
export async function startRun(taskId: string): Promise<Conversation> {
  const me = await gate("startRun");
  const task = taskFor(me, taskId);
  prepareRun(me, task);
  const id = await launchRun(me, task);
  return copy(state.conversations.find((c) => c.id === id)!);
}

/**
 * «Rilancia con indicazioni» (`runs.start`): un lavoro nuovo che parte dalle
 * indicazioni. Un lavoro in pausa si chiude come fermato; uno al lavoro o in
 * attesa è un conflitto.
 */
export async function relaunchWithInstructions(
  taskId: string,
  instructions: string,
): Promise<Conversation> {
  const me = await gate("relaunchWithInstructions");
  const task = taskFor(me, taskId);
  need(me, "runs.start", task.projectId);
  if (!instructions.trim()) throw invalid("instructions");
  if (familyOf(task) === "closed") throw invalid("status");
  const previous = latestRunOf(task.id);
  if (previous && previous.state !== "finished" && previous.state !== "paused") throw conflict();
  // La PR è già mergiata: il lavoro è chiuso, non si rilancia (`runPreconditions`).
  if (!runPreconditions(task).relaunch) throw invalid("status");
  if (previous?.state === "paused") {
    interruptScripts(previous.id);
    await runScript(previous.id, [{ step: "state", state: "finished", outcome: "stopped" }]);
  }
  const id = await launchRun(me, task, instructions.trim());
  return copy(state.conversations.find((c) => c.id === id)!);
}

/**
 * «Riprendi la correzione» (`corrections.request`): la sessione in pausa
 * nella fase di correzione riparte e finisce la correzione.
 */
export async function resumeCorrection(taskId: string): Promise<Conversation> {
  const me = await gate("resumeCorrection");
  const task = taskFor(me, taskId);
  need(me, "corrections.request", task.projectId);
  const run = latestRunOf(task.id);
  if (!run || run.state !== "paused" || currentPhase(eventsOf(run.id)) !== "correction") {
    throw invalid("status");
  }
  await runScript(run.id, [
    { step: "event", event: { type: "phase", phase: "correction", outcome: null } },
    { step: "state", state: "working" },
  ]);
  follow(run.id, [
    { step: "say", text: "Resuming the correction where it stopped." },
    ...scripts.correction(task),
  ]);
  return copy(run);
}

/**
 * «Chiedi modifiche» (`corrections.request`) su una PR aperta da Claude: una
 * correzione nuova, con la richiesta come primo messaggio. Senza una PR è
 * `invalid`; con un lavoro vivo sulla task è un conflitto.
 */
export async function requestChanges(taskId: string, text: string): Promise<Conversation> {
  const me = await gate("requestChanges");
  const task = taskFor(me, taskId);
  need(me, "corrections.request", task.projectId);
  if (!text.trim()) throw invalid("text");
  if (!hasOpenPr(task)) throw invalid("no_pr");
  const live = latestRunOf(task.id);
  if (live && live.state !== "finished") throw conflict();
  const c = newConversation(me, {
    kind: "task_run",
    title: task.title,
    projectId: task.projectId,
    taskId: task.id,
    state: "working",
  });
  task.claude = "working";
  await runScript(c.id, scripts.runOpening("correction", me, text.trim()));
  follow(c.id, scripts.correction(task));
  return copy(c);
}

/**
 * «Rifinisci con Claude» (`backlog.edit`): apre la conversazione di refine
 * della richiesta (o restituisce quella già aperta) e porta la richiesta in
 * rifinitura.
 */
export async function startRefineConversation(requestId: string): Promise<Conversation> {
  const me = await gate("startRefineConversation");
  const request = requestFor(me, requestId);
  need(me, "backlog.edit", request.projectId);
  const open = state.conversations.find(
    (c) => c.kind === "refine" && c.requestId === request.id && c.state !== "finished",
  );
  if (open) return copy(open);
  if (!["new", "ready", "refining"].includes(request.status) || request.mergedIntoId !== null) {
    throw invalid("status");
  }
  request.status = "refining";
  const c = newConversation(me, {
    kind: "refine",
    title: request.title,
    projectId: request.projectId,
    requestId: request.id,
    state: "working",
  });
  await runScript(c.id, scripts.refineOpening(request.code, request.title));
  return copy(c);
}

/** «Chiudi la sessione» di refine (`backlog.edit`): la richiesta è pronta. */
export async function closeRefine(id: string): Promise<void> {
  const me = await gate("closeRefine");
  const c = conversationFor(me, id);
  if (c.kind !== "refine" || c.projectId === null) throw invalid("kind");
  need(me, "backlog.edit", c.projectId);
  if (c.state === "finished") throw invalid("status");
  interruptScripts(id);
  await runScript(id, [
    { step: "finish_action" },
    { step: "event", event: { type: "phase", phase: "refine", outcome: "ok", closedById: me } },
    { step: "state", state: "finished", outcome: "ok" },
  ]);
  const request = state.requests.find((r) => r.id === c.requestId);
  if (request?.status === "refining") request.status = "ready";
}

/**
 * Una richiesta trasformata, archiviata o fusa chiude il suo refine vivo
 * (`item_closed`, come il server): Claude smette, il flusso dice perché, e
 * la richiesta tiene ciò che era stato scritto. Lo stato passa subito a
 * concluso (nessuno scrive più nel frattempo); la riga arriva dallo stream.
 */
function closeRefineOfRequest(requestId: string): void {
  const c = state.conversations.find(
    (x) => x.kind === "refine" && x.requestId === requestId && x.state !== "finished",
  );
  if (!c) return;
  interruptScripts(c.id);
  c.state = "finished";
  c.outcome = "ok";
  void runScript(c.id, [
    { step: "finish_action", outcome: "failed", result: "Stopped" },
    {
      step: "event",
      event: { type: "phase", phase: "refine", outcome: "ok", reason: "item_closed" },
    },
    { step: "state", state: "finished", outcome: "ok" },
  ]).catch(() => undefined);
}

// --- rassegna del giorno per persona -----------------------------------------

/**
 * «Generate report» / «Retry»: (ri)genera il report giornaliero di un
 * progetto per un giorno, con lo stesso permesso del web (`settings.manage`).
 * Nel prototipo la sintesi mette in fila i riassunti generati dei commit del
 * giorno; un report fallito si sostituisce, mai uno del futuro.
 */
export async function generateDailyReport(projectId: string, date: string): Promise<DailyReport> {
  const me = await gate("generateDailyReport");
  projectFor(me, projectId);
  need(me, "settings.manage");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > TODAY) throw invalid("date");
  const summaries = COMMITS.filter(
    (c) => c.projectId === projectId && c.at.slice(0, 10) === date,
  ).map((c) => c.aiSummary);
  const report: DailyReport = {
    id: `rep-${projectId}-${date}`,
    projectId,
    date,
    summary: summaries.length > 0 ? summaries.join(" ") : i18n.t("projects.people.report.quiet"),
  };
  state.dailyReports = state.dailyReports.filter(
    (r) => !(r.projectId === projectId && r.date === date),
  );
  state.dailyReports.push(report);
  return copy(report);
}

/**
 * «Link a person»: collega un autore git non collegato a una persona; da lì i
 * suoi commit passano sotto di lei. Lo stesso permesso del web (`users.manage`).
 */
export async function linkCommitAuthor(authorName: string, personId: string): Promise<void> {
  const me = await gate("linkCommitAuthor");
  need(me, "users.manage");
  const unlinked = COMMITS.some((c) => c.authorId === null && c.authorName === authorName);
  if (!unlinked || state.commitAuthorLinks.has(authorName)) throw notFound();
  const person = PEOPLE.find((p) => p.id === personId);
  if (!person || person.isClaude) throw notFound();
  state.commitAuthorLinks.set(authorName, personId);
}
