import { z } from "zod";

/**
 * «Elimina task» (chat con Claude, fetta 3.0): ciò che il dialogo dice prima
 * di eliminare, calcolato dal SERVER (il client lo legge, non lo deduce).
 * `whoAction`: il «Who?» quando non si può per un permesso. `busy`: ciò che la
 * occupa adesso. `children`: le figlie che chi guarda vede, che restano senza
 * madre. I tipi di `busy` passano da `readerSchema` nei client.
 */
export const taskBusyReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claude_session"), code: z.string().nullable() }),
  z.object({ kind: z.literal("open_pr"), repo: z.string().nullable(), number: z.number().int().nullable() }),
  z.object({ kind: z.literal("open_correction") }),
]);
export type TaskBusyReasonView = z.infer<typeof taskBusyReasonSchema>;

export const taskDeletionPreviewSchema = z.object({
  taskId: z.uuid(),
  code: z.string(),
  title: z.string(),
  canDelete: z.boolean(),
  whoAction: z.enum(["editTasks", "deleteTasks"]).nullable(),
  busy: z.array(taskBusyReasonSchema).default([]),
  children: z.array(z.object({ code: z.string(), title: z.string() })).default([]),
});
export type TaskDeletionPreviewView = z.infer<typeof taskDeletionPreviewSchema>;

/** Il 409 di `DELETE /api/tasks/:id` quando la task è occupata. */
export const taskDeleteBusySchema = z.object({
  code: z.literal("busy"),
  message: z.string(),
  reasons: z.array(taskBusyReasonSchema),
});
