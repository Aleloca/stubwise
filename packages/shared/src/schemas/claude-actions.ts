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
import { productPageUpdateSourceSchema, startFirstVersionSchema } from "./product-docs.js";

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
 * propone. Le azioni della pagina (`pageAction`) e le bozze nei campi
 * (`fillField`, area 10, F6) le esegue il renderer (`RENDERER_FNS`).
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
  // Area 10, F6: una bozza nel campo della pagina aperta; la salva la persona.
  "fillField",
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
  "saveAutomation",
  "setProviderEnabled",
  "moveProvider",
  "updateGitAccount",
  "updateGoogleApp",
  "rerunSmoke",
  "removePlugin",
  "updateWebhook",
  // Area 10, F2 (S1): le BOZZE di automazione di progetto. Claude non pubblica
  // né accende mai (`docs/invariants/automations.md`).
  "createAutomation",
  "saveAutomationDraft",
  "deleteAutomationDraft",
  // Area 11, F6, Task 4: la doc di prodotto (il prototipo: `catalogProduct.ts`).
  // Tutte B (F6-1 = a): le tre che fanno partire il modello con `starts_work`,
  // gli inversi perché non si annullano a loro volta (P39).
  "writeFirstVersion",
  "undoFirstVersion",
  "updateProductPage",
  "undoProductUpdate",
  "drawWireframe",
  "deleteWireframe",
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
  // Non scrive sul server: il testo va nel campo, e lo salva la persona.
  fillField: "A",
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
  saveAutomation: "B",
  setProviderEnabled: "B",
  moveProvider: "B",
  updateGitAccount: "B",
  updateGoogleApp: "B",
  rerunSmoke: "B",
  removePlugin: "B",
  updateWebhook: "B",
  // Area 10, F2: una bozza spenta non avvisa e non fa partire niente.
  createAutomation: "A",
  saveAutomationDraft: "A",
  deleteAutomationDraft: "B",
  // Area 11, F6-1 = a (maintainer): fa partire il lavoro del modello, quindi chiede.
  writeFirstVersion: "B",
  undoFirstVersion: "B",
  // Avvisa chi segue la pagina, e fa partire il modello: chiede.
  updateProductPage: "B",
  undoProductUpdate: "B",
  drawWireframe: "B",
  deleteWireframe: "B",
};

const id = z.uuid();

/**
 * Area 10, F2: il flusso di una bozza, nella forma che le rotte accettano
 * (inizio, passi, titolo delle esecuzioni). Il resto lo controlla il motore
 * (`configErrorsOf`) prima della scheda: un flusso con errori non diventa una
 * bozza di Claude.
 */
const automationFlowArgSchema = z.looseObject({
  trigger: z.looseObject({ kind: z.string() }),
  steps: z.array(z.record(z.string(), z.unknown())).max(50),
  titleTemplate: z.string().max(200),
});
const automationCodeSchema = z.string().trim().min(1).max(40);

export const pageActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("language"), to: z.enum(["en", "it"]) }),
  z.object({ kind: z.literal("theme"), to: z.enum(["system", "light", "dark"]) }),
  z.object({ kind: z.literal("filter"), route: z.string().max(200), search: z.record(z.string(), z.unknown()) }),
]);

/**
 * Area 10, F6: i campi in cui Claude scrive una bozza, col tetto della ROTTA
 * del campo (`taskPatchSchema.description`, il body di `PUT …/release-notes`).
 */
export const CLAUDE_FILL_FIELDS = ["task.description", "release.notes"] as const;
export type ClaudeFillField = (typeof CLAUDE_FILL_FIELDS)[number];
export const CLAUDE_FILL_FIELD_MAX: Record<ClaudeFillField, number> = { "task.description": 100_000, "release.notes": 20_000 };

/**
 * `.strict()` e SENZA unioni (D-10 = a): un client che non conosce `fillField`
 * la legge come `UNKNOWN` (`readerSchema` sull'enum) senza perdere la
 * proposta. Il `superRefine` vuole il bersaglio del campo e il suo tetto.
 */
export const fillFieldArgsSchema = z
  .object({
    field: z.enum(CLAUDE_FILL_FIELDS),
    taskId: id.optional(),
    repositoryId: id.optional(),
    prNumber: z.number().int().positive().optional(),
    text: z.string().trim().min(1).max(100_000),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.field === "task.description" && (a.taskId === undefined || a.repositoryId !== undefined || a.prNumber !== undefined)) {
      ctx.addIssue({ code: "custom", message: "task.description wants taskId only" });
    }
    if (a.field === "release.notes" && (a.repositoryId === undefined || a.prNumber === undefined || a.taskId !== undefined)) {
      ctx.addIssue({ code: "custom", message: "release.notes wants repositoryId and prNumber only" });
    }
    if (a.text.length > CLAUDE_FILL_FIELD_MAX[a.field]) ctx.addIssue({ code: "custom", message: `text over ${CLAUDE_FILL_FIELD_MAX[a.field]} characters` });
  });

