import type { ProjectRequest, Task } from "../../../data/types";
import { labelled, named, resulted, sayDate, shortWeek, type Answer } from "../answers";
import type { IntentContext } from "../context";
import { findCodes } from "../parse";

/**
 * «Spiegami <codice>»: una task o una richiesta, riassunta e citata. Un
 * codice che non esiste e uno che la persona non vede danno la stessa frase:
 * il motore non sa — e non deve far capire — quale dei due.
 */
export async function explain(text: string, ctx: IntentContext): Promise<Answer> {
  const { t } = ctx;
  const ref = findCodes(text)[0];
  if (!ref) return { actions: [], text: t("claude.answers.explain.noCode") };
  const lookup = {
    tool: ref.kind === "task" ? "get_ticket" : "get_backlog_item",
    ...labelled(t, "claude.answers.actions.lookup", { code: ref.code }),
  };
  if (ref.kind === "task") {
    const task = await ctx.read.getTaskByCode(ref.code);
    if (!task) return notFound(ctx, ref.code, lookup);
    return { actions: [lookup], ...(await describeTask(task, ctx)) };
  }
  const request = await ctx.read.getRequestByCode(ref.code);
  if (!request) return notFound(ctx, ref.code, lookup);
  return { actions: [lookup], ...(await describeRequest(request, ctx)) };
}

function notFound(ctx: IntentContext, code: string, lookup: Answer["actions"][number]): Answer {
  return {
    actions: [{ ...lookup, ...resulted(ctx.t, "claude.answers.actions.notFound") }],
    text: ctx.t("claude.answers.explain.notFound", { code }),
  };
}

async function describeTask(task: Task, ctx: IntentContext): Promise<Omit<Answer, "actions">> {
  const { read, t } = ctx;
  const [projects, statuses, people, decisions, request] = await Promise.all([
    read.listProjects(),
    read.listProjectStatuses(task.projectId),
    read.listPeople(),
    read.listDecisionRequests({ taskId: task.id, open: true }),
    task.requestId ? read.getRequest(task.requestId) : Promise.resolve(null),
  ]);
  const project = projects.find((p) => p.id === task.projectId);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const status = statuses.find((s) => s.id === task.statusId)?.name ?? "";
  const facts = [
    task.assigneeId
      ? t("claude.answers.explain.assignee", { name: names.get(task.assigneeId) ?? "" })
      : t("claude.answers.explain.unassigned"),
    task.plannedWeek
      ? t("claude.answers.explain.week", { week: shortWeek(task.plannedWeek) })
      : null,
    task.size ? t("claude.answers.explain.size", { size: task.size }) : null,
    task.dueDate ? t("claude.answers.explain.due", { date: sayDate(t, task.dueDate) }) : null,
    request ? t("claude.answers.explain.fromRequest", { request: named(request) }) : null,
    decisions.length > 0
      ? t("claude.answers.explain.decisions", { count: decisions.length })
      : null,
    task.claude !== "none" ? t(`claude.answers.explain.claude.${task.claude}`) : null,
  ].filter((f): f is string => f !== null);
  const text = [
    t("claude.answers.explain.task", {
      task: named(task),
      type: t(`claude.answers.explain.type.${task.type}`),
      project: project ? `${project.code} ${project.name}` : "",
      status,
    }),
    "",
    ...facts.map((f) => `- ${f}`),
    "",
    `> ${task.description}`,
  ].join("\n");
  const refs: Answer["refs"] = [{ kind: "task", id: task.id }];
  if (request) refs.push({ kind: "request", id: request.id });
  return { text, refs };
}

async function describeRequest(
  request: ProjectRequest,
  ctx: IntentContext,
): Promise<Omit<Answer, "actions">> {
  const { read, t } = ctx;
  const [projects, people, tasks] = await Promise.all([
    read.listProjects(),
    read.listPeople(),
    read.listTasks({ projectIds: [request.projectId] }),
  ]);
  const project = projects.find((p) => p.id === request.projectId);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const born = tasks.filter((task) => request.taskIds.includes(task.id));
  const facts = [
    t("claude.answers.explain.requesters", {
      names: request.requesterIds.map((id) => names.get(id) ?? "").join(", "),
    }),
    t("claude.answers.explain.urgency", {
      level: t(`claude.answers.explain.level.${request.urgency}`),
    }),
    request.size ? t("claude.answers.explain.size", { size: request.size }) : null,
    born.length > 0
      ? t("claude.answers.explain.tasks", { tasks: born.map(named).join(", ") })
      : null,
  ].filter((f): f is string => f !== null);
  const text = [
    t("claude.answers.explain.request", {
      request: named(request),
      project: project ? `${project.code} ${project.name}` : "",
      status: t(`claude.answers.explain.requestStatus.${request.status}`),
    }),
    "",
    ...facts.map((f) => `- ${f}`),
    "",
    `> ${request.description}`,
  ].join("\n");
  return {
    text,
    refs: [
      { kind: "request", id: request.id },
      ...born.map((task) => ({ kind: "task" as const, id: task.id })),
    ],
  };
}
