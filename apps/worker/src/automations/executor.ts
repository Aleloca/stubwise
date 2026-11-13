import { randomUUID } from "node:crypto";
import {
  automationRunInputs,
  automationRunLog,
  automationRuns,
  automations,
  automationVersions,
  type Db,
} from "@stubwise/db";
import { approversFor as resolveApprovers, publishNotification } from "@stubwise/notifications";
import {
  advance,
  approvalProjectOf,
  checkEdited,
  initialState,
  NO_APPROVER_REASON,
  NO_APPROVER_WHY,
  restoreState,
  stepAt,
  type ApprovalWho,
  type Automation,
  type AutomationFlow,
  type EngineInput,
  type EngineState,
  type EngineStep,
  type ReasonCode,
  type RunLogEntry,
  type RunStatus,
} from "@stubwise/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { executeEffect } from "./effects.js";

/**
 * L'ESECUTORE delle esecuzioni (area 7, fetta 1; la specifica è
 * `data/automations/runner.ts` del prototipo). Prende le esecuzioni dovute
 * (in corso, o con un input in coda), le fa avanzare col motore PURO di
 * `@stubwise/shared` (`advance`), esegue gli effetti richiesti
 * (`effects.ts`) e rimette l'esito nel motore, finché l'esecuzione si ferma
 * (un'attesa, la fine, un errore).
 *
 * - Lo stato vero è la riga `automation_runs` più il suo registro: a ogni
 *   giro il motore lo riprende da lì (`restoreState`), come nel prototipo.
 *   `cursor` (jsonb) tiene il percorso del passo, gli elementi dei cicli, i
 *   progetti risolti e da dove riprendere una sospesa.
 * - Un LEASE per esecuzione (`claimed_at`, {@link RUN_LEASE_MS}, `SKIP
 *   LOCKED`), come `nightly_items`: più worker insieme non toccano la stessa
 *   esecuzione, e un worker morto la libera alla scadenza. Un riavvio non
 *   perde niente: un effetto a metà si ritrova per chiave d'idempotenza.
 * - Gli input (approvazioni, progetto scelto) arrivano dal server nella coda
 *   `automation_run_inputs` e passano UNO alla volta, in ordine.
 * - PAUSA: un'esecuzione non si sospende MAI con un effetto in volo; si
 *   sospende al confine del passo, prima dell'effetto seguente (che resta da
 *   fare). Il passo appena deciso (approvato, progetto scelto) si esegue
 *   anche se nel frattempo è arrivata la pausa.
 * - R-J11: un'approvazione che nessuno può dare fallisce con `no_approver`, e
 *   il proprietario lo sa.
 * - Gli avvisi: a chi approva quando l'esecuzione si ferma su di lui
 *   (`automation.approval`), al proprietario quando fallisce
 *   (`automation.failed`). Contenuto e link si DERIVANO a lettura.
 * - D5: un fallimento `permission_lost` mette in pausa l'automazione
 *   (`owner_lost_permission`, `automation.paused` al proprietario).
 */

/**
 * La lease di una presa (review F1, M2): breve, perché nella F1 nessun passo
 * dura (niente Claude), e un worker morto non lascia le esecuzioni ferme per
 * un'ora. Si rinnova a ogni input trattato (`renewClaim`).
 */
export const RUN_LEASE_MS = 5 * 60_000;
export const RUN_BATCH = 10;

const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "failed", "cancelled"]);

type RunRow = typeof automationRuns.$inferSelect;
type AutomationRow = typeof automations.$inferSelect;

/** Ciò che `cursor` (jsonb) conserva oltre al percorso. */
interface SavedCursor {
  path: string | null;
  loops?: Record<string, unknown[]>;
  projects?: Record<string, string>;
  waitingUntil?: string | null;
  suspendedFrom?: RunStatus | null;
}

export interface ExecutorDeps {
  db: Db;
  now?: () => Date;
  workerId?: string;
  log?: (msg: string) => void;
}

/** Un giro: le esecuzioni dovute, una alla volta. Ritorna quante ne ha mosse. */
export async function executeDueRuns(deps: ExecutorDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  // Un gettone per presa: due worker (o due giri) non si scambiano mai il rilascio.
  const token = `${deps.workerId ?? "worker"}:${randomUUID()}`;
  const ids = await claimRuns(deps, now, token);
  for (const id of ids) {
    try {
      await processRun(deps, id, token);
    } catch (err) {
      deps.log?.(`[automations] esecuzione ${id}: ${String(err)}`);
    } finally {
      await releaseClaim(deps.db, id, token);
    }
  }
  return ids.length;
}

