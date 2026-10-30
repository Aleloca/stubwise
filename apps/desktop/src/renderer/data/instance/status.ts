import type { Conversation } from "../model";
import { runHref } from "../routes";
import { serverHref } from "../servers/visibility";
import { currentPhase, eventsOf, familyOf, gate, now, state, visibleProjectIds } from "../store";
import type { ActionAvailability } from "../types";
import { forbidden } from "../writer";
import { canI, nameOf } from "./common";
import { quotaView, type QuotaView } from "./providers";
import { heldJobs, type AiBlock, type JobKind } from "./queue";
import type { AiProvider, NightlyRow } from "./state";

// Lo Stato dell'istanza (area 9b, Task 5): cosa sta facendo Stubwise adesso.
// Il prototipo non ha job, ha sessioni ed esecuzioni (design «Il lavoro nella
// coda»): i lavori si leggono da ciò che c'è.
// - Le sessioni di Claude `task_run` (o `correction` se la fase corrente è
//   una correzione, `server_fix` se corregge un server), `pr_review` e
//   `server_analysis`: `running` se Claude ci sta lavorando, `failed` se
//   sono finite male negli ultimi 7 giorni. Una sessione che aspetta una
//   persona (una domanda, un piano, una pausa a mano) non è lavoro della
//   coda: la dice l'inbox, non questa pagina.
// - I lavori fermi di `holdJob` (`queue.ts`): `waiting`, col loro blocco.
//   Comprendono le esecuzioni delle automazioni ferme per budget (Task 6).
// - Il giro notturno del seme, solo da guardare (`nightly`).
// I due worker simulati prendono i due lavori `running` più vecchi.
//
// R-G5: i lavori dei progetti che chi guarda non vede stanno solo in
// `otherProjects`, coi conteggi; un worker occupato lì è `hidden`, senza id.

export interface InstanceJob {
  id: string;
  kind: JobKind;
  projectId: string;
  projectCode: string;
  title: string;
  /** Task «ACQ-57», esecuzione «ACQ-A2 #7», server «SRV-2» (ruling 17). */
  code: string | null;
  state: "running" | "waiting" | "failed";
  /** Il blocco, solo per `waiting`. */
  waiting: AiBlock | null;
  since: string;
  workerId: "worker-1" | "worker-2" | null;
  retry: ActionAvailability;
  href: string | null;
  /** Solo `failed`: il fallimento in una riga («Tests didn't pass after the fix»). */
  summary: string | null;
}

/** Una riga del giro notturno: solo da guardare, nessuna azione. */
export interface InstanceNightlyRow extends NightlyRow {
  projectCode: string;
}

export interface InstanceStatusView {
  queues: {
    projectId: string;
    code: string;
    name: string;
    paused: { byName: string; at: string } | null;
    running: number;
    waiting: number;
    failed: number;
    pause: ActionAvailability;
  }[];
  otherProjects: { running: number; waiting: number; failed: number } | null;
  jobs: InstanceJob[];
  /** ruling del controller (pre-flight): `hidden` = occupato in un progetto che chi guarda non vede, e allora `jobId` è null (R-G5). */
  workers: { id: "worker-1" | "worker-2"; jobId: string | null; hidden: boolean }[];
  /** Tutti gli account della catena; `quota` è `null` per una chiave API (non ha quota). */
  quota: {
    providerId: string;
    name: string;
    kind: AiProvider["kind"];
    enabled: boolean;
    quota: QuotaView | null;
  }[];
  /** I lavori falliti, il più recente prima, al massimo 5. */
  errors: { jobId: string; at: string; summary: string; href: string | null }[];
  /** Il giro notturno della notte scorsa, dei progetti visibili. */
  nightly: InstanceNightlyRow[];
  refreshedAt: string;
}

const WORKERS = ["worker-1", "worker-2"] as const;
const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ERRORS = 5;

