import {
  advance,
  initialState,
  type EngineInput,
  type EngineState,
  type EngineStep,
} from "../../domain/automations/engine";
import { render } from "../../domain/automations/preview";
import { restoreState } from "../../domain/automations/restore";
import { aiBlockFor } from "../instance/blocks";
import { dropHeld, heldJobs, holdJob } from "../instance/queue";
import { runHref } from "../routes";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { copy, gate, newId, now, onStoreReset, state, storeGeneration } from "../store";
import type {
  AiBlock,
  Automation,
  AutomationRun,
  ReasonCode,
  RunLogEntry,
  RunStatus,
} from "../types";
import { executeEffect } from "./effects";
import {
  approvalProjectOf,
  approversFor,
  automationById,
  decidersOf,
  flowOf,
  runById,
  runCode,
  stepOfRun,
} from "./visibility";

// Chi fa avanzare le esecuzioni (area 7): prende un input, lo passa al
// motore puro (`advance`), dà gli effetti richiesti all'unico esecutore
// (`effects.ts`) e rimette l'esito nel motore, finché l'esecuzione si ferma
// (un'attesa, la fine, un errore). Lo stato vero è il record
// `AutomationRun`: a ogni input il motore lo riprende da lì (`restoreState`).
//
// - Gli input di un'esecuzione passano uno alla volta (`inTurn`).
// - Ogni effetto aspetta il ritardo simulato (`gate("automations.advanceRun")`,
//   `failNext` lo fa fallire: il passo fallisce senza essere eseguito); un
//   ripristino (`resetApi`) nel frattempo ferma tutto prima che scriva.
// - Pausa: un'esecuzione non si sospende MAI con un effetto in volo. Si
//   sospende al confine del passo: prima di eseguire l'effetto seguente,
//   che resta da fare (il cursore punta lì) e riparte riaccendendo.
// - Le esecuzioni finite, fallite, annullate o sospese ignorano gli input
//   (un evento arrivato in pausa non si recupera): ripartono solo da
//   «Riprova», «Salta» e dalla riaccensione, che le rimettono in corsa.

export const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "failed", "cancelled"]);
export const isOpen = (run: AutomationRun): boolean => !TERMINAL.has(run.status);

/** Il massimo di esecuzioni non finite per automazione (Global Constraints). */
export const MAX_ACTIVE_RUNS = 100;

/** L'«adesso» di un'esecuzione: quello del prototipo, o più avanti con «Fai passare il tempo». */
export const runNow = (run: AutomationRun): string => state.automationClock.get(run.id) ?? now();

const personName = (id: string) => PEOPLE.find((p) => p.id === id)?.name ?? id;

// --- coda e attesa ------------------------------------------------------------------

const turns = new Map<string, Promise<void>>();
const pending = new Set<Promise<void>>();
/** Gli input in coda (o in corso) per esecuzione: la pausa non li scavalca. */
const queued = new Map<string, number>();
onStoreReset(() => {
  turns.clear();
  queued.clear();
});

