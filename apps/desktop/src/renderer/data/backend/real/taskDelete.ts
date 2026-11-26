import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import type { TaskBusyReason, TaskDeletionPreview } from "../../taskDelete";
import { appClient } from "./client";
import { forgetTaskCodes } from "./tasks";

// «Elimina task» nella build app (chat con Claude, fetta 3.0): l'anteprima e
// l'eliminazione le decide il SERVER (`/api/tasks/:id/deletion`, `DELETE
// /api/tasks/:id`): chi può, cosa la occupa, le figlie che restano. Il
// livello dati le traduce nella forma del prototipo e basta.

type ServerReason = { kind: string; code?: string | null; repo?: string | null; number?: number | null };

/** Una ragione del server nella forma del prototipo; una che questa app non conosce si scarta. */
function reasonOf(r: ServerReason): TaskBusyReason | null {
  switch (r.kind) {
    case "claude_session":
      return { kind: "claude_session", code: r.code ?? null };
    case "open_pr":
      return { kind: "open_pr", repo: r.repo ?? null, number: r.number ?? null };
    case "open_correction":
      return { kind: "open_correction" };
    default:
      return null;
  }
}

const reasonsOf = (list: readonly ServerReason[]) => list.flatMap((r) => reasonOf(r) ?? []);

/** `null` per una task invisibile o inesistente (404). */
export const getTaskDeletion: typeof Fake.getTaskDeletion = async (taskId) => {
  try {
    const p = await appClient().tasks.deletion(taskId);
    return {
      taskId: p.taskId,
      code: p.code,
      title: p.title,
      canDelete: p.canDelete,
      whoAction: p.whoAction === "__unknown__" ? "deleteTasks" : p.whoAction,
      busy: reasonsOf(p.busy as ServerReason[]),
      children: p.children,
    } satisfies TaskDeletionPreview;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
};

/** I rifiuti del server nella forma del prototipo (`TaskDeleteResult`). */
export const deleteTask: typeof Fake.deleteTask = async (taskId) => {
  try {
    await appClient().tasks.remove(taskId);
    // Il codice non si risolve più: via dalla memoria dei codici.
    forgetTaskCodes();
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) return { ok: false, error: "not_found" };
      if (error.status === 403) return { ok: false, error: "forbidden" };
      if (error.status === 409 && error.code === "busy") {
        const details = error.details as { reasons?: ServerReason[] } | undefined;
        return { ok: false, error: "busy", reasons: reasonsOf(details?.reasons ?? []) };
      }
    }
    throw error;
  }
};