const codeOf = (projectId: string): string => state.projectsById.get(projectId)?.code ?? "";
const taskOf = (taskId: string | null) => (taskId ? state.tasksById.get(taskId) : undefined);
const taskHref = (taskId: string | null): string | null => {
  const task = taskOf(taskId);
  return task ? `#/p/${codeOf(task.projectId)}/tasks?task=${task.code}` : null;
};

/** Il tipo di lavoro di una sessione di Claude, o `null` se non è lavoro della coda. */
export function jobKindOf(c: Conversation): Exclude<JobKind, "automation" | "nightly"> | null {
  switch (c.kind) {
    case "pr_review":
    case "server_analysis":
      return c.kind;
    case "task_run":
      if (currentPhase(eventsOf(c.id)) === "correction") return "correction";
      return c.serverFix ? "server_fix" : "task_run";
    default:
      return null;
  }
}

const isFailed = (c: Conversation): boolean =>
  c.state === "finished" && (c.outcome === "failed" || c.outcome === "timed_out");

/**
 * Si rimette in coda solo l'esecuzione fallita di una task ancora aperta:
 * mai una correzione (si riprende dalla task, `pr-corrections.md`), una
 * correzione di un server o un lavoro di un altro tipo.
 */
export function isRetryable(c: Conversation): boolean {
  if (!isFailed(c) || jobKindOf(c) !== "task_run") return false;
  const task = taskOf(c.taskId);
  return task !== undefined && familyOf(task) !== "closed";
}

type Job = Omit<InstanceJob, "workerId" | "retry">;

function sessionJob(c: Conversation, kind: NonNullable<ReturnType<typeof jobKindOf>>): Job | null {
  const projectId = c.projectId!;
  const failed = isFailed(c);
  if (c.state !== "working" && !failed) return null;
  if (failed && Date.parse(now()) - Date.parse(c.updatedAt) > FAILED_WINDOW_MS) return null;
  const server = c.serverAnalysis?.serverCode ?? c.serverFix?.serverCode ?? null;
  return {
    id: c.id,
    kind,
    projectId,
    projectCode: codeOf(projectId),
    title: c.title,
    code: server ?? taskOf(c.taskId)?.code ?? null,
    state: failed ? "failed" : "running",
    waiting: null,
    since: failed ? c.updatedAt : c.createdAt,
    href:
      kind === "server_analysis" && server
        ? serverHref(codeOf(projectId), server)
        : taskHref(c.taskId),
    summary: failed ? (c.failureSummary ?? null) : null,
  };
}

function heldJob(h: ReturnType<typeof heldJobs>[number]): Job {
  const run = h.automationRunId
    ? state.automationRuns.find((r) => r.id === h.automationRunId)
    : undefined;
  const automation = run ? state.automations.find((a) => a.id === run.automationId) : undefined;
  const conversation = h.conversationId
    ? state.conversations.find((c) => c.id === h.conversationId)
    : undefined;
  const task = taskOf(h.taskId);
  return {
    id: h.conversationId ?? h.automationRunId ?? h.id,
    kind: h.kind,
    projectId: h.projectId,
    projectCode: codeOf(h.projectId),
    title: run?.title ?? conversation?.title ?? task?.title ?? "",
    code: run && automation ? `${automation.code} #${run.n}` : (task?.code ?? null),
    state: "waiting",
    waiting: h.block,
    since: h.since,
    href: run && automation ? runHref(automation.code, run.n) : taskHref(h.taskId),
    summary: null,
  };
}

/** Tutti i lavori dell'istanza, di ogni progetto: la vista poi li divide per chi guarda. */
function allJobs(): Job[] {
  const held = heldJobs();
  const heldSessions = new Set(held.map((h) => h.conversationId).filter(Boolean));
  const sessions = state.conversations.flatMap((c) => {
    const kind = c.projectId !== null && !heldSessions.has(c.id) ? jobKindOf(c) : null;
    const job = kind ? sessionJob(c, kind) : null;
    return job ? [job] : [];
  });
  return [...sessions, ...held.map(heldJob)];
}

const STATE_ORDER = { running: 0, waiting: 1, failed: 2 } as const;

