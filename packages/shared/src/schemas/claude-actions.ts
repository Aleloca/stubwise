import { z } from "zod";
import { newFilterBodySchema } from "./task-filter.js";
import { isoWeekSchema, newTaskBodySchema, taskPatchSchema } from "./task-view.js";
import { milestoneDraftSchema } from "./milestone.js";
import { newRequestBodySchema } from "./project-request.js";
import { mailComposeModeSchema } from "./mail-compose.js";
import { liveRowTypes } from "../alerts/catalog.js";
import { createPluginSchema, updatePluginRefSchema } from "./plugin.js";
import { aiModelChoiceSchema, aiOperationSchema } from "../ai-operations.js";
import { languageSchema } from "./language.js";
import { googleDomainsSchema } from "./google.js";
import { updateAutomationSettingsSchema } from "../instance-admin.js";
import { webhookFieldsSchema } from "../outgoing-webhooks.js";

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
  // Area 9, F7, Task 2: le C (la loro rotta chiede la riconferma).
  "addMember",
  "removeMember",
  "setMemberRole",
  "registerPlugin",
  "updatePluginRef",
  // Area 9, F7, Task 3: le B del progetto.
  "archiveProject",
  "reopenProject",
  "updateProjectGeneral",
  "setProjectAi",
  "saveProjectAutomations",
  "pauseQueue",
  "resumeQueue",
  "retryJob",
  // Area 9, F7, Task 4: le B dell'istanza, senza segreti (M-4 = a).
  "setModel",
  "saveBudget",
  "saveStorage",
  "saveAutomation",
  "setProviderEnabled",
  "moveProvider",
  "updateGitAccount",
  "updateGoogleApp",
  "rerunSmoke",
  "removePlugin",
  "updateWebhook",
] as const;
export const claudeActionFnSchema = z.enum(CLAUDE_ACTION_FNS);
export type ClaudeActionFn = z.infer<typeof claudeActionFnSchema>;

/** Le `fn` che esistono SOLO come inverso di un'altra («Annulla»): Claude non le propone. */
export const CLAUDE_INVERSE_ONLY_FNS: readonly ClaudeActionFn[] = ["deleteTask", "resetSubscription"];

/** Le `fn` che Claude può proporre (il catalogo meno gli inversi). */
export const CLAUDE_PROPOSABLE_FNS = CLAUDE_ACTION_FNS.filter((f) => !CLAUDE_INVERSE_ONLY_FNS.includes(f));

/**
 * La classe dichiarata: A parte subito (con «Annulla»), B chiede conferma, C
 * chiede la conferma CON la riconferma di chi conferma (area 9, F7). La C non
 * si sceglie: è quella delle voci la cui rotta ha `config.reauth` (il test
 * d'accordo `claude-actions-class.test.ts` le tiene uguali).
 */
