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

/**
 * Il ticket di ogni sessione (o voce di «Da decidere») letta: le azioni su
 * piano e domande passano dal ticket (`/api/tickets/:id/…`).
 */
export const ticketOfConversation = new Map<string, string>();
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
  if (s.ticketId) ticketOfConversation.set(s.id, s.ticketId);
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

/** Il piano di un job: col suo id, che fa stabile l'id dell'evento (`plan:<job>`). */
export type RunPlan = SessionPlan & { jobId: string };

/**
 * Ciò che di una sessione fa cambiare le letture e il piano: stato, esito,
 * pausa, attesa, domande risposte. Il piano si rilegge solo quando cambia.
 */
export function signatureOf(d: Summary): string {
  const detail = d as Partial<Detail>;
  return JSON.stringify([
    d.state,
    d.outcome,
    d.waitsOnViewer,
    detail.paused ?? false,
    (detail.questions ?? []).map((q) => q.answered),
  ]);
}

/** Il piano letto di ogni sessione, valido finché la sua firma non cambia (review della 3a). */
const planCache = new Map<string, { signature: string; plan: Promise<RunPlan | null> }>();
const PLAN_CACHE_MAX = 50;

export function forgetPlans(): void {
  forgetClaudeCaches();
}

/** Il piano del job della sessione, dal lavoro della sua task (il server non lo mette fra gli eventi). */
export function planOf(detail: Summary): Promise<RunPlan | null> {
  if (detail.kind !== "ai_job" || !detail.ticketId) return Promise.resolve(null);
  const signature = signatureOf(detail);
  const hit = planCache.get(detail.id);
  if (hit && hit.signature === signature) return hit.plan;
  const plan = readPlan(detail, detail.ticketId);
  planCache.delete(detail.id);
  planCache.set(detail.id, { signature, plan });
  if (planCache.size > PLAN_CACHE_MAX) planCache.delete(planCache.keys().next().value!);
  return plan;
}

async function readPlan(detail: Summary, ticketId: string): Promise<RunPlan | null> {
  let work: Reader<TaskWorkView>;
  try {
    work = await appClient().tasks.work(ticketId);
  } catch {
    // Senza il lavoro della task il flusso si legge comunque, senza la scheda del piano.
    planCache.delete(detail.id);
    return null;
  }
  const run = work.runs.find((r) => r.sessionId === detail.id || r.id === detail.aiJobId);
  return run ? sessionPlanOf(run) : null;
}

/** Il flusso del prototipo dagli eventi del server, con domande, interventi e piano. */
export function eventsOf(
  detail: Detail,
  events: readonly Reader<AgentSessionEvent>[],
  partials: Record<string, string>,
  plan: RunPlan | null,
): ConversationEvent[] {
  return withStablePlanId(
    toConversationEvents({
      events,
      partials,
      inputs: detail.inputs,
      questions: detail.questions,
      live: detail.state !== "ended",
      plan,
    }) as ConversationEvent[],
    plan,
  );
}

/**
 * L'evento del piano ha l'id del JOB (`plan:<job>`), non del suo istante: un
 * piano deciso e riletto resta la stessa scheda, mai due.
 */
function withStablePlanId(events: ConversationEvent[], plan: RunPlan | null): ConversationEvent[] {
  if (!plan) return events;
  return events.map((e) => (e.type === "plan" ? { ...e, id: `plan:${plan.jobId}` } : e));
}

// --- permessi del dettaglio ----------------------------------------------------------

/** Ciò che nessuna sessione di lavoro ha: la chat libera (gestire, continuare, refine). */
const NEVER = {
  isOwner: false,
  canContinue: false,
  canManage: false,
  canClose: false,
  canStartNew: false,
  planBlockedReason: null,
} as const;

/** Quanto vale la lettura dei permessi di chi guarda (`/api/auth/me`) per il piano. */
const ME_TTL_MS = 30_000;
let meCache: { at: number; read: Promise<Awaited<ReturnType<ReturnType<typeof appClient>["auth"]["me"]>>> } | null = null;

/**
 * Chi guarda ha `plans.approve` nel progetto: lo calcola il server
 * (`projectPermissions` di `/api/auth/me`), il client lo legge.
 */