/** Rilascia la presa, solo se è ancora quella di `token` (un altro worker può averla ripresa a lease scaduta). */
export async function releaseClaim(db: Db, runId: string, token: string): Promise<void> {
  await db.update(automationRuns).set({ claimedAt: null, claimedBy: null }).where(and(eq(automationRuns.id, runId), eq(automationRuns.claimedBy, token)));
}

/** Rinnova la lease della propria presa (fra un input e l'altro). */
async function renewClaim(db: Db, runId: string, token: string): Promise<void> {
  await db.update(automationRuns).set({ claimedAt: sql`now()` }).where(and(eq(automationRuns.id, runId), eq(automationRuns.claimedBy, token)));
}

async function claimRuns(deps: ExecutorDeps, now: Date, token: string): Promise<string[]> {
  const leaseStart = new Date(now.getTime() - RUN_LEASE_MS).toISOString();
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(
        sql`(${automationRuns.claimedAt} is null or ${automationRuns.claimedAt} < ${leaseStart}::timestamptz)
          and (
            (${automationRuns.status} = 'running' and ${automationRuns.dueAt} <= ${now.toISOString()}::timestamptz)
            or exists (select 1 from ${automationRunInputs} i where i.run_id = ${automationRuns.id} and i.consumed_at is null)
          )`,
      )
      .orderBy(asc(automationRuns.dueAt))
      .limit(RUN_BATCH)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    await tx
      .update(automationRuns)
      .set({ claimedAt: now, claimedBy: token })
      .where(inArray(automationRuns.id, rows.map((r) => r.id)));
    return rows.map((r) => r.id);
  });
}

/** Il contesto di un giro su un'esecuzione. */
interface Turn {
  deps: ExecutorDeps;
  run: RunRow;
  automation: AutomationRow;
  flow: AutomationFlow;
  log: RunLogEntry[];
  now: string;
}

async function processRun(deps: ExecutorDeps, runId: string, token: string): Promise<void> {
  const db = deps.db;
  const [run] = await db.select().from(automationRuns).where(eq(automationRuns.id, runId));
  if (!run) return;
  const [automation] = await db.select().from(automations).where(eq(automations.id, run.automationId));
  const [version] = await db
    .select({ flow: automationVersions.flow })
    .from(automationVersions)
    .where(and(eq(automationVersions.automationId, run.automationId), eq(automationVersions.n, run.version)));
  if (!automation || !version) return;
  const turn: Turn = {
    deps,
    run,
    automation,
    flow: version.flow as AutomationFlow,
    log: await loadLog(db, run.id),
    now: (deps.now?.() ?? new Date()).toISOString(),
  };

  const inputs = await db
    .select()
    .from(automationRunInputs)
    .where(and(eq(automationRunInputs.runId, run.id), isNull(automationRunInputs.consumedAt)))
    .orderBy(asc(automationRunInputs.createdAt));
  const queue: { input: EngineInput | ControlInput; rowId: string | null }[] = [];
  if (turn.log.length === 0 && run.status === "running") queue.push({ input: { kind: "start", event: (run.event ?? {}) as Record<string, unknown> }, rowId: null });
  for (const row of inputs) queue.push({ input: row.input as EngineInput | ControlInput, rowId: row.id });
  if (queue.length === 0 && run.status === "running") queue.push({ input: { kind: "time", now: turn.now }, rowId: null });

  for (const item of queue) {
    await renewClaim(db, run.id, token);
    try {
      if (!acceptableEdit(turn, item.input)) deps.log?.(`[automations] esecuzione ${run.id}: correzioni non ammesse (edited) scartate`);
      else if ("control" in item.input) await control(turn, item.input);
      else await drive(turn, item.input);
    } catch (err) {
      if (!TERMINAL.has(turn.run.status)) {
        const message = err instanceof Error ? err.message : String(err);
        await failWith(turn, "internal_error", `Errore interno: l'esecuzione si è fermata (${message}).`, { code: "internalError", params: { message } });
      }
    }
    if (item.rowId) await db.update(automationRunInputs).set({ consumedAt: sql`now()` }).where(eq(automationRunInputs.id, item.rowId));
  }
}

/**
 * Difesa in profondità: le correzioni di un'approvazione si ricontrollano qui
 * con la STESSA `checkEdited` del server prima di arrivare al motore. Un input
 * che non passa si scarta (consumato, l'esecuzione resta in attesa).
 */