/** In corso e in attesa dal più vecchio (l'ordine dei worker e d'arrivo), i falliti dal più recente. */
function byStateThenAge(a: Job, b: Job): number {
  const s = STATE_ORDER[a.state] - STATE_ORDER[b.state];
  if (s !== 0) return s;
  const age = a.since.localeCompare(b.since) || a.id.localeCompare(b.id);
  return a.state === "failed" ? -age : age;
}

const counts = (jobs: Job[]) => ({
  running: jobs.filter((j) => j.state === "running").length,
  waiting: jobs.filter((j) => j.state === "waiting").length,
  failed: jobs.filter((j) => j.state === "failed").length,
});

/** Cosa sta facendo Stubwise adesso, nei progetti che chi guarda vede (`instance.status.view` o `settings.manage`). */
export async function getInstanceStatus(): Promise<InstanceStatusView> {
  const me = await gate("instance.getInstanceStatus");
  if (!canI(me, "instance.status.view") && !canI(me, "settings.manage")) throw forbidden();
  const visible = visibleProjectIds(me);
  const manages = canI(me, "settings.manage");

  const all = allJobs().sort(byStateThenAge);
  const busy = all.filter((j) => j.state === "running").slice(0, WORKERS.length);
  const workerOf = (j: Job) => WORKERS[busy.indexOf(j)] ?? null;
  const workers = WORKERS.map((id, i) => {
    const job = busy[i];
    const hidden = job !== undefined && !visible.has(job.projectId);
    return { id, jobId: job && !hidden ? job.id : null, hidden };
  });

  const conversations = new Map(state.conversations.map((c) => [c.id, c]));
  const retryOf = (j: Job): ActionAvailability => {
    const c = conversations.get(j.id);
    if (j.state !== "failed" || !c || !isRetryable(c)) return "unavailable";
    return manages && canI(me, "runs.start", j.projectId) ? "allowed" : "forbidden";
  };
  const shown = all.filter((j) => visible.has(j.projectId));
  const jobs: InstanceJob[] = shown.map((j) => ({
    ...j,
    workerId: workerOf(j),
    retry: retryOf(j),
  }));
  const hidden = all.filter((j) => !visible.has(j.projectId));

  const pauses = state.instance.queuePauses.filter((p) => visible.has(p.projectId));
  const queueIds = new Set([...shown.map((j) => j.projectId), ...pauses.map((p) => p.projectId)]);
  const queues = [...queueIds]
    .map((projectId) => {
      const project = state.projectsById.get(projectId)!;
      const pause = pauses.find((p) => p.projectId === projectId);
      return {
        projectId,
        code: project.code,
        name: project.name,
        paused: pause ? { byName: nameOf(pause.byId)!, at: pause.at } : null,
        ...counts(shown.filter((j) => j.projectId === projectId)),
        pause: (manages ? "allowed" : "forbidden") as ActionAvailability,
      };
    })
    // In pausa, poi con lavori falliti, poi per codice.
    .sort(
      (a, b) =>
        Number(b.paused !== null) - Number(a.paused !== null) ||
        Number(b.failed > 0) - Number(a.failed > 0) ||
        a.code.localeCompare(b.code),
    );

  const errors = jobs
    .filter((j) => j.state === "failed")
    .slice(0, MAX_ERRORS)
    .map((j) => ({ jobId: j.id, at: j.since, summary: j.summary ?? "", href: j.href }));

  return {
    queues,
    otherProjects: hidden.length > 0 ? counts(hidden) : null,
    jobs,
    workers,
    quota: state.instance.providers.map((p) => ({
      providerId: p.id,
      name: p.name,
      kind: p.kind,
      enabled: p.enabled,
      quota: quotaView(p),
    })),
    errors,
    nightly: state.instance.nightly
      .filter((r) => visible.has(r.projectId))
      .map((r) => ({ ...r, projectCode: codeOf(r.projectId) })),
    refreshedAt: now(),
  };
}