/** Si risolve quando nessuna esecuzione sta più avanzando. */
export async function whenAutomationsIdle(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

const settledListeners = new Set<() => void>();

/**
 * Avvisa quando le esecuzioni hanno finito di avanzare (la coda si è
 * svuotata), o quando una lettura ne ha fatta fallire una (R-J11): le
 * esecuzioni le muovono anche le scritture delle altre aree (una task
 * chiusa, un'email arrivata), e chi mostra i dati deve rileggerli.
 */
export function onAutomationsSettled(fn: () => void): () => void {
  settledListeners.add(fn);
  return () => settledListeners.delete(fn);
}

function notifySettled(): void {
  for (const fn of settledListeners) fn();
}

/** Un'esecuzione ha un input già in coda (es. un'approvazione appena data). */
export const hasQueued = (runId: string): boolean => (queued.get(runId) ?? 0) > 0;

function inTurn(runId: string, work: () => Promise<void>): Promise<void> {
  queued.set(runId, (queued.get(runId) ?? 0) + 1);
  const done = () => {
    const n = (queued.get(runId) ?? 1) - 1;
    if (n > 0) queued.set(runId, n);
    else queued.delete(runId);
  };
  const next = (turns.get(runId) ?? Promise.resolve()).then(work, work).finally(done);
  turns.set(runId, next);
  pending.add(next);
  void next.finally(() => {
    pending.delete(next);
    if (pending.size === 0) notifySettled();
  });
  return next;
}

/** Prepara lo stato ripreso prima dell'input (lo usa «Salta»). */
type Prepare = (st: EngineState) => void;

/** Mette in coda un input per un'esecuzione. */
export function enqueue(runId: string, input: EngineInput, prepare?: Prepare): Promise<void> {
  const gen = storeGeneration();
  return inTurn(runId, () => drive(runId, input, gen, prepare));
}

// --- il record --------------------------------------------------------------------

/** Una riga del registro scritta dal livello dati (pausa, ripresa, annulla, riprova, salta). */
export function note(
  run: AutomationRun,
  e: Pick<RunLogEntry, "outcome" | "reason"> & Partial<RunLogEntry>,
): void {
  const step = stepOfRun(run);
  run.log.push({
    at: runNow(run),
    stepId: step?.id ?? "trigger",
    path: run.cursor ?? "trigger",
    kind: step?.kind ?? "trigger",
    // La riga ripete cosa si aspettava: la ripresa di un'approvazione ne rilegge il progetto.
    input: copy(run.pending?.preview ?? {}),
    output: {},
    byId: null,
    effects: [],
    ...e,
  });
}

function pendingOf(st: EngineState, a: Automation, run: AutomationRun): AutomationRun["pending"] {
  const aw = st.awaiting;
  if (st.status === "waiting_approval" && aw?.kind === "approval") {
    const projectId = approvalProjectOf(aw.preview, a);
    return { approverIds: approversFor(a, aw.who, projectId), preview: copy(aw.preview) };
  }
  if (st.status === "waiting_project" && aw?.kind === "project") {
    const cliente = (run.event.cliente as { nome?: unknown } | undefined)?.nome;
    return {
      approverIds: a.ownerId ? [a.ownerId] : [],
      preview: {
        clientKey: aw.clientKey,
        ...(typeof cliente === "string" ? { clientName: cliente } : {}),
      },
    };
  }
  return null;
}

/** Scrive nel record l'esito di un passo del motore. */
function commit(run: AutomationRun, a: Automation, r: EngineStep): void {
  const at = runNow(run);
  for (const row of r.log) run.log.push({ at, ...copy(row) });
  const st = r.state;
  run.status = st.status;
  run.cursor = st.cursor;
  run.vars = copy(st.vars);
  run.waitingUntil = st.waitingUntil;
  run.error = st.error;
  run.loops = copy(st.loops);
  run.projects = copy(st.projects);
  run.pending = pendingOf(st, a, run);
  for (const projectId of Object.values(st.projects)) {
    if (!run.projectIds.includes(projectId)) run.projectIds.push(projectId);
  }
  if (TERMINAL.has(run.status)) {
    run.endedAt = at;
    run.pending = null;
  }
  failIfNoApprover(run);
}

/** Fallisce l'esecuzione con un codice, una riga nel registro e un avviso al proprietario. */
function failWith(run: AutomationRun, error: string, reason: string, why: ReasonCode): void {
  note(run, { outcome: "failed", reason, why });
  run.status = "failed";
  run.error = error;
  run.endedAt = runNow(run);
  run.pending = null;
  run.waitingUntil = null;
  const a = automationById(run.automationId);
  if (!a?.ownerId) return;
  const code = runCode(run);
  state.notifications.push({
    id: newId("n"),
    kind: "automation.failed",
    projectId: a.projectId,
    objectCode: code,
    departmentId: null,
    recipientIds: [a.ownerId],
    title: `${a.name} · ${code}`,
    body: reason,
    createdAt: runNow(run),
    read: false,
    archived: false,
    snoozedUntil: null,
    link: runHref(a.code, run.n),
  });
}

/**
 * R-J11: un'approvazione che nessuno può dare (nessuno indicato risolto, o
 * tutti hanno perso l'accesso al progetto) non aspetta per sempre: fallisce
 * con `no_approver`, e il proprietario lo sa. Si controlla a ogni passo e a
 * ogni lettura (il prototipo non ha un evento «membri cambiati»).
 */
export function failIfNoApprover(run: AutomationRun): boolean {
  if (run.status !== "waiting_approval" || decidersOf(run).length > 0) return false;
  failWith(run, "no_approver", NO_APPROVER_REASON, NO_APPROVER_WHY);
  return true;
}

/** La motivazione di `no_approver` (R-J11), anche nella prova. */
export const NO_APPROVER_WHY: ReasonCode = { code: "noApprover" };
export const NO_APPROVER_REASON =
  "Nessuno può approvare questo passo: chi è indicato non c'è, o non vede il progetto. Va cambiato chi approva, poi si può riprovare.";

/** R-J11 su tutte le esecuzioni ferme su un'approvazione. */
export function sweepApprovals(): void {
  let failed = false;
  for (const run of state.automationRuns) if (failIfNoApprover(run)) failed = true;
  // Dopo la lettura che l'ha scoperto: la rilettura non fallisce più nulla, quindi niente cicli.
  if (failed) queueMicrotask(notifySettled);
}

/** Sospende al confine del passo (pausa): riaccendendo torna a `from`. */
export function suspend(
  run: AutomationRun,
  from: NonNullable<AutomationRun["suspendedFrom"]>,
): void {
  run.suspendedFrom = from;
  run.status = "suspended";
  // Fermo per un blocco d'istanza (area 9b): esce dalla fila, riaccendendo
  // il passo si rilegge il blocco da capo.
  dropHeld(run.id);
  // Un'esecuzione non ancora partita non ha un passo da sospendere.
  if (run.log.length > 0) {
    note(run, {
      outcome: "suspended",
      reason: "Sospesa: l'automazione è in pausa. Riprende da qui quando si riaccende.",
    });
  }
}

/** Riprende una sospesa: torna allo stato di prima e riceve l'«adesso». */
export function resume(run: AutomationRun, byId: string): void {
  const from = run.suspendedFrom ?? "running";
  delete run.suspendedFrom;
  run.status = from;
  if (run.log.length === 0) {
    void enqueue(run.id, { kind: "start", event: run.event });
    return;
  }
  note(run, {
    outcome: "resumed",
    byId,
    reason: `Ripresa: ${personName(byId)} ha riacceso l'automazione.`,
  });
  void enqueue(run.id, { kind: "time", now: runNow(run) });
}

/** Il passo al cursore fallisce senza essere eseguito (il ritardo simulato è fallito). */
function failUnexecuted(run: AutomationRun): void {
  run.status = "failed";
  run.error = "unavailable";
  run.endedAt = runNow(run);
  run.pending = null;
  note(run, {
    outcome: "failed",
    reason: "Il servizio non ha risposto: il passo non è stato eseguito. Si può riprovare.",
    why: { code: "unavailable" },
  });
}

// --- i blocchi d'istanza (area 9b, Task 6) ------------------------------------------

/** Il progetto in cui gira un passo: quello dell'automazione, o il primo in cui ha agito. */
const aiProjectOf = (run: AutomationRun, a: Automation): string | null =>
  a.projectId ?? run.projectIds[0] ?? null;

/** La motivazione di un'attesa d'istanza, tradotta dall'interfaccia (`automations.reasons`). */
function waitingWhy(block: AiBlock): ReasonCode {
  return block.reason === "monthly_budget"
    ? { code: "aiBudget" }
    : { code: "aiQueuePaused", params: { name: block.byName, byId: block.byId } };
}

/**
 * Il blocco è cambiato ma il passo resta fermo: «Budget available again ·
 * still waiting: queue paused» o il contrario, nel registro (shape EF).
 */
function blockChangedWhy(after: AiBlock): ReasonCode {
  return after.reason === "queue_paused"
    ? { code: "aiBudgetBackStillQueue", params: { name: after.byName, byId: after.byId } }
    : { code: "aiQueueBackStillBudget" };
}

/**
 * Un passo che avvierebbe Claude, con un blocco d'istanza: l'esecuzione
 * resta `running` al confine del passo (decisione del maintainer del 30
 * ott 2026, ruling 15), con una riga `waiting` nel registro, e `holdJob` la
 * fa ripartire da quel passo quando il blocco cade, una volta sola. Già in
 * attesa (un «Fai passare il tempo», un altro input): resta ferma, senza
 * un'altra riga — il tempo non la sblocca. `false`: il passo può partire.
 */
function holdForAi(run: AutomationRun, a: Automation): boolean {
  if (heldJobs().some((h) => h.automationRunId === run.id)) return true;
  const projectId = aiProjectOf(run, a);
  const block = aiBlockFor(projectId);
  if (!block) return false;
  note(run, {
    outcome: "waiting",
    reason:
      block.reason === "monthly_budget"
        ? "In attesa: budget AI del mese raggiunto."
        : `In attesa: coda in pausa da ${block.byName}.`,
    why: waitingWhy(block),
  });
  const gen = storeGeneration();
  holdJob({
    // Un'automazione generale che non ha ancora agito in un progetto: il
    // budget la ferma comunque, senza progetto (lo Stato la mostra a chi
    // vede l'automazione, non fra i progetti nascosti).
    projectId,
    kind: "automation",
    taskId: null,
    conversationId: null,
    automationRunId: run.id,
    starterId: a.ownerId ?? CLAUDE_ID,
    block,
    // `releasedBy`: chi ha ripreso la coda; `null` se è tornato il budget.
    start: async (releasedBy) => {
      if (gen !== storeGeneration()) throw new Error("reset");
      if (!isOpen(run) || run.status !== "running") return;
      note(run, {
        outcome: "resumed",
        byId: releasedBy,
        reason:
          releasedBy === null
            ? "Budget di nuovo disponibile: il passo riparte."
            : "Coda ripresa: il passo riparte.",
        why: { code: releasedBy === null ? "aiBudgetBack" : "aiQueueBack" },
      });
      await enqueue(run.id, { kind: "time", now: runNow(run) });
    },
    onBlockChange: (_before, after) => {
      if (gen !== storeGeneration() || !isOpen(run)) return;
      note(run, {
        outcome: "waiting",
        reason:
          after.reason === "queue_paused"
            ? `Budget di nuovo disponibile: ancora in attesa, coda in pausa da ${after.byName}.`
            : "Coda ripresa: ancora in attesa del budget AI del mese.",
        why: blockChangedWhy(after),
      });
    },
  });
  return true;
}

/** Il blocco d'istanza per cui un'esecuzione aspetta adesso, se aspetta (le letture). */
export function aiWaitingOf(runId: string): AiBlock | null {
  return aiHoldOf(runId)?.block ?? null;
}

/**
 * Il blocco d'istanza per cui un'esecuzione aspetta adesso, col progetto
 * della coda in cui aspetta (`null`: un'automazione generale ferma per il
 * budget). È il progetto calcolato da `holdForAi`: le letture lo prendono
 * da qui invece di ricalcolarlo (revisione finale M3).
 */
export function aiHoldOf(runId: string): { block: AiBlock; projectId: string | null } | null {
  // Solo un'esecuzione in corso aspetta (I2): annullata o sospesa, non più.
  if (runById(runId)?.status !== "running") return null;
  const job = heldJobs().find((h) => h.automationRunId === runId);
  return job ? { block: job.block, projectId: job.projectId } : null;
}

// --- l'avanzamento ------------------------------------------------------------------

async function drive(runId: string, input: EngineInput, gen: number, prepare?: Prepare) {
  const alive = () => gen === storeGeneration();
  const run = runById(runId);
  if (!alive() || !run) return;
  try {
    await step(run, input, alive, prepare);
  } catch (error) {
    // Un errore inatteso non lascia l'esecuzione in corso per sempre.
    if (!alive() || !isOpen(run)) return;
    const message = error instanceof Error ? error.message : String(error);
    failWith(run, "internal_error", `Errore interno: l'esecuzione si è fermata (${message}).`, {
      code: "internalError",
      params: { message },
    });
  }
}

async function step(
  run: AutomationRun,
  input: EngineInput,
  alive: () => boolean,
  prepare?: Prepare,
): Promise<void> {
  const a = automationById(run.automationId);
  const flow = flowOf(run);
  if (!a || !flow) return;
  if (TERMINAL.has(run.status) || run.status === "suspended") return;

  // Il passo su cui si è appena deciso (approvato, progetto scelto): il suo
  // effetto si esegue anche se nel frattempo è arrivata la pausa — la
  // decisione presa non si perde; si sospende al passo dopo.
  const decided = input.kind === "approved" || input.kind === "project_chosen" ? run.cursor : null;
  const st =
    run.log.length === 0 ? initialState(flow, runNow(run)) : restoreState(flow, run, runNow(run));
  prepare?.(st);
  let r = advance(st, input);
  commit(run, a, r);
  for (;;) {
    const eff = r.effects[0];
    if (!eff) break;
    const finishing = decided !== null && eff.path === decided;
    if (a.status !== "active" && !finishing) return suspend(run, "running");
    try {
      await gate("automations.advanceRun");
    } catch {
      if (!alive() || run.status === "cancelled") return;
      return failUnexecuted(run);
    }
    if (!alive() || run.status === "cancelled") return;
    // In pausa durante il ritardo: l'effetto non è partito, resta da fare.
    if (a.status !== "active" && !finishing) return suspend(run, "running");
    // Area 9b: un passo di Claude col budget esaurito o la coda in pausa
    // aspetta al confine del passo, senza fallire.
    if (eff.kind === "claude" && holdForAi(run, a)) return;
    const out = executeEffect(eff, {
      run,
      automation: a,
      now: runNow(run),
      // L'avvio annidato: un'esecuzione nuova con le regole dell'automazione avviata.
      spawn: (target, event) =>
        startRun(target, event, { parentRunId: run.id, origin: "automation" }),
    });
    if (out.projectId && !run.projectIds.includes(out.projectId))
      run.projectIds.push(out.projectId);
    r = advance(r.state, out.input);
    commit(run, a, r);
  }
  // Fermata su un'attesa mentre l'automazione andava in pausa: si sospende qui.
  if (a.status === "paused" && isOpen(run)) {
    suspend(run, run.status as NonNullable<AutomationRun["suspendedFrom"]>);
  }
}

// --- l'avvio ----------------------------------------------------------------------

/** L'ultima versione pubblicata (quella con cui partono le esecuzioni nuove). */
export const publishedVersion = (a: Automation) =>
  [...a.versions].reverse().find((v) => v.publishedAt !== null) ?? null;

/** Può nascere un'esecuzione? Attiva, con una versione pubblicata, sotto le 100 non finite. */
export function canStartRun(a: Automation): boolean {
  if (a.status !== "active" || !publishedVersion(a)) return false;
  const open = state.automationRuns.filter((r) => r.automationId === a.id && isOpen(r));
  return open.length < MAX_ACTIVE_RUNS;
}

/**
 * Fa nascere un'esecuzione di un'automazione attiva, con la versione
 * pubblicata, e la mette in coda. `null` se non può partire (non attiva,
 * nessuna versione, troppe esecuzioni in corso).
 */
export function startRun(
  a: Automation,
  event: Record<string, unknown>,
  opts: { parentRunId?: string | null; origin: NonNullable<AutomationRun["origin"]> },
): AutomationRun | null {
  const parentRunId = opts.parentRunId ?? null;
  const version = publishedVersion(a);
  if (!canStartRun(a) || !version) return null;
  const runs = state.automationRuns.filter((r) => r.automationId === a.id);
  const parent = parentRunId ? runById(parentRunId) : undefined;
  const at = parent ? runNow(parent) : now();
  const titled = initialState(version.flow, at);
  titled.event = event;
  const run: AutomationRun = {
    id: newId("arun"),
    automationId: a.id,
    n: runs.reduce((m, r) => Math.max(m, r.n), 0) + 1,
    version: version.n,
    title: render(titled, version.flow.titleTemplate).trim() || a.name,
    status: "running",
    event: copy(event),
    vars: {},
    cursor: null,
    waitingUntil: null,
    pending: null,
    log: [],
    startedAt: at,
    endedAt: null,
    error: null,
    projectIds: a.projectId ? [a.projectId] : [],
    parentRunId,
    origin: opts.origin,
  };
  state.automationRuns.push(run);
  if (parent) state.automationClock.set(run.id, at);
  void enqueue(run.id, { kind: "start", event: run.event });
  return run;
}