function acceptableEdit(turn: Turn, input: EngineInput | ControlInput): boolean {
  if ("control" in input || input.kind !== "approved" || input.edited === undefined) return true;
  try {
    if (!input.edited || typeof input.edited !== "object" || Array.isArray(input.edited)) return false;
    checkEdited(stepAt(turn.flow.steps, input.path)?.kind, input.edited);
    return true;
  } catch {
    return false;
  }
}

async function loadLog(db: Db, runId: string): Promise<RunLogEntry[]> {
  const rows = await db.select().from(automationRunLog).where(eq(automationRunLog.runId, runId)).orderBy(asc(automationRunLog.seq));
  return rows.map((r) => ({
    at: r.at.toISOString(),
    stepId: r.stepId,
    path: r.path,
    kind: r.kind as RunLogEntry["kind"],
    outcome: r.outcome as RunLogEntry["outcome"],
    input: (r.input ?? {}) as Record<string, unknown>,
    output: (r.output ?? {}) as Record<string, unknown>,
    reason: r.reason,
    why: (r.why ?? null) as ReasonCode | null,
    byId: r.byId,
    effects: (r.effects ?? []) as RunLogEntry["effects"],
  }));
}

const cursorOf = (run: RunRow): SavedCursor => (run.cursor ?? { path: null }) as SavedCursor;

/** Lo stato del motore, ripreso dal record (come nel prototipo). */
function stateOf(turn: Turn): EngineState {
  if (turn.log.length === 0) return initialState(turn.flow, turn.now);
  const c = cursorOf(turn.run);
  return restoreState(
    turn.flow,
    {
      event: (turn.run.event ?? {}) as Record<string, unknown>,
      vars: (turn.run.vars ?? {}) as Record<string, unknown>,
      cursor: c.path,
      status: turn.run.status,
      waitingUntil: c.waitingUntil ?? null,
      log: turn.log,
      loops: c.loops ?? {},
      projects: c.projects ?? {},
    },
    turn.now,
  );
}

/**
 * Gli input di CONTROLLO che il server mette in coda (le scritture del livello
 * dati del prototipo, `runWrites.ts`): annulla, riprova, salta, sospendi per la
 * pausa, riprendi per la riaccensione. Li applica l'esecutore, sotto il lease,
 * così nessuno tocca un'esecuzione mentre avanza.
 */
export interface ControlInput {
  control: "cancel" | "retry" | "skip" | "suspend" | "resume";
  byId: string | null;
}

const OPEN_WAITING: ReadonlySet<RunStatus> = new Set(["waiting_approval", "waiting_project", "waiting_event"]);

async function setRun(turn: Turn, values: Partial<typeof automationRuns.$inferInsert>): Promise<void> {
  const [updated] = await turn.deps.db.update(automationRuns).set(values).where(eq(automationRuns.id, turn.run.id)).returning();
  turn.run = updated!;
}

async function control(turn: Turn, input: ControlInput): Promise<void> {
  const status = turn.run.status;
  switch (input.control) {
    case "cancel": {
      if (TERMINAL.has(status)) return;
      await note(turn, { outcome: "cancelled", byId: input.byId, reason: "Esecuzione annullata.", why: { code: "cancelledBy" } });
      await setRun(turn, { status: "cancelled", error: "cancelled", pending: null, endedAt: new Date() });
      return;
    }
    case "retry":
    case "skip": {
      if (status !== "failed" || cursorOf(turn.run).path === null) return;
      const skip = input.control === "skip";
      await note(turn, { outcome: skip ? "skipped" : "retried", byId: input.byId, reason: skip ? "Passo saltato." : "Riprova chiesta." });
      await setRun(turn, { status: "running", error: null, endedAt: null });
      await drive(turn, { kind: "time", now: turn.now }, skip ? skipTop : undefined);
      return;
    }
    case "suspend": {
      // Ferma su un'attesa: si sospende adesso; in corsa lo fa da sé al confine del passo.
      if (OPEN_WAITING.has(status)) await suspend(turn);
      return;
    }
    case "resume": {
      if (status !== "suspended") return;
      const from = cursorOf(turn.run).suspendedFrom ?? "running";
      await setRun(turn, { status: from as RunRow["status"], cursor: { ...cursorOf(turn.run), suspendedFrom: null } });
      if (turn.log.length === 0) return drive(turn, { kind: "start", event: (turn.run.event ?? {}) as Record<string, unknown> });
      await note(turn, { outcome: "resumed", byId: input.byId, reason: "Ripresa: l'automazione è stata riaccesa." });
      if (from === "running") await drive(turn, { kind: "time", now: turn.now });
      return;
    }
  }
}