/**
 * Le azioni che esegue il RENDERER (area 10, F6): il server le valida, le
 * registra e basta — nessuna voce in `SERVER_CATALOG`, nessuna scrittura,
 * nessun «Annulla» del server. Da sole, mai nella Chat.
 */
export const RENDERER_FNS: ReadonlySet<ClaudeActionFn> = new Set<ClaudeActionFn>(["pageAction", "fillField"]);

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
  fillField: fillFieldArgsSchema,
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
  // (Niente `saveStorage`, review di F7: endpoint e bucket decidono DOVE vanno
  // gli allegati, come l'url di un webhook. Resta un gesto della persona.)
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
  // Area 10, F2: solo di PROGETTO (`projectId` obbligatorio); stato e
  // proprietario non sono argomenti: nasce bozza spenta, di nessuno.
  createAutomation: z
    .object({ projectId: id, name: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(), flow: automationFlowArgSchema })
    .strict(),
  // `expectedRev`: la revisione della bozza letta (null = un'accesa senza bozza).
  saveAutomationDraft: z
    .object({ code: automationCodeSchema, flow: automationFlowArgSchema, expectedRev: z.number().int().nullable(), name: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional() })
    .strict(),
  deleteAutomationDraft: z.object({ code: automationCodeSchema, expectedRev: z.number().int() }).strict(),
  // Area 11, F6, Task 4: le forme del prototipo (`catalogProduct.ts`), con gli
  // schemi delle rotte. Le fonti della prima versione si leggono con la
  // visibilità di chi conferma; l'aggiornamento solo da un'email o una
  // riunione che chi conferma può aprire.
  writeFirstVersion: z.object({ projectId: id, sources: startFirstVersionSchema.shape.sources }).strict(),
  undoFirstVersion: z.object({ projectId: id }).strict(),
  updateProductPage: z.object({ pageId: id, source: productPageUpdateSourceSchema }).strict(),
  undoProductUpdate: z.object({ revisionId: id }).strict(),
  // Dopo `afterId` (null = in cima) o al posto di un paragrafo vuoto (`replaceId`); senza nessuno dei due, in cima.
  drawWireframe: z
    .object({ pageId: id, afterId: z.string().min(1).max(100).nullable().optional(), replaceId: z.string().min(1).max(100).optional() })
    .strict()
    .refine((a) => a.afterId === undefined || a.replaceId === undefined, "afterId or replaceId"),
  deleteWireframe: z.object({ pageId: id, blockId: z.string().min(1).max(100), revisionId: id }).strict(),
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
/**
 * Area 9, F7: il permesso d'ISTANZA che una voce chiede (lo stesso di
 * `config.access` della sua rotta; un test d'accordo del server lo confronta
 * col catalogo). Le altre voci si valutano nel progetto, alla proposta.
 */
export const CLAUDE_INSTANCE_PERMISSION: Partial<Record<ClaudeActionFn, string>> = {
  registerPlugin: "plugins.manage",
  updatePluginRef: "plugins.manage",
  rerunSmoke: "plugins.manage",
  removePlugin: "plugins.manage",
  setModel: "settings.manage",
  saveBudget: "settings.manage",
  saveAutomation: "settings.manage",
  setProviderEnabled: "ai_providers.manage",
  moveProvider: "ai_providers.manage",
  updateGitAccount: "git_accounts.manage",
  updateGoogleApp: "integrations.manage",
  updateWebhook: "integrations.manage",
};

/**
 * Le firme che il modello vede. Con `instancePermissions` (quelli di chi
 * chiede) le voci d'istanza che non può proporre NON compaiono: il server le
 * rifiuterebbe comunque, ma così Claude non le offre. Le voci di progetto
 * restano: il permesso dipende dal progetto, e lo valuta il server.
 */
export function claudeActionSignatures(instancePermissions?: ReadonlySet<string>): string {
  const allowed = (fn: ClaudeActionFn) => {
    const needs = CLAUDE_INSTANCE_PERMISSION[fn];
    return needs === undefined || instancePermissions === undefined || instancePermissions.has(needs);
  };
  return CLAUDE_PROPOSABLE_FNS.filter(allowed).map(
    (fn) => `- ${fn}(${signature(z.toJSONSchema(CLAUDE_ACTION_ARGS[fn], { io: "input", unrepresentable: "any" }) as JsonSchema)})`,
  ).join("\n");
}