export const CLAUDE_DECLARED_CLASS: Record<ClaudeActionFn, "A" | "B" | "C"> = {
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
  // Area 9, F7: le rotte chiedono la riconferma (`config.reauth`): C.
  addMember: "C",
  removeMember: "C",
  setMemberRole: "C",
  registerPlugin: "C",
  updatePluginRef: "C",
  // Area 9, F7, Task 3: le impostazioni del progetto (le rotte non chiedono la riconferma).
  archiveProject: "B",
  reopenProject: "B",
  updateProjectGeneral: "B",
  setProjectAi: "B",
  saveProjectAutomations: "B",
  pauseQueue: "B",
  resumeQueue: "B",
  retryJob: "B",
  // Area 9, F7, Task 4: senza segreti le rotte a riconferma PARZIALE non la chiedono (M-1 = a).
  setModel: "B",
  saveBudget: "B",
  saveStorage: "B",
  saveAutomation: "B",
  setProviderEnabled: "B",
  moveProvider: "B",
  updateGitAccount: "B",
  updateGoogleApp: "B",
  rerunSmoke: "B",
  removePlugin: "B",
  updateWebhook: "B",
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
  // Area 9, F7: i membri (`PUT`/`DELETE /api/projects/:projectId/members/:userId`),
  // senza i permessi personali (li dà solo una persona, dalla pagina).
  addMember: z.object({ projectId: id, userId: id, roleId: id }).strict(),
  removeMember: z.object({ projectId: id, userId: id }).strict(),
  setMemberRole: z.object({ projectId: id, userId: id, roleId: id }).strict(),
  // I plugin (M-6 = a): `trust: true` OBBLIGATORIO, come la rotta. Registrare
  // un plugin ne ESEGUE il codice (lo smoke run parte da solo): Claude lo
  // propone solo se la persona ha detto che si fida di quel repository e
  // di quel commit, e la scheda lo dice.
  registerPlugin: createPluginSchema.extend({ trust: z.literal(true) }).strict(),
  updatePluginRef: updatePluginRefSchema.extend({ id, trust: z.literal(true) }).strict(),
  // Area 9, F7, Task 3: le forme del prototipo (`data/claude/catalog.ts`).
  archiveProject: z.object({ projectId: id }).strict(),
  reopenProject: z.object({ projectId: id }).strict(),
  updateProjectGeneral: z
    .object({ projectId: id, name: z.string().min(1).max(200).optional(), description: z.string().min(1).max(2000).nullable().optional() })
    .strict()
    .refine((a) => a.name !== undefined || a.description !== undefined, "name or description"),
  setProjectAi: z.object({ projectId: id, providerId: id.nullable(), exclusive: z.boolean() }).strict(),
  saveProjectAutomations: z
    .object({
      projectId: id,
      switches: z
        .object({ docsNightly: z.boolean(), dailyReport: z.boolean(), backlogDiscovery: z.boolean(), pulse: z.boolean(), weeklyBrief: z.boolean() })
        .strict(),
      pulseEveryDays: z.number().int().min(1).max(30),
      correctionCap: z.number().int().min(0).max(10),
    })
    .strict(),
  pauseQueue: z.object({ projectId: id }).strict(),
  resumeQueue: z.object({ projectId: id }).strict(),
  retryJob: z.object({ jobId: id }).strict(),
  // Area 9, F7, Task 4: gli schemi delle rotte MENO i campi segreti, `strict`
  // (M-4 = a): un segreto negli argomenti è `invalid`, Claude non può
  // nemmeno proporlo, e la riconferma parziale non scatta mai da qui.
  setModel: z.object({ operation: aiOperationSchema, model: aiModelChoiceSchema.nullable() }).strict(),
  saveBudget: z.object({ monthlyUsd: z.number().nonnegative().nullable(), contentLanguage: languageSchema }).strict(),
  saveStorage: z.object({ endpoint: z.string().max(500), region: z.string().max(100), bucket: z.string().max(200), accessKeyId: z.string().max(200) }).strict(),
  saveAutomation: updateAutomationSettingsSchema.strict(),
  setProviderEnabled: z.object({ id, enabled: z.boolean() }).strict(),
  moveProvider: z.object({ id, toIndex: z.number().int().min(0).max(100) }).strict(),
  updateGitAccount: z
    .object({ id, name: z.string().min(1).max(200).optional(), workspace: z.string().min(1).max(200).optional() })
    .strict()
    .refine((a) => a.name !== undefined || a.workspace !== undefined, "name or workspace"),
  updateGoogleApp: z
    .object({ id, name: z.string().trim().min(1).max(200).optional(), domains: googleDomainsSchema.optional(), clientId: z.string().trim().min(1).max(500).optional() })
    .strict()
    .refine((a) => a.name !== undefined || a.domains !== undefined || a.clientId !== undefined, "a field"),
  rerunSmoke: z.object({ id }).strict(),
  removePlugin: z.object({ id }).strict(),
  // Senza `url`: cambiarlo chiede la riconferma (e decide dove vanno i dati).
  updateWebhook: webhookFieldsSchema
    .omit({ url: true })
    .partial()
    .extend({ id })
    .strict()
    .refine((a) => Object.keys(a).length > 1, "a field"),
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
  // Area 9, F7: `reauth` per azione (una C non scelta in «Conferma 2 di 3» non la chiede). False da un server di prima.
  actions: z.array(
    claudeProposedActionSchema.extend({
      reauth: z.boolean().default(false),
      /**
       * Area 9, F7 (additivo): i nomi della scheda di un'azione sui membri,
       * derivati a lettura coi permessi di chi guarda (null se non vede il
       * progetto, o per le altre voci). Un server di prima non li manda.
       */
      labels: z.object({ person: z.string().nullable(), role: z.string().nullable() }).default({ person: null, role: null }),
    }),
  ),
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
  /**
   * Area 9, F7 (M-3 = a): la conferma chiede la riconferma (il gruppo ha una
   * C). Un campo a sé e non un motivo nuovo dell'unione dei motivi, che
   * `readerSchema` non apre. False da un server che non lo manda.
   */
  reauth: z.boolean().default(false),
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
  /**
   * Area 9, F7 (additivo): «Annulla» di questo gruppo chiede la riconferma
   * (un inverso dichiarato C, i membri), derivato dal server; vero solo con
   * `undo: "available"`. Un server di prima non lo manda.
   */
  undoReauth: z.boolean().default(false),
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
