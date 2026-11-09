import { z } from "zod";
import { STATUS_FAMILIES } from "../tasks/stall.js";
import { TASK_SIZES } from "../tasks/sizes.js";
import { UI_TASK_TYPES } from "../tasks/types.js";
import { ticketPrioritySchema } from "./ticket.js";

/**
 * Contratto server → app nuova (integrazione area 2, fetta 1): le viste delle
 * task nella FORMA del prototipo (`apps/desktop/src/renderer/data/model.ts`),
 * così il renderer non le rimappa. Ogni campo che il prototipo ha e il server
 * non manda ancora è `.optional()`/`.nullable()`/`.default()`, con un test che
 * parsa una risposta senza (regola dei cambi additivi in `CLAUDE.md`).
 */

export const statusFamilySchema = z.enum(STATUS_FAMILIES);
export const taskSizeSchema = z.enum(TASK_SIZES);
export const uiTaskTypeSchema = z.enum(UI_TASK_TYPES);

export const departmentColorTokenSchema = z.enum([
  "--dept-1",
  "--dept-2",
  "--dept-3",
  "--dept-4",
  "--dept-5",
  "--dept-6",
  "--dept-7",
  "--dept-8",
]);

export const departmentViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  colorToken: departmentColorTokenSchema,
  isDefault: z.boolean(),
});
export type DepartmentView = z.infer<typeof departmentViewSchema>;

export const personViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  initials: z.string(),
  departmentIds: z.array(z.string().uuid()),
  email: z.string(),
  deactivated: z.boolean().default(false),
});
export type PersonView = z.infer<typeof personViewSchema>;

export const projectStatusViewSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  family: statusFamilySchema,
  position: z.number().int(),
});
export type ProjectStatusView = z.infer<typeof projectStatusViewSchema>;

export const claudeWorkStateSchema = z.enum([
  "none",
  "working",
  "awaiting_answer",
  "awaiting_approval",
  "stopped",
  "done",
  "waiting",
]);
export type ClaudeWorkStateView = z.infer<typeof claudeWorkStateSchema>;

export const taskSourceSchema = z.enum([
  "manual",
  "sdk",
  "api",
  "slack",
  "webhook",
  "widget",
  "email",
  "automation",
  "server",
]);

export const storedLinkKindSchema = z.enum(["blocks", "relates", "parent"]);

export const taskViewSchema = z.object({
  id: z.string().uuid(),
  /** Lo stesso id del ticket: il prototipo lo chiama `id`, il web `ticketId`. */
  ticketId: z.string().uuid(),
  number: z.number().int(),
  /** `<CODICE>-<number>` */
  code: z.string(),
  projectId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  statusId: z.string().uuid(),
  departmentId: z.string().uuid(),
  /** Mai Claude in questa fetta. */
  assigneeId: z.string().uuid().nullable(),
  /** Chi l'ha creata; null per una task senza autore umano (SDK, posta…) o un utente eliminato. */
  createdById: z.string().uuid().nullable(),
  followerIds: z.array(z.string().uuid()).default([]),
  size: taskSizeSchema.nullable(),
  dueDate: z.string().nullable().default(null),
  /** Fetta 2. */
  plannedWeek: z.string().nullable().default(null),
  /** Fetta 2. */
  slipCount: z.number().int().default(0),
  milestoneId: z.string().uuid().nullable(),
  labels: z.array(z.string()).default([]),
  type: uiTaskTypeSchema,
  priority: ticketPrioritySchema,
  requestId: z.string().uuid().nullable().default(null),
  links: z.array(z.object({ kind: storedLinkKindSchema, taskId: z.string().uuid() })).default([]),
  attachments: z
    .array(z.object({ id: z.string().uuid(), name: z.string(), sizeBytes: z.number().int() }))
    .default([]),
  manualStall: z
    .object({ reason: z.string(), note: z.string(), since: z.string(), byId: z.string().uuid().nullable() })
    .nullable()
    .default(null),
  claude: claudeWorkStateSchema.default("none"),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  lastActivityAt: z.string(),
  source: taskSourceSchema.optional(),
  occurrences: z.number().int().default(1),
  technical: z.record(z.string(), z.string()).nullable().optional(),
  assigneeStatus: z.enum(["active", "deactivated"]).nullable().optional(),
});
export type TaskViewData = z.infer<typeof taskViewSchema>;

export const taskListResponseSchema = z.object({
  items: z.array(taskViewSchema),
  /** Oltre il tetto (2000 righe) l'elenco è tagliato. */
  truncated: z.boolean().default(false),
});

export const stallReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), reason: z.string(), note: z.string() }),
  z.object({ kind: z.literal("decision"), personId: z.string() }),
  z.object({ kind: z.literal("claude_question") }),
  z.object({ kind: z.literal("blocked_by"), taskId: z.string() }),
  z.object({ kind: z.literal("unassigned") }),
  z.object({ kind: z.literal("idle") }),
]);