/** «Salta»: il passo al cursore è saltato, si riparte da quello dopo. */
function skipTop(st: EngineState): void {
  const top = st.stack.at(-1);
  if (top?.t === "list") top.i += 1;
}

async function drive(turn: Turn, input: EngineInput, prepare?: (st: EngineState) => void): Promise<void> {
  if (TERMINAL.has(turn.run.status) || turn.run.status === "suspended") return;
  const decided = input.kind === "approved" || input.kind === "project_chosen" ? cursorOf(turn.run).path : null;
  const st = stateOf(turn);
  prepare?.(st);
  let r = advance(st, input);
  await commit(turn, r);
  for (;;) {
    const eff = r.effects[0];
    if (!eff) break;
    const finishing = decided !== null && eff.path === decided;
    const [fresh] = await turn.deps.db.select({ status: automations.status }).from(automations).where(eq(automations.id, turn.automation.id));
    if (fresh?.status !== "active" && !finishing) return suspend(turn);
    const out = await executeEffect(eff, {
      db: turn.deps.db,
      runId: turn.run.id,
      runNumber: turn.run.n,
      automation: { id: turn.automation.id, code: turn.automation.code, name: turn.automation.name, projectId: turn.automation.projectId, ownerId: turn.automation.ownerId },
      now: turn.now,
    });
    if (out.projectId && !turn.run.projectIds.includes(out.projectId)) turn.run.projectIds = [...turn.run.projectIds, out.projectId];
    r = advance(r.state, out.input);
    await commit(turn, r);
  }
  const [after] = await turn.deps.db.select({ status: automations.status }).from(automations).where(eq(automations.id, turn.automation.id));
  if (after?.status === "paused" && !TERMINAL.has(turn.run.status)) await suspend(turn);
}

/** Scrive nel record l'esito di un passo del motore, e gli avvisi che ne nascono. */
async function commit(turn: Turn, r: EngineStep): Promise<void> {
  const db = turn.deps.db;
  const st = r.state;
  const before = turn.run.status;
  for (const row of r.log) await appendLog(turn, { at: turn.now, ...row });
  const pending = await pendingOf(turn, st);
  const terminal = TERMINAL.has(st.status);
  const projectIds = [...new Set([...turn.run.projectIds, ...Object.values(st.projects)])];
  const cursor: SavedCursor = { path: st.cursor, loops: st.loops, projects: st.projects, waitingUntil: st.waitingUntil };
  const [updated] = await db
    .update(automationRuns)
    .set({
      // `waiting_event` nasce con le attese della F2: nella fetta 1 nessun passo lo produce.
      status: st.status as RunRow["status"],
      cursor,
      vars: st.vars,
      error: st.error,
      pending: terminal ? null : pending,
      projectIds,
      ...(terminal ? { endedAt: sql`now()` } : {}),
    })
    .where(eq(automationRuns.id, turn.run.id))
    .returning();
  turn.run = updated!;
  if (st.status === "waiting_approval" && pending) {
    // R-J11: nessuno può approvare → fallisce, e il proprietario lo sa.
    if (pending.approverIds.length === 0) return failWith(turn, "no_approver", NO_APPROVER_REASON, NO_APPROVER_WHY);
    if (before !== "waiting_approval" || turn.log.at(-1)?.outcome !== "waiting") await notifyApprovers(turn, pending.approverIds);
  }
  if (st.status === "failed" && before !== "failed") {
    await notifyOwner(turn, "automation.failed");
    // D5: il proprietario non può più farlo → l'automazione va in pausa da
    // sola, e lui lo sa. Le altre esecuzioni si sospendono al loro confine.
    if (st.error === "permission_lost") await pauseForLostPermission(turn);
  }
}

async function pauseForLostPermission(turn: Turn): Promise<void> {
  const paused = await turn.deps.db
    .update(automations)
    .set({ status: "paused", pausedReason: "owner_lost_permission", pausedBy: null, pausedAt: sql`now()`, activeSince: null })
    .where(and(eq(automations.id, turn.automation.id), eq(automations.status, "active")))
    .returning({ id: automations.id });
  if (paused.length > 0) await notifyOwner(turn, "automation.paused");
}

