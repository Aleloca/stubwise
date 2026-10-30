import type { Conversation } from "../model";
import { runHref } from "../routes";
import { canSeeRun, runById } from "../automations/visibility";
import { serverHref } from "../servers/visibility";
import { currentPhase, eventsOf, familyOf, gate, now, state, visibleProjectIds } from "../store";
import type { ActionAvailability } from "../types";
import { forbidden } from "../writer";
import { canI } from "./common";
import { quotaView, type QuotaView } from "./providers";
import { budgetReached, pauserNameOf } from "./blocks";
import { failedHeldStarts, heldJobs, type AiBlock, type FailedStart, type JobKind } from "./queue";
import type { AiProvider, NightlyRow } from "./state";

// Lo Stato dell'istanza (area 9b, Task 5): cosa sta facendo Stubwise adesso.
// Il prototipo non ha job, ha sessioni ed esecuzioni (design «Il lavoro nella
// coda»): i lavori si leggono da ciò che c'è.
// - Le sessioni di Claude `task_run` (o `correction` se la fase corrente è
//   una correzione, `server_fix` se corregge un server), `pr_review` e
//   `server_analysis`: `running` se Claude ci sta lavorando, `failed` se
//   sono finite male negli ultimi 7 giorni. Una correzione ferma è `waiting`
//   senza blocco (`waiting: null`, Retry `unavailable`: si riprende dalla
//   task; ruling T5 I1), fuori dai worker e dai conteggi «waiting». Le altre
//   sessioni che aspettano una persona (una domanda, un piano) non sono
//   lavoro della coda: le dice l'inbox, non questa pagina.
// - I lavori fermi di `holdJob` (`queue.ts`): `waiting`, col loro blocco.
//   Comprendono le esecuzioni delle automazioni ferme per budget (Task 6).
//   Una ripartenza la cui `start` è fallita è `failed`, con la frase
//   (ruling T5 I2).
// - Il giro notturno del seme, solo da guardare (`nightly`).
// I due worker simulati prendono i due lavori `running` più vecchi.
//
// R-G5: i lavori dei progetti che chi guarda non vede stanno solo in
// `otherProjects`, coi conteggi; un worker occupato lì è `hidden`, senza id.

export interface InstanceJob {
  id: string;
  kind: JobKind;
  /**
   * `null`: un passo di un'automazione generale fermo per il budget prima di
   * agire in un progetto. Lo vede chi vede l'automazione; nessuna coda,
   * mai fra i progetti nascosti (revisione finale I2).
   */
  projectId: string | null;
  projectCode: string;
  title: string;
  /** Task «ACQ-57», esecuzione «ACQ-A2 #7», server «SRV-2» (ruling 17). */
  code: string | null;
  state: "running" | "waiting" | "failed";
  /** Il blocco, solo per `waiting`; `null` su una correzione ferma (aspetta una persona). */
  waiting: AiBlock | null;
  since: string;
  workerId: "worker-1" | "worker-2" | null;
  retry: ActionAvailability;
  /**
   * Con `retry` `forbidden`, il permesso che manca (Task 13: la pagina mette
   * il «Who?» di quello, senza ricalcolare la regola): `manageSettings`
   * prima, poi `startRun` nel progetto. `null` altrimenti.
   */
  retryNeeds: "manageSettings" | "startRun" | null;
  /**
   * Con i permessi giusti, il blocco che spegne Retry: il budget del mese
   * raggiunto (`retry` `forbidden`, `retryNeeds` `null`). La pagina mette
   * la frase del budget sopra il bottone spento (shape EF §2: «Avvia» è
   * rifiutato prima e dopo). La pausa non spegne Retry: il lavoro aspetta.
   */
  retryBlock: { reason: "monthly_budget" } | null;
  /**
   * Con `retry` `allowed`: chi riprova non ha `plans.approve` nel progetto,
   * quindi Claude si ferma al piano (il gate di «Avvia», `planGateFor`).
   */
  retryStopsAtPlan: boolean;
  href: string | null;
  /** Solo `failed`: il fallimento in una riga («Tests didn't pass after the fix»). */
  summary: string | null;
  /**
   * Una ripartenza fallita (ruling T5 I2): `summary` è il messaggio
   * dell'errore («conflict», «invalid: monthly_budget»), non una frase; la
   * pagina lo traduce quando lo legge.
   */
  startFailed: boolean;
  /**
   * Solo `failed`: la task ha già un lavoro più recente (una sessione nata
   * dopo, o un lavoro fermo sulla task), quindi questo non si rimette più in
   * coda (`retry` `unavailable`, `newerWorkOf`). La riga resta, con la frase.
   */
  superseded: boolean;
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
    /** `byId`: la pagina aggiunge «(deactivated)» se la persona è stata disattivata. */
    paused: { byId: string; byName: string; at: string } | null;
    running: number;
    waiting: number;
    failed: number;
    pause: ActionAvailability;
    /**
     * Quanti dei lavori in attesa della pausa resterebbero fermi alla
     * ripresa, perché il budget del mese è raggiunto (il dialogo di Resume).
     */
    budgetAfterResume: number;
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
  /** `startFailed`: `summary` è un messaggio d'errore da tradurre, come in `InstanceJob`. */
  errors: {
    jobId: string;
    at: string;
    summary: string;
    startFailed: boolean;
    href: string | null;
  }[];
  /** Il giro notturno della notte scorsa, dei progetti visibili. */
  nightly: InstanceNightlyRow[];
  refreshedAt: string;
}

