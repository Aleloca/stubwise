import { z } from "zod";
import { newFilterBodySchema } from "./task-filter.js";
import { isoWeekSchema, newTaskBodySchema, taskPatchSchema } from "./task-view.js";
import { milestoneDraftSchema } from "./milestone.js";
import { newRequestBodySchema } from "./project-request.js";
import { mailComposeModeSchema } from "./mail-compose.js";
import { liveRowTypes } from "../alerts/catalog.js";

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
  // Area 6, F3: il corpo di un'email nella bozza di chi conferma. SEMPRE B.
  "fillMailBody",
  // Area 8, F2, S7: l'iscrizione a un tipo d'avviso di chi chiede. A, con «Annulla».
  "setSubscription",
  // Solo inversi.
  "deleteTask",
  // Area 8, F2 (review): l'«Annulla» di un setSubscription su una riga senza scelta salvata.
  "resetSubscription",
] as const;
export const claudeActionFnSchema = z.enum(CLAUDE_ACTION_FNS);
export type ClaudeActionFn = z.infer<typeof claudeActionFnSchema>;

/** Le `fn` che esistono SOLO come inverso di un'altra («Annulla»): Claude non le propone. */
export const CLAUDE_INVERSE_ONLY_FNS: readonly ClaudeActionFn[] = ["deleteTask", "resetSubscription"];

/** Le `fn` che Claude può proporre (il catalogo meno gli inversi). */
export const CLAUDE_PROPOSABLE_FNS = CLAUDE_ACTION_FNS.filter((f) => !CLAUDE_INVERSE_ONLY_FNS.includes(f));

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
  // Scrive su Gmail (la bozza di chi conferma): mai senza conferma.
  fillMailBody: "B",
  // Tocca solo le iscrizioni di chi chiede: nessun altro è avvisato.
  setSubscription: "A",
  deleteTask: "B",
  // Riporta al default le iscrizioni di chi chiede: nessun altro è avvisato.
  resetSubscription: "A",
};

const id = z.uuid();
export const pageActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("language"), to: z.enum(["en", "it"]) }),
  z.object({ kind: z.literal("theme"), to: z.enum(["system", "light", "dark"]) }),
  z.object({ kind: z.literal("filter"), route: z.string().max(200), search: z.record(z.string(), z.unknown()) }),
]);

/** Gli argomenti di ogni azione, con gli STESSI schemi delle rotte. */
export const CLAUDE_ACTION_ARGS = {
  // SENZA `requestId`, e strict (review della fetta 3): convertire una
  // richiesta è `convertRequest` (B, non si annulla); una createTask con
  // `requestId` la convertirebbe come A, e l'Undo la lascerebbe convertita.
  createTask: newTaskBodySchema.omit({ requestId: true }).strict(),
  updateTask: z.object({ id, patch: taskPatchSchema }),
  planTask: z.object({ id, plan: z.object({ assigneeId: id.nullable(), week: isoWeekSchema.nullable() }) }),
  addComment: z.object({ taskId: id, body: z.string().trim().min(1).max(20_000), replyToId: id.optional() }),
  // `taskId`: la rotta valuta l'accesso dal ticket del commento.
  deleteComment: z.object({ id, taskId: id }),
  createRequest: newRequestBodySchema,
  convertRequest: z.object({ id, input: newTaskBodySchema.omit({ projectId: true, requestId: true }) }),
  archiveRequest: z.object({ id }),
  reopenRequest: z.object({ id }),
  startRun: z.object({ taskId: id }),
  createMilestone: milestoneDraftSchema.extend({ projectId: id }),
  deleteMilestone: z.object({ id }),
  // Solo PERSONALE (il server lo forza privato): un filtro pubblico lo vedrebbero altri.
  saveFilter: newFilterBodySchema,
  deleteFilter: z.object({ id }),
  pageAction: pageActionSchema,
  // La conversazione (`threadId` null = un'email nuova) di una casella di chi
  // conferma; il testo va nel corpo, destinatari e oggetto li calcola il server.
  fillMailBody: z
    .object({
      accountId: id,
      threadId: z.string().max(200).nullable(),
      mode: mailComposeModeSchema,
      text: z.string().trim().min(1).max(200_000),
    })
    .strict(),
  // Area 8, F2, S7: come `PUT /api/me/alert-subscriptions/:projectId/:type`,
  // SEMPRE di chi chiede (nessun `userId`). `type` è una riga VIVA delle
  // Preferenze (`liveRowTypes`): l'elenco entra nella firma, così il modello
  // non inventa tipi. Almeno uno fra App e Telefono; gli assenti restano.
  setSubscription: z
    .object({
      projectId: id,
      type: z.enum(liveRowTypes() as [string, ...string[]]),
      app: z.boolean().optional(),
      phone: z.boolean().optional(),
    })
    .strict()
    .refine((a) => a.app !== undefined || a.phone !== undefined, { message: "app or phone" }),
  deleteTask: z.object({ id }),
  resetSubscription: z.object({ projectId: id, type: z.enum(liveRowTypes() as [string, ...string[]]) }).strict(),
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
  /** Fa partire il lavoro di Claude (assegnargli una task, come `startRun`): chiede sempre conferma. */
  z.object({ kind: z.literal("starts_work") }),
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
  actions: z.array(
    z.object({
      fn: claudeActionFnSchema,
      args: z.record(z.string(), z.unknown()),
      codes: z.array(z.string()),
      /**
       * Il seguito dopo il commit non è riuscito: `mail_not_saved` (fillMailBody,
       * il testo NON è nella bozza di Gmail; è in `args.text`, da copiare).
       */
      effectFailure: z.string().nullable().default(null),
    }),
  ),
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

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  format?: string;
  additionalProperties?: JsonSchema | boolean;
};

/** Una firma compatta, in stile TypeScript, di un JSON Schema (per il prompt). */
function signature(s: JsonSchema): string {
  const union = s.anyOf ?? s.oneOf;
  if (union) return union.map(signature).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const type = Array.isArray(s.type) ? s.type : s.type !== undefined ? [s.type] : [];
  if (type.length > 1) return type.map((t) => signature({ ...s, type: t })).join(" | ");
  switch (type[0]) {
    case "null":
      return "null";
    case "string":
      if (s.format === "uuid") return "uuid";
      if (s.format === "date") return "date(YYYY-MM-DD)";
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${s.items ? wrap(signature(s.items)) : "unknown"}[]`;
    case "object": {
      const props = Object.entries(s.properties ?? {});
      if (props.length === 0) return "{ [key: string]: unknown }";
      const required = new Set(s.required ?? []);
      return `{ ${props.map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${signature(v)}`).join(", ")} }`;
    }
    default:
      return "unknown";
  }
}
const wrap = (t: string) => (t.includes(" | ") ? `(${t})` : t);

/**
 * Le firme delle azioni che Claude può proporre, una per riga, ricavate dagli
 * STESSI schemi che il server usa per validarle (`CLAUDE_ACTION_ARGS`): il
 * prompt della chat non le riscrive a mano, quindi non possono divergere.
 */
export function claudeActionSignatures(): string {
  return CLAUDE_PROPOSABLE_FNS.map(
    (fn) => `- ${fn}(${signature(z.toJSONSchema(CLAUDE_ACTION_ARGS[fn], { io: "input", unrepresentable: "any" }) as JsonSchema)})`,
  ).join("\n");
}
