import type { Task } from "../../../data/types";
import { named, shortWeek, type Answer, type ReadAction } from "../answers";
import type { IntentContext } from "../context";
import { findCodes, findPerson, findProject, findSize, findTitle, findWeek } from "../parse";

// Crea, assegna, pianifica: sempre e solo PROPOSTE (`createTask`,
// `updateTask`, `planTask`). Il motore non decide chi può: la conferma
// esegue la mutazione di oggi a nome di chi conferma, che rifiuta come a mano.

/** «Crea “Titolo” in AUD [per Marco] [settimana prossima] [taglia M]». */
export async function create(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t, personId } = ctx;
  const projects = await read.listProjects();
  // Progetto, persona, settimana e taglia si cercano fuori dal titolo:
  // «Report for AUD» non crea in AUD, «Call Marco back» non assegna a Marco.
  const title = findTitle(text);
  const rest = title ? text.replace(title, " ") : text;
  const { project, named: wanted } = findProject(rest, projects, ctx.contextProjectId);
  if (wanted && !project) {
    return { actions: [], text: t("claude.answers.status.projectNotFound", { code: wanted }) };
  }
  if (!project) return { actions: [], text: t("claude.answers.create.noProject") };
  if (!title)
    return { actions: [], text: t("claude.answers.create.noTitle", { code: project.code }) };
  const person = findPerson(rest, await read.listPeople(), personId);
  const week = findWeek(rest);
  const size = findSize(rest);

  const args: Record<string, unknown> = { projectId: project.id, title };
  if (person) args.assigneeId = person.id;
  if (week) args.plannedWeek = week;
  if (size) args.size = size;
  const meta = [person?.name, week ? shortWeek(week) : null, size].filter(Boolean).join(" · ");
  const summary = t("claude.answers.create.summary", { code: project.code, title });
  return {
    actions: [],
    text: t("claude.answers.create.proposal", { code: project.code }),
    refs: [{ kind: "project", id: project.id }],
    proposal: [{ fn: "createTask", args, summary: meta ? `${summary} · ${meta}` : summary }],
  };
}

/** «Assegna AUD-3 a Marco». */
export async function assign(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t, personId } = ctx;
  const found = await taskOf(text, ctx);
  if ("answer" in found) return found.answer;
  const { task, lookup } = found;
  const people = await read.listPeople();
  const person = findPerson(text, people, personId);
  if (!person && ctx.asks) {
    // Dalla Chat: a chi chiama si chiede a chi, fra i membri del progetto
    // (non l'assegnatario di adesso, non Claude): prima chi
    // parla nel thread, poi in ordine di nome.
    const project = (await read.listProjects()).find((p) => p.id === task.projectId);
    const inThread = (name: string) =>
      ctx.thread?.some((line) => line.startsWith(`${name}:`) || line.includes(name)) ? 0 : 1;
    const options = people
      .filter((p) => !p.isClaude && p.id !== task.assigneeId && project?.memberIds.includes(p.id))
      .sort((a, b) => inThread(a.name) - inThread(b.name) || a.name.localeCompare(b.name))
      .slice(0, 4)
      .map((p) => ({ label: p.name }));
    if (options.length > 0) {
      return {
        actions: [lookup],
        text: "",
        refs: [{ kind: "task", id: task.id }],
        ask: { text: t("claude.answers.assign.ask", { task: named(task) }), options },
      };
    }
  }
  if (!person) {
    return { actions: [lookup], text: t("claude.answers.assign.noPerson", { task: named(task) }) };
  }
  return {
    actions: [lookup],
    text: t("claude.answers.assign.proposal", { task: named(task), name: person.name }),
    refs: [{ kind: "task", id: task.id }],
    proposal: [
      {
        fn: "updateTask",
        args: { id: task.id, patch: { assigneeId: person.id } },
        summary: t("claude.answers.assign.summary", { task: named(task), name: person.name }),
      },
    ],
  };
}

/** «Pianifica AUD-3 per la settimana prossima [a Marco]»: senza persona resta l'assegnatario. */
export async function plan(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t, personId } = ctx;
  const week = findWeek(text)!;
  const found = await taskOf(text, ctx);
  if ("answer" in found) return found.answer;
  const { task, lookup } = found;
  const people = await read.listPeople();
  const person = findPerson(text, people, personId);
  const assigneeId = person?.id ?? task.assigneeId;
  const name = people.find((p) => p.id === assigneeId)?.name ?? t("claude.answers.plan.nobody");
  return {
    actions: [lookup],
    text: t("claude.answers.plan.proposal", { task: named(task), week: shortWeek(week) }),
    refs: [{ kind: "task", id: task.id }],
    proposal: [
      {
        fn: "planTask",
        args: { id: task.id, plan: { assigneeId, week } },
        summary: t("claude.answers.plan.summary", {
          task: named(task),
          name,
          week: shortWeek(week),
        }),
      },
    ],
  };
}

/** La task del primo codice: la sua lettura, o la risposta «non la trovo». */
async function taskOf(
  text: string,
  ctx: IntentContext,
): Promise<{ answer: Answer } | { task: Task; lookup: ReadAction }> {
  const { t } = ctx;
  const ref = findCodes(text).find((c) => c.kind === "task");
  if (!ref) return { answer: { actions: [], text: t("claude.answers.explain.noCode") } };
  const lookup = {
    tool: "get_ticket",
    label: t("claude.answers.actions.lookup", { code: ref.code }),
  };
  const task = await ctx.read.getTaskByCode(ref.code);
  if (!task) {
    return {
      answer: {
        actions: [{ ...lookup, result: t("claude.answers.actions.notFound") }],
        text: t("claude.answers.explain.notFound", { code: ref.code }),
      },
    };
  }
  return { task, lookup };
}