async function appendLog(turn: Turn, e: RunLogEntry): Promise<void> {
  const seq = turn.log.length + 1;
  await turn.deps.db.insert(automationRunLog).values({
    runId: turn.run.id,
    seq,
    stepId: e.stepId,
    path: e.path,
    kind: e.kind,
    outcome: e.outcome,
    input: e.input,
    output: e.output,
    reason: e.reason,
    why: e.why ?? null,
    byId: e.byId,
    effects: e.effects,
  });
  turn.log.push(e);
}

/** Chi decide adesso e cosa: per un'approvazione gli approvatori risolti ORA (R-J8). */
async function pendingOf(turn: Turn, st: EngineState): Promise<{ approverIds: string[]; preview: Record<string, unknown>; path: string; round: number } | null> {
  const aw = st.awaiting;
  if (st.status === "waiting_approval" && aw?.kind === "approval") {
    const projectId = approvalProjectOf(aw.preview, turn.automation as unknown as Automation);
    return { approverIds: await approversFor(turn, aw.who, projectId), preview: structuredClone(aw.preview), path: aw.path, round: 0 };
  }
  if (st.status === "waiting_project" && aw?.kind === "project") {
    return { approverIds: turn.automation.ownerId ? [turn.automation.ownerId] : [], preview: { clientKey: aw.clientKey }, path: aw.path, round: 0 };
  }
  return null;
}

/** Chi approva adesso (R-J8): la regola è una, in `@stubwise/notifications`. */
const approversFor = (turn: Pick<Turn, "deps" | "automation">, who: ApprovalWho, projectId: string | null) =>
  resolveApprovers(turn.deps.db, turn.automation, who, projectId);

/** Sospende al confine del passo (pausa): riaccendendo torna allo stato di prima. */
async function suspend(turn: Turn): Promise<void> {
  const from = turn.run.status;
  if (turn.log.length > 0) {
    await note(turn, { outcome: "suspended", reason: "Sospesa: l'automazione è in pausa. Riprende da qui quando si riaccende.", why: { code: "suspended" } });
  }
  const [updated] = await turn.deps.db
    .update(automationRuns)
    .set({ status: "suspended", cursor: { ...cursorOf(turn.run), suspendedFrom: from } })
    .where(eq(automationRuns.id, turn.run.id))
    .returning();
  turn.run = updated!;
}

/** Una riga del registro scritta dall'esecutore (pausa, fallimento) sul passo al cursore. */
async function note(turn: Turn, e: Pick<RunLogEntry, "outcome" | "reason"> & Partial<RunLogEntry>): Promise<void> {
  const path = cursorOf(turn.run).path;
  const step = path ? stepAt(turn.flow.steps, path) : null;
  await appendLog(turn, {
    at: turn.now,
    stepId: step?.id ?? "trigger",
    path: path ?? "trigger",
    kind: step?.kind ?? "trigger",
    input: structuredClone((turn.run.pending as { preview?: Record<string, unknown> } | null)?.preview ?? {}),
    output: {},
    byId: null,
    effects: [],
    ...e,
  });
}

/** Fallisce l'esecuzione con un codice, una riga nel registro e un avviso al proprietario. */
async function failWith(turn: Turn, error: string, reason: string, why: ReasonCode): Promise<void> {
  await note(turn, { outcome: "failed", reason, why });
  const [updated] = await turn.deps.db
    .update(automationRuns)
    .set({ status: "failed", error, pending: null, endedAt: sql`now()` })
    .where(eq(automationRuns.id, turn.run.id))
    .returning();
  turn.run = updated!;
  await notifyOwner(turn, "automation.failed");
}

const eventOf = (turn: Turn, kind: "automation.approval" | "automation.failed" | "automation.paused") => ({
  kind,
  projectId: turn.automation.projectId,
  automationId: turn.automation.id,
  automationCode: turn.automation.code,
  automationName: turn.automation.name,
  runId: turn.run.id,
  runNumber: turn.run.n,
});

async function notifyOwner(turn: Turn, kind: "automation.failed" | "automation.paused"): Promise<void> {
  const owner = turn.automation.ownerId;
  if (!owner) return;
  await publishNotification(turn.deps.db, eventOf(turn, kind), { projectId: turn.automation.projectId, accountUserId: owner });
}

async function notifyApprovers(turn: Turn, approverIds: readonly string[]): Promise<void> {
  const path = cursorOf(turn.run).path;
  for (const personId of approverIds) {
    await publishNotification(turn.deps.db, { ...eventOf(turn, "automation.approval"), ...(path ? { path } : {}) }, { projectId: turn.automation.projectId, accountUserId: personId });
  }
}
