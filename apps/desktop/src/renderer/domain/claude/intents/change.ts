import type { ClassReason, ProposedAction, Task } from "../../../data/types";
import {
  labelled,
  named,
  resulted,
  shortWeek,
  summarized,
  type Answer,
  type ReadAction,
} from "../answers";
import type { IntentContext } from "../context";
import { findCodes, findPerson, findProject, findSize, findTitle, findWeek } from "../parse";

// Crea, assegna, pianifica (`createTask`, `updateTask`, `planTask`). Il
// motore non decide chi può: esegue la mutazione di oggi a nome di chi
// chiede, che rifiuta come a mano. Nella conversazione libera (area 10a) il
// livello dati dice la classe (`ctx.classify`): con A l'azione parte subito
// e Claude dice «fatto»; con B o C resta una PROPOSTA. Senza classe (la
// Chat) tutto resta proposta, come nell'area 4.

/**
 * La risposta secondo la classe: A esegue con la frase «fatto», le altre
 * propongono. Sopra una scheda col suo motivo Claude dice perché chiede
 * («I'm asking first: …», shape `claude-actions.md`; ruling del controller
 * (T5)); senza motivo (la Chat, o nessuna classe) la frase di sempre.
 */
export async function byClass(
  ctx: IntentContext,
  action: ProposedAction,
  done: string,
  proposed: string,
): Promise<Pick<Answer, "text" | "proposal" | "execute">> {
  const verdict = ctx.classify ? await ctx.classify([action]) : null;
  if (verdict?.cls === "A") return { text: done, execute: [action] };
  const first = verdict?.reasons[0];
  return {
    text: first
      ? ctx.t("claude.answers.classRaised", { reason: await reasonWords(ctx, first) })
      : proposed,
    proposal: [action],
  };
}

/** Il motivo di una scheda in parole (R-G5: le persone sono già solo quelle che chi chiede vede). */
async function reasonWords(ctx: IntentContext, reason: ClassReason): Promise<string> {
  const { t, read } = ctx;
  switch (reason.kind) {
    case "notifies": {
      if (reason.personIds.length === 0) return t("claude.answers.classReason.notifiesOthers");
      const people = await read.listPeople();
      const names = reason.personIds.map((id) => people.find((p) => p.id === id)?.name ?? "");
      return t("claude.answers.classReason.notifies", { names: names.join(", ") });
    }
    case "automation": {
      const project = (await read.listProjects()).find((p) => p.id === reason.projectId);
      return t("claude.answers.classReason.automation", { code: project?.code ?? "" });
    }
    case "irreversible":
      return t("claude.answers.classReason.irreversible");
    case "reauth":
      return t("claude.answers.classReason.reauth");
  }
}

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
  const summary = meta
    ? summarized(t, "claude.answers.create.summaryWithMeta", { code: project.code, title, meta })
    : summarized(t, "claude.answers.create.summary", { code: project.code, title });
  return {
    actions: [],
    refs: [{ kind: "project", id: project.id }],
    ...(await byClass(
      ctx,
      { fn: "createTask", args, ...summary },
      t("claude.answers.create.done", { title, code: project.code }),
      t("claude.answers.create.proposal", { code: project.code }),
    )),
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
  const params = { task: named(task), name: person.name };
  return {
    actions: [lookup],
    refs: [{ kind: "task", id: task.id }],
    ...(await byClass(
      ctx,
      {
        fn: "updateTask",
        args: { id: task.id, patch: { assigneeId: person.id } },
        ...summarized(t, "claude.answers.assign.summary", params),
      },
      t("claude.answers.assign.done", params),
      t("claude.answers.assign.proposal", params),
    )),
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
  const params = { task: named(task), week: shortWeek(week) };
  return {
    actions: [lookup],
    refs: [{ kind: "task", id: task.id }],
    ...(await byClass(
      ctx,
      {
        fn: "planTask",
        args: { id: task.id, plan: { assigneeId, week } },
        ...summarized(t, "claude.answers.plan.summary", { ...params, name }),
      },
      t("claude.answers.plan.done", params),
      t("claude.answers.plan.proposal", params),
    )),
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
    ...labelled(t, "claude.answers.actions.lookup", { code: ref.code }),
  };
  const task = await ctx.read.getTaskByCode(ref.code);
  if (!task) {
    return {
      answer: {
        actions: [{ ...lookup, ...resulted(t, "claude.answers.actions.notFound") }],
        text: t("claude.answers.explain.notFound", { code: ref.code }),
      },
    };
  }
  return { task, lookup };
}