const WORKERS = ["worker-1", "worker-2"] as const;
const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ERRORS = 5;

const codeOf = (projectId: string | null): string =>
  projectId === null ? "" : (state.projectsById.get(projectId)?.code ?? "");
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
export function isRetryableKind(c: Conversation): boolean {
  if (!isFailed(c) || jobKindOf(c) !== "task_run") return false;
  const task = taskOf(c.taskId);
  return task !== undefined && familyOf(task) !== "closed";
}

/**
 * Il lavoro più recente sulla stessa task, se c'è: una sessione di lavoro
 * nata dopo `c` (a pari istante, quella aggiunta dopo) o un lavoro fermo
 * sulla task. Allora `c` è superato e non si rimette più in coda — un
 * secondo Retry avvierebbe un'altra esecuzione su una task già rimessa in
 * coda (revisione T13, I1). `live`: quel lavoro non è ancora finito.
 */
export function newerWorkOf(c: Conversation): { live: boolean } | null {
  if (!c.taskId) return null;
  if (heldJobs().some((h) => h.taskId === c.taskId && h.conversationId === null))
    return { live: true };
  const index = state.conversations.indexOf(c);
  const later = state.conversations.filter(
    (o, i) =>
      o !== c &&
      o.taskId === c.taskId &&
      o.kind === "task_run" &&
      (o.createdAt > c.createdAt || (o.createdAt === c.createdAt && i > index)),
  );
  if (later.length === 0) return null;
  return { live: later.some((o) => o.state !== "finished") };
}

/** Si rimette in coda: l'esecuzione fallita di una task aperta (`isRetryableKind`), non superata. */
export function isRetryable(c: Conversation): boolean {
  return isRetryableKind(c) && newerWorkOf(c) === null;
}

type Job = Omit<
  InstanceJob,
  "workerId" | "retry" | "retryNeeds" | "retryBlock" | "retryStopsAtPlan"
>;

function sessionJob(c: Conversation, kind: NonNullable<ReturnType<typeof jobKindOf>>): Job | null {
  const projectId = c.projectId!;
  const failed = isFailed(c);
  // Una correzione ferma (ruling T5 I1) si mostra in attesa, senza blocco:
  // si riprende dalla task, non dalla coda.
  const stalledCorrection = kind === "correction" && c.state === "paused";
  if (c.state !== "working" && !failed && !stalledCorrection) return null;
  if (failed && Date.parse(now()) - Date.parse(c.updatedAt) > FAILED_WINDOW_MS) return null;
  const server = c.serverAnalysis?.serverCode ?? c.serverFix?.serverCode ?? null;
  return {
    id: c.id,
    kind,
    projectId,
    projectCode: codeOf(projectId),
    title: c.title,
    code: server ?? taskOf(c.taskId)?.code ?? null,
    state: failed ? "failed" : stalledCorrection ? "waiting" : "running",
    waiting: null,
    since: failed || stalledCorrection ? c.updatedAt : c.createdAt,
    href:
      kind === "server_analysis" && server
        ? serverHref(codeOf(projectId), server)
        : taskHref(c.taskId),
    summary: failed ? (c.failureSummary ?? null) : null,
    superseded: failed && kind === "task_run" && newerWorkOf(c) !== null,
    startFailed: false,
  };
}

