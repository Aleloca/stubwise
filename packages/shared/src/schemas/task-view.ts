import { z } from "zod";
import { STATUS_FAMILIES } from "../tasks/stall.js";
import { TASK_SIZES } from "../tasks/sizes.js";
import { UI_TASK_TYPES } from "../tasks/types.js";
import { isIsoWeek } from "../tasks/weeks.js";
import { viaClaudeShape } from "./actor.js";
import { ticketPrioritySchema } from "./ticket.js";

/**
 * Contratto server → app nuova (integrazione area 2, fetta 1): le viste delle
 * task nella FORMA del prototipo (`apps/desktop/src/renderer/data/model.ts`),
 * così il renderer non le rimappa. Ogni campo che il prototipo ha e il server
 * non manda ancora è `.optional()`/`.nullable()`/`.default()`, con un test che
 * parsa una risposta senza (regola dei cambi additivi in `CLAUDE.md`).
 */

export const statusFamilySchema = z.enum(STATUS_FAMILIES);

/** Una settimana ISO `YYYY-Www` che esiste davvero (fetta 2). */
export const isoWeekSchema = z.string().refine(isIsoWeek, { message: "plannedWeek must be an ISO week like 2026-W46" });
export const taskSizeSchema = z.enum(TASK_SIZES);

/**
 * In che giorno (1 = lunedì … 5 = venerdì) l'assegnatario si mette una task
 * della settimana (fetta 2): personale, e vale solo finché la task resta sua
 * e in quella settimana. `day: null` = «nella settimana, senza giorno».
 */
export const dayArrangementSchema = z.object({
  taskId: z.uuid(),
  week: isoWeekSchema,
  day: z.number().int().min(1).max(5).nullable(),
});
export type DayArrangement = z.infer<typeof dayArrangementSchema>;
export const setDayBodySchema = dayArrangementSchema.omit({ taskId: true });
export type SetDayBody = z.infer<typeof setDayBodySchema>;

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
  /**
   * L'utente di sistema «Claude» (area 3, fetta 3e): si assegna come una
   * persona, e assegnarlo avvia il lavoro. Additivo.
   */
  isClaude: z.boolean().default(false),
  /**
   * Solo sulla riga di Claude: i progetti in cui CHI GUARDA può assegnarlo
   * (`runs.start`). Lo calcola il server: il client mostra Claude fra gli
   * assegnatari solo lì, senza dedurre la regola.
   */
  claudeAssignableProjectIds: z.array(z.string().uuid()).default([]),
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
  /**
   * Fetta 2: chi guarda può spostare questa task nel Planning (la regola
   * `canMove`/`planBlock` di `tasks/planning.ts`, coi permessi calcolati dal
   * server). Il client lo legge, non lo deduce. `.optional()`: un server più
   * vecchio non lo manda.
   */
  canPlan: z.boolean().optional(),
  /**
   * Solo nella risposta di una SCRITTURA che ha appena assegnato la task a
   * Claude (integrazione area 3, review punto 5): l'esito dell'avvio del
   * lavoro, `started` o `refused:<codice>` di `startRun` (es.
   * `refused:job_in_flight`). L'assegnazione è scritta comunque; il client
   * dice la frase del codice. `null` altrove. Additivo.
   */
  claudeRun: z.string().nullable().default(null),
});
export type TaskViewData = z.infer<typeof taskViewSchema>;

export const taskListResponseSchema = z.object({
  items: z.array(taskViewSchema),
  /** Oltre il tetto (2000 righe) l'elenco è tagliato. */
  truncated: z.boolean().default(false),
});

/**
 * Il motivo di una ferma come UN oggetto, non una union: `readerSchema` non
 * attraversa le union a discriminante (apre i literal, e cambierebbe quale
 * variante vince — vedi `reader.ts`). Il `kind` è un enum, che il lettore apre
 * in `UNKNOWN` per un motivo nuovo; i campi delle varianti sono facoltativi
 * (`manual` → reason, note; `decision` → personId; `blocked_by` → taskId).
 * Il tipo stretto resta `StallReason` di `tasks/stall.ts`, che il server
 * produce e questo schema accetta.
 */
