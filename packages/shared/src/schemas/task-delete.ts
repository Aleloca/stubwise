import { z } from "zod";

/**
 * «Elimina task» (chat con Claude, fetta 3.0): ciò che il dialogo dice prima
 * di eliminare, calcolato dal SERVER (il client lo legge, non lo deduce).
 * `whoAction`: il «Who?» quando non si può per un permesso. `busy`: ciò che la
 * occupa adesso. `children`: le figlie che chi guarda vede, che restano senza
 * madre. I tipi di `busy` passano da `readerSchema` nei client.
 */
export const TASK_BUSY_REASONS = ["claude_session", "open_pr", "open_correction"] as const;
/**
 * Un oggetto con `kind` enum (aperto da `readerSchema`: un tipo nuovo arriva
 * come `UNKNOWN`) e i campi di ciascun tipo, facoltativi con default. Non una
 * `discriminatedUnion`, che `readerSchema` non attraversa (il guardiano in
 * `packages/api-client/src/reader.test.ts`). La forma sul filo è la stessa di
 * prima: additivo per i client.
 * - `claude_session`: `code` (la conversazione dell'agente, se chi guarda la vede);
 * - `open_pr`: `repo` e `number`;
 * - `open_correction`: nessun campo.
 */
export const taskBusyReasonSchema = z.object({
  kind: z.enum(TASK_BUSY_REASONS),
  code: z.string().nullable().default(null),
  repo: z.string().nullable().default(null),
  number: z.number().int().nullable().default(null),
});
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
