import type { ProposedAction } from "../../../data/types";
import { labelled, named, resulted, summarized, type Answer } from "../answers";
import type { IntentContext } from "../context";
import { findCodes } from "../parse";

/**
 * Il segnaposto di `startRun` dopo `convertRequest` nella stessa proposta:
 * la task non esiste ancora, la crea l'azione `taskFromAction` (indice
 * nella proposta). Chi conferma (Task 4) lo risolve con il codice nato.
 */
export interface StartRunArgs {
  taskId?: string;
  taskFromAction?: number;
}

/**
 * «Avvia <codice>»: propone l'esecuzione. Una richiesta ancora da
 * trasformare → `convertRequest` + `startRun` sulla task che nasce; una già
 * trasformata → `startRun` sulla sua task; una task → `startRun`. Mai
 * eseguito qui: solo una proposta, e il piano passa dal gate come sempre.
 */
export async function run(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t } = ctx;
  const ref = findCodes(text)[0];
  if (!ref) return { actions: [], text: t("claude.answers.run.noCode") };
  const lookup = {
    tool: ref.kind === "task" ? "get_ticket" : "get_backlog_item",
    ...labelled(t, "claude.answers.actions.lookup", { code: ref.code }),
  };
  const notFound = (): Answer => ({
    actions: [{ ...lookup, ...resulted(t, "claude.answers.actions.notFound") }],
    text: t("claude.answers.explain.notFound", { code: ref.code }),
  });

  if (ref.kind === "task") {
    const task = await read.getTaskByCode(ref.code);
    if (!task) return notFound();
    return {
      actions: [lookup],
      text: t("claude.answers.run.runTask", { task: named(task) }),
      refs: [{ kind: "task", id: task.id }],
      proposal: [
        startRun(summarized(t, "claude.answers.run.summaryRun", { task: named(task) }), {
          taskId: task.id,
        }),
      ],
    };
  }

  const request = await read.getRequestByCode(ref.code);
  if (!request) return notFound();
  const refs: Answer["refs"] = [{ kind: "request", id: request.id }];
  if (request.mergedIntoId) {
    const into = await read.getRequest(request.mergedIntoId);
    return {
      actions: [lookup],
      // Una richiesta di destinazione che non vedo non si nomina: frase a sé.
      text: into
        ? t("claude.answers.run.merged", { request: named(request), into: named(into) })
        : t("claude.answers.run.mergedHidden", { request: named(request) }),
      refs: into ? [...refs, { kind: "request", id: into.id }] : refs,
    };
  }
  if (request.status === "archived") {
    return {
      actions: [lookup],
      text: t("claude.answers.run.archived", { request: named(request) }),
      refs,
    };
  }
  if (request.status === "converted") {
    const taskId = request.taskIds[0];
    const tasks = taskId ? await read.listTasks({ projectIds: [request.projectId] }) : [];
    const task = tasks.find((x) => x.id === taskId);
    // La task nata c'è ma non la vedo: dico che la richiesta è già una task, senza nominarla.
    if (!task) {
      return {
        actions: [lookup],
        text: t("claude.answers.run.convertedHidden", { request: named(request) }),
        refs,
      };
    }
    return {
      actions: [lookup],
      text: t("claude.answers.run.runConverted", { request: named(request), task: named(task) }),
      refs: [...refs, { kind: "task", id: task.id }],
      proposal: [
        startRun(summarized(t, "claude.answers.run.summaryRun", { task: named(task) }), {
          taskId: task.id,
        }),
      ],
    };
  }

  const projects = await read.listProjects();
  const project = projects.find((p) => p.id === request.projectId);
  return {
    actions: [lookup],
    text: t("claude.answers.run.convertAndRun", {
      request: named(request),
      project: project?.code ?? "",
    }),
    refs,
    proposal: [
      {
        fn: "convertRequest",
        args: { id: request.id, input: { title: request.title } },
        ...summarized(t, "claude.answers.run.summaryConvert", {
          request: request.code,
          project: project?.code ?? "",
          title: request.title,
        }),
      },
      startRun(summarized(t, "claude.answers.run.summaryRunNew"), { taskFromAction: 0 }),
    ],
  };
}

function startRun(
  summary: Pick<ProposedAction, "summary" | "summaryText">,
  args: StartRunArgs,
): ProposedAction {
  return { fn: "startRun", args: { ...args }, ...summary };
}