export const stallReasonSchema = z.object({
  kind: z.enum(["manual", "decision", "claude_question", "blocked_by", "unassigned", "idle"]),
  reason: z.string().optional(),
  note: z.string().optional(),
  personId: z.string().optional(),
  taskId: z.string().optional(),
});

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
  /** Il progetto della task, derivato a lettura. `.optional()`: un server più vecchio non lo manda. */
  projectId: z.string().uuid().optional(),
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
  /** «via Claude» (chat, fetta 3) di un commento o di un cambio di campo: derivato a lettura, additivo. */
  ...viaClaudeShape,
});
export type TaskActivityEntryView = z.infer<typeof taskActivityEntryViewSchema>;

/** `allowed` | `forbidden` (lo stato lo consente, chi guarda no) | `unavailable` (lo stato non lo consente). */
export const actionAvailabilitySchema = z.enum(["allowed", "forbidden", "unavailable"]);

/**
 * Una sessione di lavoro della task (un job AI), come la legge la sezione
 * Claude (integrazione area 3, fetta 3a). Gli eventi NON sono qui: si leggono
 * dalla sessione (`sessionId`, `/api/agent-sessions/:id/events` e lo stream).
 */
export const taskWorkRunSchema = z.object({
  /** Il job AI. */
  id: z.uuid(),
  /** La sessione dell'agente del job, se è nata (un job in coda non ce l'ha ancora). */
  sessionId: z.uuid().nullable().default(null),
  /** Chi l'ha avviata; `null` se il sistema o un utente eliminato. */
  ownerId: z.uuid().nullable().default(null),
  createdAt: z.iso.datetime(),
  /** Lo stato del prototipo (`held` → `idle`, con `heldReason`). «In pausa» per uno «Ferma» lo dice il dettaglio della sessione (`paused`). */
  state: z.enum(["working", "awaiting_answer", "awaiting_approval", "paused", "idle", "finished"]),
  /** Solo a sessione finita: `skipped` (annullata o non fatta) → `stopped`. */
  outcome: z.enum(["ok", "failed", "timed_out", "stopped"]).nullable().default(null),
  /** La correzione di una PR, o un fix. */
  kind: z.enum(["fix", "correction"]).default("fix"),
  /** Solo una correzione: la PR che corregge. */
  pr: z.object({ repo: z.string(), number: z.number().int() }).nullable().default(null),
  provider: z.object({ kind: z.enum(["account", "api_key"]), name: z.string() }).nullable().default(null),
  failureSummary: z.string().nullable().default(null),
  /** Perché il job è parcheggiato (`ai_jobs.held_reason`), o null. */
  heldReason: z.string().nullable().default(null),
  /**
   * «Annulla il lavoro» chiesto su un job in esecuzione (3b.1-bis): il worker
   * lo sta chiudendo. Additivo.
   */
  cancelRequested: z.boolean().default(false),
  /** Il piano del job (il prototipo lo mette fra gli eventi: lo fa l'app). */
  plan: z
    .object({
      text: z.string(),
      summary: z.string(),
      /**
       * `undecided` (area 3, fetta 3b, review): nessun esito verificabile — un
       * piano fermo, annullato sul gate o fallito prima di eseguire. Un client
       * che non lo conosce lo legge `__unknown__` (readerSchema).
       */
      status: z.enum(["pending", "approved", "rejected", "pre_approved", "undecided"]),
      at: z.iso.datetime(),
      /**
       * Il digest del testo del piano (`planDigest`): rimandato come
       * `planDigest` ad approve/reject-plan, fa rispondere 409 `plan_changed`
       * se nel frattempo il piano è cambiato. Additivo.
       */
      digest: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type TaskWorkRunView = z.infer<typeof taskWorkRunSchema>;

export const taskPrEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["pr_opened", "pr_merged", "pr_closed"]),
  at: z.iso.datetime(),
  number: z.number().int(),
  repo: z.string(),
});

export const taskPrFactSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  review: z
    .object({
      verdict: z.enum(["pending", "approved", "changes_requested"]),
      at: z.iso.datetime(),
      byId: z.uuid().nullable().default(null),
      on: z.enum(["stubwise", "platform"]).nullable().default(null),
    })
    .nullable()
    .default(null),
  branchProtected: z.boolean().default(false),
  /** Una correzione chiesta aspetta che finisca il lavoro in corso. */
  queued: z.boolean().default(false),
});

