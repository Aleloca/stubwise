import { ApiError } from "@stubwise/api-client";
import {
  toConversationEvents,
  type AgentSessionDetail,
  type AgentSessionEvent,
  type AgentSessionKind,
  type AgentSessionState,
  type AgentSessionSummary,
  type Reader,
  type SessionPlan,
  type TaskWorkView,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type {
  ConversationActivity,
  ConversationDetail,
  ConversationEvent,
  ConversationKind,
  ConversationRow,
  ConversationState,
  Outcome,
} from "../../types";
import { appClient } from "./client";
import { listProjects } from "./projects";

// Le sessioni di lavoro di Claude nella build app (integrazione area 3, fetta
// 3a «Guardare»): la pagina Claude, il riquadro (una sessione seguita) e la
// sezione Claude della task le leggono da `/api/agent-sessions`, in LETTURA.
// La chat libera (`free`: «mine», «public») resta «in arrivo» e non legge
// niente. Chi vede una sessione e cosa può farci lo decide il server
// (`docs/invariants/agent-sessions.md`); nella 3a nessuna azione: i permessi
// del dettaglio sono tutti spenti, con `readOnlyReason: "not_interactive"`.

type Summary = Reader<AgentSessionSummary>;
type Detail = Reader<AgentSessionDetail>;

/** Il tipo di sessione del server in quello del prototipo; `null` se questa app non lo conosce. */
const KIND_OF: Partial<Record<AgentSessionKind, ConversationKind>> = {
  ai_job: "task_run",
  pr_review: "pr_review",
  backlog_refine: "refine",
  backlog_item: "intake",
  backlog_job: "intake",
  doc_generation: "docs",
  project_brief: "brief",
  daily_report: "daily_report",
  email_message: "mail_classify",
};

/** Il filtro per tipo del prototipo sul server; l'intake ha due tipi e si filtra qui. */
const SERVER_KIND_OF: Partial<Record<ConversationKind, AgentSessionKind>> = {
  task_run: "ai_job",
  pr_review: "pr_review",
  refine: "backlog_refine",
  docs: "doc_generation",
  brief: "project_brief",
  daily_report: "daily_report",
  mail_classify: "email_message",
};

/**
 * Lo stato derivato del server in quello del prototipo: `queued` (in coda) si
 * legge al lavoro, `held` (parcheggiata: limite, budget, gate) ferma, come fa
 * `/api/tasks/:id/work`; «In pausa» per uno «Ferma» lo dice `paused`.
 */
function stateOf(state: AgentSessionState | "__unknown__", paused = false): ConversationState {
  if (paused) return "paused";
  switch (state) {
    case "working":
    case "queued":
      return "working";
    case "waiting_input":
      return "awaiting_answer";
    case "awaiting_approval":
      return "awaiting_approval";
    case "held":
    case "idle":
      return "idle";
    case "ended":
      return "finished";
    default:
      return "working";
  }
}

function outcomeOf(s: Summary): Outcome | null {
  if (s.state !== "ended") return null;
  switch (s.outcome) {
    case "completed":
      return "ok";
    case "failed":
      return "failed";
    case "skipped":
      return "stopped";
    default:
      return null;
  }
}

function activityOf(s: Summary, state: ConversationState): ConversationActivity {
  if (state === "awaiting_answer") return { kind: "question" };
  if (state === "awaiting_approval") return { kind: "plan" };
  if (state !== "working" || !s.lastActivity) return null;
  return { kind: "action", label: s.lastActivity.target ?? s.lastActivity.kind };
}

/** I codici dei progetti visibili, per il codice della task di una sessione («AUD-12»). */
async function projectCodes(): Promise<Map<string, string>> {
  return new Map((await listProjects()).map((p) => [p.id, p.code] as const));
}

function toRow(s: Summary, codes: Map<string, string>, paused = false): ConversationRow | null {
  const kind = KIND_OF[s.kind as AgentSessionKind];
  if (!kind) return null;
  const state = stateOf(s.state, paused);
  const code = s.projectId ? codes.get(s.projectId) : undefined;
  return {
    id: s.id,
    kind,
    title: s.title,
    // Il server non dice chi ha chiesto la sessione: chi l'ha avviata lo dice il lavoro della task.
    ownerId: "",
    projectId: s.projectId,
    contextProjectId: null,
    taskId: s.ticketId,
    requestId: s.backlogItemId,
    state,
    outcome: outcomeOf(s),
    visibility: "project",
    publishedAt: null,
    publishedById: null,
    touchedProjectIds: [],
    privateFromIndex: null,
    publishedProjectIds: [],
    continuesFromId: null,
    createdAt: s.startedAt,
    updatedAt: s.lastEventAt ?? s.startedAt,
    archived: false,
    objectCode: code && s.ticketNumber !== null ? `${code}-${s.ticketNumber}` : null,
    activity: activityOf(s, state),
    privateTail: false,
    waitsOnViewer: s.waitsOnViewer,
  };
}

/**
 * Le sessioni di lavoro per la pagina Claude: `live` le non concluse,
 * `finished` le concluse (quelle che il server tiene fra le recenti: il suo
 * tetto vale anche con `includeOlder`). La chat libera non è integrata.
 */
export const listConversations: typeof Fake.listConversations = async (filter) => {
  if (filter.scope === "mine" || filter.scope === "public") return [];
  const serverKind = filter.kind ? SERVER_KIND_OF[filter.kind] : undefined;
  if (filter.kind === "free") return [];
  const [list, codes] = await Promise.all([
    appClient().agentSessions.list({
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.taskId ? { ticketId: filter.taskId } : {}),
      ...(serverKind ? { kind: serverKind } : {}),
    }),
    projectCodes(),
  ]);
  const source = filter.scope === "live" ? list.live : list.recent.filter((s) => s.state === "ended");
  return source
    .flatMap((s) => toRow(s, codes) ?? [])
    .filter(
      (r) =>
        (!filter.kind || r.kind === filter.kind) &&
        (!filter.outcome || r.outcome === filter.outcome) &&
        (!filter.requestId || r.requestId === filter.requestId),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
};

// --- dettaglio ---------------------------------------------------------------------

/** Quanti eventi per pagina si leggono (il massimo del server). */
const EVENTS_PAGE = 500;

/** Tutti gli eventi di una sessione dopo `after`, in ordine. */
export async function readEvents(id: string, after?: string): Promise<Reader<AgentSessionEvent>[]> {
  const out: Reader<AgentSessionEvent>[] = [];
  let cursor = after;
  for (;;) {
    const page = await appClient().agentSessions.events(id, {
      ...(cursor ? { after: cursor } : {}),
      limit: EVENTS_PAGE,
    });
    out.push(...page.events);
    if (page.events.length < EVENTS_PAGE) return out;
    cursor = page.events.at(-1)!.id;
  }
}

/** Il piano del job della sessione, dal lavoro della sua task (il server non lo mette fra gli eventi). */
export async function planOf(detail: Summary): Promise<SessionPlan | null> {
  if (detail.kind !== "ai_job" || !detail.ticketId) return null;
  let work: Reader<TaskWorkView>;
  try {
    work = await appClient().tasks.work(detail.ticketId);
  } catch {
    // Senza il lavoro della task il flusso si legge comunque, senza la scheda del piano.
    return null;
  }
  const run = work.runs.find((r) => r.sessionId === detail.id || r.id === detail.aiJobId);
  const plan = run?.plan;
  if (!plan || plan.status === "__unknown__") return null;
  return {
    text: plan.text,
    summary: plan.summary,
    // Pre-approvato vale come approvato: la scheda non chiede niente.
    status: plan.status === "pre_approved" ? "approved" : plan.status,
    at: plan.at,
  };
}

/** Il flusso del prototipo dagli eventi del server, con domande, interventi e piano. */
export function eventsOf(
  detail: Detail,
  events: readonly Reader<AgentSessionEvent>[],
  partials: Record<string, string>,
  plan: SessionPlan | null,
): ConversationEvent[] {
  return toConversationEvents({
    events,
    partials,
    inputs: detail.inputs,
    questions: detail.questions,
    live: detail.state !== "ended",
    plan,
  }) as ConversationEvent[];
}

/** Nella 3a si guarda e basta: le azioni arrivano con la 3b. */
const READ_ONLY = {
  isOwner: false,
  canWrite: false,
  canInterrupt: false,
  canAnswer: false,
  canDecidePlan: false,
  canRejectPlan: false,
  canPreApprovePlan: false,
  canRevokePlanApproval: false,
  canContinue: false,
  canManage: false,
  canClose: false,
  canStartNew: false,
  readOnlyReason: "not_interactive",
  planBlockedReason: null,
} as const;

export function toDetail(
  detail: Detail,
  codes: Map<string, string>,
  events: ConversationEvent[],
): ConversationDetail | null {
  const row = toRow(detail, codes, detail.paused);
  if (!row) return null;
  return { ...row, ...READ_ONLY, events, planPreApproved: false, continuesFrom: null };
}

/** Una sessione invisibile, o inesistente, risponde 404: `null`. */
export const getConversation: typeof Fake.getConversation = async (id) => {
  let detail: Detail;
  try {
    detail = await appClient().agentSessions.get(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  const [events, plan, codes] = await Promise.all([readEvents(id), planOf(detail), projectCodes()]);
  return toDetail(detail, codes, eventsOf(detail, events, {}, plan));
};

// --- il lavoro di una task ------------------------------------------------------------

type WorkView = Reader<TaskWorkView>;
type RunView = WorkView["runs"][number];

const known = <T extends string>(v: T | "__unknown__"): v is T => v !== "__unknown__";

function sessionPlanOf(run: RunView): SessionPlan | null {
  const plan = run.plan;
  if (!plan || !known(plan.status)) return null;
  return {
    text: plan.text,
    summary: plan.summary,
    status: plan.status === "pre_approved" ? "approved" : plan.status,
    at: plan.at,
  };
}

/** Gli eventi di una sessione di lavoro, letti dalla sessione (non da `/work`); una che non si vede: vuoti. */
async function runEvents(run: RunView): Promise<{ events: ConversationEvent[]; paused: boolean }> {
  const plan = sessionPlanOf(run);
  if (!run.sessionId) {
    const events = toConversationEvents({ events: [], partials: {}, inputs: [], questions: [], live: true, plan });
    return { events: events as ConversationEvent[], paused: false };
  }
  try {
    const [detail, raw] = await Promise.all([
      appClient().agentSessions.get(run.sessionId),
      readEvents(run.sessionId),
    ]);
    return { events: eventsOf(detail, raw, {}, plan), paused: detail.paused };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { events: [], paused: false };
    throw error;
  }
}

/**
 * Il lavoro di Claude su una task, nella forma del prototipo: le sessioni di
 * lavoro e le PR da `GET /api/tasks/:id/work` (le azioni le calcola il
 * server), gli eventi di ogni sessione dalla sessione stessa. Un server più
 * vecchio senza i campi della 3a dà un lavoro vuoto (i default dello schema):
 * la sezione degrada, non si rompe. Una task invisibile: `null`.
 */
export const getTaskWork: typeof Fake.getTaskWork = async (taskId) => {
  let work: WorkView;
  try {
    work = await appClient().tasks.work(taskId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  const runs = await Promise.all(
    work.runs.map(async (run) => {
      const { events, paused } = await runEvents(run);
      return {
        id: run.sessionId ?? run.id,
        // Il sistema o un utente eliminato: nessuno (la sezione dice «someone»).
        ownerId: run.ownerId ?? "",
        createdAt: run.createdAt,
        state: paused ? ("paused" as const) : known(run.state) ? run.state : ("working" as const),
        outcome: run.outcome && known(run.outcome) ? run.outcome : null,
        events,
        provider: run.provider && known(run.provider.kind) ? { kind: run.provider.kind, name: run.provider.name } : null,
        failureSummary: run.failureSummary,
        model: null,
        waiting: null,
        queued: null,
        executionModel: null,
        requiredProvider: null,
        skills: null,
      };
    }),
  );
  const availability = (v: string) =>
    v === "allowed" || v === "forbidden" ? (v as "allowed" | "forbidden") : ("unavailable" as const);
  return {
    runs,
    pullRequests: work.prEvents.flatMap((e) =>
      known(e.kind) ? [{ id: e.id, projectId: "", taskId, kind: e.kind, at: e.at, number: e.number, repo: e.repo }] : [],
    ),
    software: work.software,
    openPr: work.openPr,
    planDecisions: work.planDecisions.flatMap((d) =>
      known(d.status)
        ? [{ decidedById: d.decidedById, decidedAt: d.decidedAt, decision: d.decision, status: d.status }]
        : [],
    ),
    waitsOnViewer: work.waitsOnViewer,
    hiddenRuns: work.hiddenRuns,
    actions: {
      start: availability(work.actions.start),
      relaunch: availability(work.actions.relaunch),
      resume: availability(work.actions.resume),
      requestChanges: availability(work.actions.requestChanges),
    },
    prFacts: work.prFacts.map((f) => ({
      repo: f.repo,
      number: f.number,
      review:
        f.review && known(f.review.verdict)
          ? {
              verdict: f.review.verdict,
              at: f.review.at,
              byId: f.review.byId,
              on: f.review.on && known(f.review.on) ? f.review.on : null,
            }
          : null,
      branchProtected: f.branchProtected,
      queued: f.queued,
    })),
    correctionCap: work.correctionCap,
    // I consumi per task non li manda ancora `/work`.
    usage: [],
    // Sul server vero un avvio a mano scavalca il budget: oggi sempre `null`.
    blocked: null,
  };
};
