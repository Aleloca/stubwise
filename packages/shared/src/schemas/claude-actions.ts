import { z } from "zod";
import { newFilterBodySchema } from "./task-filter.js";
import { isoWeekSchema, newTaskBodySchema, taskPatchSchema } from "./task-view.js";
import { milestoneDraftSchema } from "./milestone.js";
import { newRequestBodySchema } from "./project-request.js";

/**
 * Il catalogo delle azioni di Claude (chat, fetta 3): l'elenco CHIUSO di ciò
 * che Claude può PROPORRE in una conversazione, sulle aree integrate (2 e 3).
 * Claude propone, il SERVER esegue con gli stessi servizi delle rotte e i
 * permessi della persona ricontrollati; la classe la calcola il server sui
 * dati di adesso (`declared` è quella di partenza: può solo salire).
 *
 * Mai nel catalogo (test sul sorgente): approvare, rifiutare, pre-approvare o
 * revocare un piano; rispondere a una domanda dell'agente; mergiare,
 * rilasciare, fare deploy; scrivere nel registro decisioni; leggere segreti;
 * inviare fuori; creare PAT, inviti, link di reset.
 *
 * `deleteTask` c'è solo come INVERSO di `createTask` («Annulla»): Claude non lo
 * propone. Le azioni della pagina (`pageAction`) le esegue il renderer.
 */
export const CLAUDE_ACTION_FNS = [
  "createTask",
  "updateTask",
  "planTask",
  "addComment",
  "deleteComment",
  "createRequest",
  "convertRequest",
  "archiveRequest",
  "reopenRequest",
  "startRun",
  "createMilestone",
  "deleteMilestone",
  "saveFilter",
  "deleteFilter",
  "pageAction",
  // Solo inverso.
  "deleteTask",
] as const;
export const claudeActionFnSchema = z.enum(CLAUDE_ACTION_FNS);
export type ClaudeActionFn = z.infer<typeof claudeActionFnSchema>;

/** Le `fn` che Claude può proporre (il catalogo meno gli inversi). */
export const CLAUDE_PROPOSABLE_FNS = CLAUDE_ACTION_FNS.filter((f) => f !== "deleteTask");

/** La classe dichiarata: A parte subito (con «Annulla»), B chiede conferma. La C (riconferma) è la fetta 4. */
export const CLAUDE_DECLARED_CLASS: Record<ClaudeActionFn, "A" | "B"> = {
  createTask: "A",
  updateTask: "A",
  planTask: "A",
  addComment: "B",
  deleteComment: "B",
  createRequest: "B",
  convertRequest: "B",
  archiveRequest: "B",
  reopenRequest: "B",
  startRun: "B",
  createMilestone: "B",
  deleteMilestone: "B",
  saveFilter: "A",
  deleteFilter: "B",
  pageAction: "A",
  deleteTask: "B",
};

const id = z.uuid();
export const pageActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("language"), to: z.enum(["en", "it"]) }),
  z.object({ kind: z.literal("theme"), to: z.enum(["system", "light", "dark"]) }),
  z.object({ kind: z.literal("filter"), route: z.string().max(200), search: z.record(z.string(), z.unknown()) }),
]);

/** Gli argomenti di ogni azione, con gli STESSI schemi delle rotte. */
export const CLAUDE_ACTION_ARGS = {
  createTask: newTaskBodySchema,
  updateTask: z.object({ id, patch: taskPatchSchema }),
  planTask: z.object({ id, plan: z.object({ assigneeId: id.nullable(), week: isoWeekSchema.nullable() }) }),
  addComment: z.object({ taskId: id, body: z.string().trim().min(1).max(20_000), replyToId: id.optional() }),
  deleteComment: z.object({ id }),
  createRequest: newRequestBodySchema,
  convertRequest: z.object({ id, input: newTaskBodySchema.omit({ projectId: true, requestId: true }) }),
  archiveRequest: z.object({ id }),
  reopenRequest: z.object({ id }),
  startRun: z.object({ taskId: id }),
  createMilestone: milestoneDraftSchema.extend({ projectId: id }),
  deleteMilestone: z.object({ id }),
  saveFilter: newFilterBodySchema,
  deleteFilter: z.object({ id }),
  pageAction: pageActionSchema,
  deleteTask: z.object({ id }),
} satisfies Record<ClaudeActionFn, z.ZodType>;