export const taskPlanDecisionSchema = z.object({
  decidedById: z.uuid().nullable(),
  decidedAt: z.iso.datetime(),
  decision: z.string(),
  status: z.enum(["approved", "rejected"]),
});

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
  // --- Integrazione area 3, fetta 3a: il lavoro intero, in lettura. Tutti con
  // un default: un server della fetta 1 non li manda, e la sezione degrada.
  /** Le sessioni di lavoro (i job AI) dalla più vecchia; vuoto per chi non ha `repos.view`. */
  runs: z.array(taskWorkRunSchema).default([]),
  /** Ci sono sessioni di lavoro che chi guarda non vede (`repos.view`). */
  hiddenRuns: z.boolean().default(false),
  /** Gli eventi delle PR della task (aperta, mergiata, chiusa). */
  prEvents: z.array(taskPrEventSchema).default([]),
  /** I fatti esterni di ogni PR: il ciclo lo deriva l'app (`prCycles`). */
  prFacts: z.array(taskPrFactSchema).default([]),
  /** Il tetto delle correzioni della repository (il primo, con più repository). */
  correctionCap: z.number().int().default(3),
  /** Le decisioni sui piani dal registro, con l'esito dalla riga (mai dal testo). */
  planDecisions: z.array(taskPlanDecisionSchema).default([]),
  /** Il progetto ha una repository: solo lì ci sono PR e correzioni. */
  software: z.boolean().default(false),
  /** Una PR aperta: «Chiedi modifiche» ha qualcosa da correggere. */
  openPr: z.boolean().default(false),
  /** Claude aspetta chi guarda: una domanda a cui può rispondere o un piano che può decidere. */
  waitsOnViewer: z.boolean().default(false),
  /** Cosa può fare chi guarda, calcolato dal SERVER coi suoi permessi e le precondizioni delle scritture. */
  actions: z
    .object({
      start: actionAvailabilitySchema.default("unavailable"),
      relaunch: actionAvailabilitySchema.default("unavailable"),
      resume: actionAvailabilitySchema.default("unavailable"),
      requestChanges: actionAvailabilitySchema.default("unavailable"),
      /**
       * «Annulla il lavoro» (review dell'area 3, punto 14): un lavoro
       * parcheggiato o in esecuzione, non ancora chiesto, per chi ha
       * `runs.start`. Lo calcola il server; il client lo legge. Additivo: un
       * server più vecchio non lo manda e il client non lo offre.
       */
      cancel: actionAvailabilitySchema.default("unavailable"),
    })
    .default({
      start: "unavailable",
      relaunch: "unavailable",
      resume: "unavailable",
      requestChanges: "unavailable",
      cancel: "unavailable",
    }),
  /**
   * «Chiedi modifiche» PER PR (multi-repo), accanto all'aggregato
   * `actions.requestChanges` (che è `allowed` se lo è almeno una). Stesse
   * regole, su ogni PR; una PR che non è di Stubwise è `unavailable`.
   */
  requestChangesPerPr: z
    .array(z.object({ repo: z.string(), number: z.number().int(), availability: actionAvailabilitySchema }))
    .default([]),
  /**
   * Perché un lavoro nuovo non partirebbe adesso. Sul server vero un avvio a
   * mano scavalca il budget (`manualTrigger`), quindi oggi è sempre `null`:
   * il campo c'è perché la forma è quella del prototipo.
   */
  blocked: z
    .object({ reason: z.enum(["monthly_budget", "queue_paused"]), byId: z.string().optional(), byName: z.string().optional(), since: z.string().optional() })
    .nullable()
    .default(null),
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
    /** Fetta 2: la settimana pianificata (il server la salva come lunedì). */
    plannedWeek: isoWeekSchema.nullable(),
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
  plannedWeek: isoWeekSchema.nullable().optional(),
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