async function canApprovePlans(projectId: string): Promise<boolean> {
  if (!meCache || Date.now() - meCache.at > ME_TTL_MS) {
    meCache = { at: Date.now(), read: appClient().auth.me() };
    meCache.read.catch(() => {
      meCache = null;
    });
  }
  const viewer = await meCache.read;
  return (
    viewer.instancePermissions.includes("instance.full_admin") ||
    (viewer.projectPermissions[projectId] ?? []).includes("plans.approve")
  );
}

/** Il piano SALVATO sul ticket e la sua pre-approvazione (valida sul digest), per firma del dettaglio. */
const ticketPlanCache = new Map<string, { signature: string; read: Promise<{ saved: boolean; preApproved: boolean }> }>();

function ticketPlanOf(detail: Detail, ticketId: string): Promise<{ saved: boolean; preApproved: boolean }> {
  const signature = signatureOf(detail);
  const hit = ticketPlanCache.get(detail.id);
  if (hit && hit.signature === signature) return hit.read;
  const read = appClient()
    .tickets.get(ticketId)
    .then((t) => ({
      saved: !!t.implementationPlan,
      preApproved: !!t.planApprovedAt && t.planApprovalStale !== true,
    }));
  read.catch(() => ticketPlanCache.delete(detail.id));
  ticketPlanCache.delete(detail.id);
  ticketPlanCache.set(detail.id, { signature, read });
  if (ticketPlanCache.size > PLAN_CACHE_MAX) ticketPlanCache.delete(ticketPlanCache.keys().next().value!);
  return read;
}

/** Svuota le letture tenute (cambio di persona, test). */
export function forgetClaudeCaches(): void {
  planCache.clear();
  ticketPlanCache.clear();
  meCache = null;
}

/**
 * Cosa può fare chi guarda in una sessione, tutto da quello che dice il
 * server: scrivere e fermare (`canWrite`, `canInterrupt`), rispondere
 * (`canAnswer` della domanda aperta), decidere il piano (in attesa E
 * `waitsOnViewer`: il piano aspetta lui), pre-approvare e revocare
 * (`plans.approve` calcolato dal server, sul piano SALVATO del ticket: il
 * prototipo lo permetteva mentre il piano si scriveva, il server no).
 */
async function permissionsOf(detail: Detail, row: ConversationRow) {
  const live = detail.state !== "ended";
  const open = detail.questions.find((q) => !q.answered);
  const deciding = live && detail.state === "awaiting_approval" && detail.waitsOnViewer;
  let canPreApprovePlan = false;
  let canRevokePlanApproval = false;
  let planPreApproved = false;
  if (row.kind === "task_run" && detail.ticketId && detail.projectId && live) {
    const [approve, plan] = await Promise.all([
      canApprovePlans(detail.projectId).catch(() => false),
      ticketPlanOf(detail, detail.ticketId).catch(() => ({ saved: false, preApproved: false })),
    ]);
    planPreApproved = plan.preApproved;
    canPreApprovePlan = approve && plan.saved && !plan.preApproved && detail.state !== "awaiting_approval";
    canRevokePlanApproval = approve && plan.preApproved;
  }
  const readOnlyReason = detail.canWrite
    ? null
    : !live
      ? ("finished" as const)
      : row.kind !== "task_run"
        ? ("automatic" as const)
        : detail.canIntervene
          ? ("not_interactive" as const)
          : ("no_permission" as const);
  return {
    ...NEVER,
    canWrite: detail.canWrite,
    canInterrupt: detail.canInterrupt,
    canAnswer: live && !!open?.canAnswer,
    canDecidePlan: deciding,
    canRejectPlan: deciding,
    canPreApprovePlan,
    canRevokePlanApproval,
    planPreApproved,
    readOnlyReason,
  };
}

export async function toDetail(
  detail: Detail,
  codes: Map<string, string>,
  events: ConversationEvent[],
): Promise<ConversationDetail | null> {
  const row = toRow(detail, codes, detail.paused);
  if (!row) return null;
  return { ...row, ...(await permissionsOf(detail, row)), events, continuesFrom: null };
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

function sessionPlanOf(run: RunView): RunPlan | null {
  const plan = run.plan;
  if (!plan || !known(plan.status)) return null;
  return {
    jobId: run.id,
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
    return { events: withStablePlanId(events as ConversationEvent[], plan), paused: false };
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
      ticketOfConversation.set(run.sessionId ?? run.id, taskId);
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
