/**
 * Il lavoro di Claude su una task, nella forma del PROTOTIPO (integrazione
 * area 3, fetta 3a): le sessioni di lavoro (`TaskRun`) col loro flusso di
 * eventi (`ConversationEvent`), le PR, i fatti esterni delle PR, le decisioni
 * sui piani, le azioni possibili.
 *
 * Sono i tipi che leggono i moduli puri di qui (`task-work.ts`,
 * `pr-corrections.ts`, `session-events.ts`) e che l'adattatore degli eventi
 * del server produce. Il desktop ha le sue definizioni, più ricche
 * (`apps/desktop/src/renderer/data/{model,types}.ts`: le conversazioni libere,
 * le proposte, le schede di 10a/10b): devono restare ASSEGNABILI a queste — il
 * typecheck del desktop lo verifica a ogni chiamata dei moduli condivisi. Un
 * campo che il desktop aggiunge a una di queste forme va aggiunto qui come
 * facoltativo (o `unknown`), non tolto di là.
 */

export type Outcome = "ok" | "failed" | "timed_out" | "stopped";

export type ConversationState = "working" | "awaiting_answer" | "awaiting_approval" | "paused" | "idle" | "finished";

/** Una PR: repository (`owner/repo`) e numero. */
export interface PrRef {
  repo: string;
  number: number;
}

/** Un evento di una pull request di una task, dalla piattaforma. */
export interface PullRequestEvent {
  id: string;
  projectId: string;
  taskId: string;
  kind: "pr_opened" | "pr_merged" | "pr_closed";
  at: string;
  number: number;
  repo: string;
}

/** Con chi gira una sessione: solo il NOME dell'account o della chiave, mai il segreto. */
export interface RunProvider {
  kind: "account" | "api_key";
  name: string;
  id?: string;
}

/** Perché un lavoro AI nuovo non parte adesso (il budget del mese, la coda in pausa). */
export type AiBlock =
  | { reason: "monthly_budget" }
  | { reason: "queue_paused"; byId: string; byName: string; since: string };

/** I fatti esterni di una PR che il ciclo review → correzione legge (il ciclo si deriva, `prCycles`). */
export interface PrFactView extends PrRef {
  review: {
    verdict: "pending" | "approved" | "changes_requested";
    at: string;
    /** Chi ha chiesto le modifiche, se una persona; `null` il revisore. */
    byId: string | null;
    on: "stubwise" | "platform" | null;
  } | null;
  branchProtected: boolean;
  /** Una correzione chiesta aspetta che finisca il lavoro in corso sulla task. */
  queued: boolean;
}

export interface PlanDecision {
  decidedById: string | null;
  decidedAt: string;
  /** Il testo del registro (un template nella lingua di chi ha deciso). */
  decision: string;
  status: "approved" | "rejected";
}

export type RunAction = "start" | "relaunch" | "resume" | "requestChanges";

/**
 * `allowed`: si può fare; `forbidden`: lo stato lo consente ma chi guarda
 * non ha il permesso; `unavailable`: lo stato non lo consente.
 */
export type ActionAvailability = "allowed" | "forbidden" | "unavailable";

/** I consumi di una sessione per modello. */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

type Base = { id: string; at: string };

export type UserEvent = Base & {
  type: "user";
  /** `""` se chi ha scritto non si sa più (utente eliminato). */
  authorId: string;
  text: string;
  attachments: readonly unknown[];
  delivery: "pending" | "delivered" | "undelivered";
  undeliveredReason?: string;
  context?: unknown;
};

/** `text` cresce mentre arriva; `done` quando il messaggio è completo. */
export type AssistantEvent = Base & { type: "assistant"; text: string; done: boolean; productWeek?: unknown };

export type ActionEvent = Base & {
  type: "action";
  tool: string;
  label: string;
  labelText?: unknown;
  input?: string;
  result?: string;
  resultText?: unknown;
  state: "running" | "done" | "failed";
  truncated?: boolean;
  access?: "read" | "fix";
};

export type PhaseEvent = Base & {
  type: "phase";
  phase: string;
  outcome: Outcome | null;
  stoppedById?: string;
  closedById?: string;
  reason?: "item_closed" | "fix_access_revoked" | "fix_access_unusable" | "server_gone";
  pr?: PrRef;
};

export type QuestionEvent = Base & {
  type: "question";
  questionId: string;
  text: string;
  options: { label: string; consequence?: string; recommended?: boolean; departmentId?: string }[];
  answer: { optionIndex: number | null; text: string | null; byId: string; at: string } | null;
  resume?: string;
};

export type PlanEvent = Base & {
  type: "plan";
  planText: string;
  summary: string;
  commands?: { input: string; why: string }[];
  status: "pending" | "approved" | "rejected" | "pre_approved";
  decidedById?: string;
  instructions?: string;
};

export type WorkResultEvent = Base & {
  type: "work_result";
  kind:
    | "pr_opened"
    | "review"
    | "correction"
    | "design_updated"
    | "plan_updated"
    | "estimate_updated"
    | "server_diagnosis"
    | "server_check";
  text: string;
  link?: string;
  requestPatch?: unknown;
  resolved?: boolean;
  detail?: string;
};

/** Gli eventi che una sessione di LAVORO porta (e che l'adattatore del server produce). */
export type WorkEvent =
  | UserEvent
  | AssistantEvent
  | ActionEvent
  | PhaseEvent
  | QuestionEvent
  | PlanEvent
  | WorkResultEvent;

/**
 * Gli eventi delle conversazioni del prototipo che i moduli del lavoro non
 * leggono (citazioni, proposte, schede): ci sono solo perché un flusso del
 * desktop li mescola a quelli del lavoro.
 */
export type ForeignEvent = Base & {
  type: "citation" | "proposal" | "executed" | "trial" | "aside" | "capabilities" | "draft" | "pageAction";
};

export type ConversationEvent = WorkEvent | ForeignEvent;

/** Una sessione di lavoro della task, quanto ne leggono la sezione «Claude» e la storia del lavoro. */
export interface TaskRun {
  id: string;
  ownerId: string;
  createdAt: string;
  state: ConversationState;
  outcome: Outcome | null;
  /** Il flusso che chi guarda può leggere. */
  events: readonly ConversationEvent[];
  provider: RunProvider | null;
  failureSummary: string | null;
  model: string | null;
  waiting: AiBlock | null;
  queued: { resumedById: string | null; resumedAt: string | null } | null;
  executionModel: string | null;
  requiredProvider: { name: string } | null;
  skills: { plugin: string; skill: string }[] | null;
}

/**
 * Il lavoro di Claude su una task come lo vede chi guarda (la forma del
 * prototipo). Sul server vero lo costruisce l'app dalla risposta di
 * `GET /api/tasks/:id/work` più gli eventi delle sessioni.
 */
export interface TaskWork {
  runs: readonly TaskRun[];
  pullRequests: readonly PullRequestEvent[];
  software: boolean;
  openPr: boolean;
  planDecisions: readonly PlanDecision[];
  waitsOnViewer: boolean;
  hiddenRuns: boolean;
  actions: Record<RunAction, ActionAvailability>;
  prFacts: readonly PrFactView[];
  correctionCap: number;
  usage: readonly ModelUsage[];
  blocked: AiBlock | null;
}