export const stallSchema = z.object({
  reason: stallReasonSchema,
  since: z.string(),
  days: z.number().int(),
});

export const taskStallViewSchema = z.object({ taskId: z.string().uuid(), stall: stallSchema });
export const stalledTaskViewSchema = z.object({ task: taskViewSchema, stall: stallSchema });

export const decisionRequestViewSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  /** null se chi ha chiesto non c'è più. */
  askedById: z.string().uuid().nullable(),
  askedOfId: z.string().uuid(),
  question: z.string(),
  options: z.array(z.string()),
  createdAt: z.string(),
  withdrawnAt: z.string().nullable(),
  answer: z
    .object({
      optionIndex: z.number().int().nullable(),
      text: z.string().nullable(),
      at: z.string(),
      byId: z.string().uuid().nullable(),
    })
    .nullable(),
});
export type DecisionRequestView = z.infer<typeof decisionRequestViewSchema>;

export const taskActivityEntryViewSchema = z.object({
  id: z.string(),
  taskId: z.string().uuid(),
  kind: z.enum(["comment", "field_change", "decision"]),
  authorId: z.string().uuid().nullable(),
  at: z.string(),
  body: z.string().optional(),
  replyToId: z.string().optional(),
  editedAt: z.string().optional(),
  deletedAt: z.string().optional(),
  deletedById: z.string().optional(),
  field: z.string().optional(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  decisionRequestId: z.string().optional(),
});
export type TaskActivityEntryView = z.infer<typeof taskActivityEntryViewSchema>;

/** Il sottoinsieme di `TaskWork` che la sezione Claude della fetta 1 usa. */
export const taskWorkViewSchema = z.object({
  claude: claudeWorkStateSchema,
  pullRequests: z
    .array(
      z.object({
        repo: z.string(),
        number: z.number().int().nullable(),
        url: z.string(),
        state: z.enum(["open", "merged", "closed"]),
      }),
    )
    .default([]),
  /** Il dettaglio del ticket nel web vecchio (piano, approvazione, domande, sessione). */
  webHref: z.string(),
});
export type TaskWorkView = z.infer<typeof taskWorkViewSchema>;

// --- scritture ----------------------------------------------------------------

export const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000),
    statusId: z.string().uuid(),
    departmentId: z.string().uuid(),
    assigneeId: z.string().uuid().nullable(),
    size: taskSizeSchema.nullable(),
    dueDate: z.string().date().nullable(),
    milestoneId: z.string().uuid().nullable(),
    labels: z.array(z.string().trim().min(1).max(60)).max(30),
    type: uiTaskTypeSchema,
    priority: ticketPrioritySchema,
  })
  .partial();
export type TaskPatch = z.infer<typeof taskPatchSchema>;

export const newTaskBodySchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100_000).optional(),
  departmentId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  size: taskSizeSchema.nullable().optional(),
  statusId: z.string().uuid().optional(),
  milestoneId: z.string().uuid().nullable().optional(),
  type: uiTaskTypeSchema,
  priority: ticketPrioritySchema.optional(),
  requestId: z.string().uuid().optional(),
});
export type NewTaskBody = z.infer<typeof newTaskBodySchema>;

const csv = <T extends string>(item: z.ZodType<T, string>) =>
  z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter((x) => x.length > 0))
    .pipe(z.array(item));

export const periodFieldSchema = z.enum(["created", "closed", "plannedWeek", "due"]);
export const relativePeriodSchema = z.enum(["last7", "last30", "thisWeek", "nextWeek", "thisMonth", "lastMonth"]);

/**
 * `FilterCriteria` del prototipo in query string: gli array come stringhe
 * separate da virgola; il periodo appiattito in `periodField` +
 * (`periodPreset` | `periodFrom`/`periodTo`).
 */
export const taskListQuerySchema = z.object({
  projectIds: csv(z.string().uuid()).optional(),
  departmentIds: csv(z.string().uuid()).optional(),
  assigneeIds: csv(z.union([z.string().uuid(), z.literal("none")])).optional(),
  families: csv(statusFamilySchema).optional(),
  statusIds: csv(z.string().uuid()).optional(),
  sizes: csv(z.union([taskSizeSchema, z.literal("none")])).optional(),
  milestoneIds: csv(z.string().uuid()).optional(),
  types: csv(uiTaskTypeSchema).optional(),
  priorities: csv(ticketPrioritySchema).optional(),
  stalled: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  text: z.string().max(500).optional(),
  periodField: periodFieldSchema.optional(),
  periodPreset: relativePeriodSchema.optional(),
  periodFrom: z.string().date().optional(),
  periodTo: z.string().date().optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