export const claudeProposedActionSchema = z.object({
  fn: claudeActionFnSchema,
  args: z.record(z.string(), z.unknown()),
});
export type ClaudeProposedAction = z.infer<typeof claudeProposedActionSchema>;

/** Il body che il ponte del worker manda a `POST /api/claude/conversations/:id/proposals`. */
export const createClaudeProposalSchema = z.object({
  toolUseId: z.string().min(1).max(200),
  summary: z.string().max(2000).default(""),
  actions: z.array(claudeProposedActionSchema).min(1).max(20),
});
export type CreateClaudeProposalInput = z.input<typeof createClaudeProposalSchema>;

/** Perché una proposta chiede conferma (o una C la riconferma), dai dati di adesso. */
export const claudeClassReasonSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("notifies"),
    /** Le persone che chi chiede vede; `more`: ce ne sono altre (mai contate). */
    personIds: z.array(z.uuid()),
    more: z.boolean(),
  }),
  z.object({ kind: z.literal("irreversible") }),
]);
export type ClaudeClassReason = z.infer<typeof claudeClassReasonSchema>;

/** Una proposta RIFIUTATA all'esecuzione: il codice e quale azione, per «Couldn't do it · Who?». */
export const claudeActionFailureSchema = z.object({
  code: z.enum(["forbidden", "not_found", "invalid", "conflict", "busy", "budget_exhausted", "other"]),
  index: z.number().int(),
  /** Il permesso che manca, per il «Who?»; null se non è un permesso. */
  permission: z.string().nullable().default(null),
  projectId: z.uuid().nullable().default(null),
  message: z.string().default(""),
});
export type ClaudeActionFailure = z.infer<typeof claudeActionFailureSchema>;

/** Una proposta letta da chi l'ha chiesta: classe e motivi CALCOLATI adesso; scadenza derivata. */
export const claudeProposalViewSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  actions: z.array(claudeProposedActionSchema),
  summary: z.string(),
  cls: z.enum(["A", "B", "C"]),
  reasons: z.array(claudeClassReasonSchema).default([]),
  status: z.enum(["open", "confirmed", "cancelled", "failed", "expired"]),
  canConfirm: z.boolean().default(false),
  canCancel: z.boolean().default(false),
  failure: claudeActionFailureSchema.nullable().default(null),
  groupId: z.uuid().nullable().default(null),
  undoOfGroupId: z.uuid().nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type ClaudeProposalView = z.infer<typeof claudeProposalViewSchema>;

/** Un gruppo eseguito: le azioni con i codici toccati, e lo stato di «Annulla» per chi guarda. */
export const claudeActionGroupViewSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid().nullable(),
  proposalId: z.uuid().nullable(),
  actions: z.array(z.object({ fn: claudeActionFnSchema, args: z.record(z.string(), z.unknown()), codes: z.array(z.string()) })),
  executedAt: z.iso.datetime(),
  undo: z.enum(["available", "changed_after", "not_undoable", "undone", "not_yours"]),
  /** Chi ha scritto dopo, se chi guarda lo vede (per «Changed after by …»). */
  changedBy: z.uuid().nullable().default(null),
  undoneAt: z.iso.datetime().nullable().default(null),
});
export type ClaudeActionGroupView = z.infer<typeof claudeActionGroupViewSchema>;

/**
 * Una proposta aperta scade dopo 20 messaggi successivi (di chi scrive e di
 * Claude) o dopo 24 ore: si calcola a lettura e si riverifica alla conferma.
 * Lo stesso valore del prototipo (`PROPOSAL_EXPIRY` di `data/store.ts`).
 */
export const CLAUDE_PROPOSAL_EXPIRY = { messages: 20, ms: 24 * 60 * 60 * 1000 } as const;

/** L'esito che il server dà al tool `propose_action` (il modello lo legge). */
export const claudeProposalOutcomeSchema = z.object({
  status: z.enum(["executed", "awaiting_confirmation", "refused"]),
  proposalId: z.uuid().nullable(),
  /** I codici degli oggetti toccati (una A eseguita), per citarli. */
  codes: z.array(z.string()).default([]),
  /** Il motivo di un rifiuto, in una riga (mai un dato che chi scrive non vede). */
  reason: z.string().nullable().default(null),
});
export type ClaudeProposalOutcome = z.infer<typeof claudeProposalOutcomeSchema>;
