import { gate, state, visibleProjectIds } from "../store";
import { can } from "../viewing";
import { viewerFor } from "../viewer";

// Design e piano salvati su una task (shape `design-plan-remove.md`, DP-Q2,
// DP-Q2b, DP-Q3). Si leggono a sé, solo dalla pagina della task (sul server
// stanno nel dettaglio del ticket, fuori dagli elenchi). Li toglie chi ha
// `tickets.edit`; la descrizione resta l'originale.

export interface TaskDesignPlan {
  design: string | null;
  plan: string | null;
  /**
   * Solo nella build app, con un design attivo: il testo originale della task
   * (sul server il corpo È il design). La pagina mostra questo come
   * descrizione. Il prototipo tiene già l'originale nella task.
   */
  original?: string | null;
}

function visibleTask(me: string, taskId: string) {
  const task = state.tasksById.get(taskId);
  if (!task || !visibleProjectIds(me).has(task.projectId)) throw new Error("not_found");
  return task;
}

export async function getTaskDesignPlan(taskId: string): Promise<TaskDesignPlan> {
  const me = await gate("getTaskDesignPlan");
  visibleTask(me, taskId);
  const saved = state.taskDesigns[taskId];
  return { design: saved?.design ?? null, plan: saved?.plan ?? null };
}

async function remove(fn: "removeTaskDesign" | "removeTaskPlan", taskId: string, field: "design" | "plan") {
  const me = await gate(fn);
  const task = visibleTask(me, taskId);
  if (!can(viewerFor(me), "tickets.edit", task.projectId)) throw new Error("forbidden");
  const saved = state.taskDesigns[taskId];
  if (saved) saved[field] = null;
}

export const removeTaskDesign = (taskId: string): Promise<void> => remove("removeTaskDesign", taskId, "design");
export const removeTaskPlan = (taskId: string): Promise<void> => remove("removeTaskPlan", taskId, "plan");