/** Una ripartenza fallita (ruling T5 I2): un lavoro fallito con la sua frase, senza Retry. */
function failedStartJob(f: FailedStart): Job {
  return {
    ...heldJob(f),
    id: f.id,
    state: "failed",
    waiting: null,
    since: f.failedAt,
    summary: f.summary,
    startFailed: true,
    superseded: false,
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
    startFailed: false,
    superseded: false,
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
  return [...sessions, ...held.map(heldJob), ...failedHeldStarts().map(failedStartJob)];
}

const STATE_ORDER = { running: 0, waiting: 1, failed: 2 } as const;

/** In corso e in attesa dal più vecchio (l'ordine dei worker e d'arrivo), i falliti dal più recente. */
function byStateThenAge(a: Job, b: Job): number {
  const s = STATE_ORDER[a.state] - STATE_ORDER[b.state];
  if (s !== 0) return s;
  const age = a.since.localeCompare(b.since) || a.id.localeCompare(b.id);
  return a.state === "failed" ? -age : age;
}

// «waiting» conta solo i lavori fermi da un blocco, quelli che partono alla
// ripresa o col budget: una correzione ferma aspetta una persona.
const counts = (jobs: Job[]) => ({
  running: jobs.filter((j) => j.state === "running").length,
  waiting: jobs.filter((j) => j.state === "waiting" && j.waiting !== null).length,
  failed: jobs.filter((j) => j.state === "failed").length,
});

/** Cosa sta facendo Stubwise adesso, nei progetti che chi guarda vede (`instance.status.view` o `settings.manage`). */
export async function getInstanceStatus(): Promise<InstanceStatusView> {
  const me = await gate("instance.getInstanceStatus");
  if (!canI(me, "instance.status.view") && !canI(me, "settings.manage")) throw forbidden();
  const visible = visibleProjectIds(me);
  const manages = canI(me, "settings.manage");

  const all = allJobs().sort(byStateThenAge);
  // Un lavoro senza progetto (un passo d'automazione generale fermo per il
  // budget) lo vede chi vede l'esecuzione; non è mai di un progetto nascosto.
  const sees = (j: Job): boolean => {
    if (j.projectId !== null) return visible.has(j.projectId);
    const run = j.kind === "automation" ? runById(j.id) : undefined;
    return run !== undefined && canSeeRun(me, run);
  };
  const inHiddenProject = (j: Job): boolean => j.projectId !== null && !visible.has(j.projectId);
  const busy = all.filter((j) => j.state === "running").slice(0, WORKERS.length);
  const workerOf = (j: Job) => WORKERS[busy.indexOf(j)] ?? null;
  const workers = WORKERS.map((id, i) => {
    const job = busy[i];
    const hidden = job !== undefined && !sees(job);
    return { id, jobId: job && !hidden ? job.id : null, hidden };
  });

  const conversations = new Map(state.conversations.map((c) => [c.id, c]));
  const permittedOf = (j: Job): ActionAvailability => {
    const c = conversations.get(j.id);
    if (j.state !== "failed" || !c || !isRetryable(c) || j.projectId === null) return "unavailable";
    return manages && canI(me, "runs.start", j.projectId) ? "allowed" : "forbidden";
  };
  // Il budget vale per tutti i progetti: una lettura sola per la vista.
  const budget = budgetReached();
  const shown = all.filter(sees);
  const jobs: InstanceJob[] = shown.map((j) => {
    const permitted = permittedOf(j);
    const retryBlock =
      permitted === "allowed" && budget ? { reason: "monthly_budget" as const } : null;
    const retry = retryBlock ? "forbidden" : permitted;
    return {
      ...j,
      workerId: workerOf(j),
      retry,
      retryNeeds: permitted !== "forbidden" ? null : manages ? "startRun" : "manageSettings",
      retryBlock,
      retryStopsAtPlan:
        retry === "allowed" && j.projectId !== null && !canI(me, "plans.approve", j.projectId),
    };
  });
  const hidden = all.filter(inHiddenProject);

  const pauses = state.instance.queuePauses.filter((p) => visible.has(p.projectId));
  const queueIds = new Set([
    ...shown.flatMap((j) => (j.projectId === null ? [] : [j.projectId])),
    ...pauses.map((p) => p.projectId),
  ]);
  const queues = [...queueIds]
    .map((projectId) => {
      const project = state.projectsById.get(projectId)!;
      const pause = pauses.find((p) => p.projectId === projectId);
      return {
        projectId,
        code: project.code,
        name: project.name,
        paused: pause ? { byId: pause.byId, byName: pauserNameOf(pause.byId), at: pause.at } : null,
        ...counts(shown.filter((j) => j.projectId === projectId)),
        pause: (manages ? "allowed" : "forbidden") as ActionAvailability,
        // Alla ripresa un lavoro riparte solo senza altri blocchi (`release`):
        // col budget raggiunto non riparte niente — né quelli fermi per la
        // pausa né quelli arrivati dopo il budget, già fermi per lui (I2).
        // Gli stessi che `counts` dice «waiting».
        budgetAfterResume:
          pause && budgetReached()
            ? shown.filter((j) => j.projectId === projectId && j.waiting !== null).length
            : 0,
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
    .map((j) => ({
      jobId: j.id,
      at: j.since,
      summary: j.summary ?? "",
      startFailed: j.startFailed,
      href: j.href,
    }));

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
