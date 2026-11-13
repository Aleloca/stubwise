import { automationRunInputs, automationRunLog, automationRuns, automations, automationVersions, projects, type Db } from "@stubwise/db";
import { approversFor, loadPlanWorld } from "@stubwise/notifications";
import {
  approvalProjectOf,
  checkEdited,
  describe,
  planMilestone,
  planTask,
  projectOf,
  restoreState,
  type ActionEffect,
  type ActionStep,
  type ResolvedTarget,
  type SimulationEffectPreview,
  type SimulationProject,
  hideProject,
  stepAt,
  type Automation,
  type AutomationFlow,
  type AutomationRun,
  type AutomationRunDetail,
  type AutomationRunRow,
  type ReasonCode,
  type RunLogEntry,
  type RunStatus,
} from "@stubwise/shared";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { AutomationError, canManage, flowFor, forbidden, notFound, seen, sees, visibleAutomation, type AutomationRecord, type Viewer } from "./model.js";

/**
 * LE ESECUZIONI nel server (area 7, fetta 1; la specifica è
 * `data/automations/{runWrites,reads,visibility}.ts` del prototipo).
 *
 * - Un'esecuzione la vede chi vede la sua automazione, e chi deve decidere
 *   su di lei ADESSO (R-J8): gli approvatori si risolvono ogni volta, non si
 *   leggono da `pending` (un ex approvatore non decide più).
 * - Le DECISIONI (approva, rifiuta, scegli il progetto) e i comandi (annulla,
 *   riprova, salta) NON muovono il motore: diventano una riga di
 *   `automation_run_inputs`, che l'esecutore del worker applica. Qui si
 *   controlla solo che la decisione valga per il passo che aspetta
 *   (`expectedPath`/`expectedRound`, 409 `stale`), che l'esecuzione non sia
 *   sospesa (409 `suspended`) e chi decide (403).
 * - R-J12: nel registro, un progetto che chi guarda non vede resta senza id,
 *   e ciò che vi è stato creato non ha codice.
 */

type RunRecord = typeof automationRuns.$inferSelect;
const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);
const OPEN_STATUSES = ["running", "waiting_approval", "waiting_project", "suspended"] as const;

interface SavedCursor {
  path: string | null;
  loops?: Record<string, unknown[]>;
  projects?: Record<string, string>;
  waitingUntil?: string | null;
  suspendedFrom?: RunStatus | null;
}
const cursorOf = (r: RunRecord): SavedCursor => (r.cursor ?? { path: null }) as SavedCursor;
type Pending = { approverIds: string[]; preview: Record<string, unknown>; path: string; round: number } | null;
const pendingOf = (r: RunRecord) => r.pending as Pending;

export const runCode = (a: Pick<AutomationRecord, "code">, n: number) => `${a.code} #${n}`;

async function flowOfRun(db: Db, r: RunRecord): Promise<AutomationFlow | null> {
  const [v] = await db.select({ flow: automationVersions.flow }).from(automationVersions).where(and(eq(automationVersions.automationId, r.automationId), eq(automationVersions.n, r.version)));
  return (v?.flow as AutomationFlow | undefined) ?? null;
}

/** Chi decide ADESSO: gli approvatori del passo risolti ora, o il proprietario per il progetto. */
export async function decidersOf(db: Db, r: RunRecord, a: AutomationRecord): Promise<string[]> {
  if (r.status === "waiting_project") return a.ownerId ? [a.ownerId] : [];
  if (r.status !== "waiting_approval") return [];
  const flow = await flowOfRun(db, r);
  const path = cursorOf(r).path;
  const step = flow && path ? stepAt(flow.steps, path) : null;
  if (!step || !("approval" in step) || step.approval.mode !== "ask") return [];
  return approversFor(db, a, step.approval.who, approvalProjectOf(pendingOf(r)?.preview ?? {}, a as unknown as Automation));
}

/** Il registro come lo legge chi guarda (R-J12). */
async function logFor(db: Db, runId: string, visible: "all" | ReadonlySet<string>): Promise<RunLogEntry[]> {
  const rows = await db.select().from(automationRunLog).where(eq(automationRunLog.runId, runId)).orderBy(asc(automationRunLog.seq));
  const all = visible === "all";
  return rows.map((r) => {
    const input = structuredClone((r.input ?? {}) as Record<string, unknown>);
    const output = structuredClone((r.output ?? {}) as Record<string, unknown>);
    if (!all) {
      hideProject(input, visible);
      hideProject(output, visible);
    }
    const hidden = !all && typeof (r.input as { progetto?: unknown } | null)?.progetto === "string" && input.progetto === "";
    return {
      at: r.at.toISOString(),
      stepId: r.stepId,
      path: r.path,
      kind: r.kind as RunLogEntry["kind"],
      outcome: r.outcome as RunLogEntry["outcome"],
      input,
      output,
      reason: r.reason,
      why: (r.why ?? null) as ReasonCode | null,
      byId: r.byId,
      effects: ((r.effects ?? []) as RunLogEntry["effects"]).map((e) => (hidden ? { ...e, code: "" } : e)),
    };
  });
}

/** Un'esecuzione nella forma condivisa, come la legge chi guarda. */
/**
 * `withLog: false` per gli elenchi letti spesso (review del renderer, I3): il
 * registro di ogni riga pesa, e lo legge il dettaglio. `log` resta (vuoto) per
 * non togliere un campo a un client che lo legge.
 */
export async function runRowOf(db: Db, viewer: Viewer, r: RunRecord, a: AutomationRecord, visible?: "all" | ReadonlySet<string>, opts: { withLog?: boolean } = {}): Promise<AutomationRunRow> {
  const v = visible ?? (await seen(db, viewer));
  const c = cursorOf(r);
  const pending = pendingOf(r);
  const run: AutomationRun = {
    id: r.id,
    automationId: r.automationId,
    n: r.n,
    version: r.version,
    title: r.title,
    status: r.status,
    event: (r.event ?? {}) as Record<string, unknown>,
    vars: (r.vars ?? {}) as Record<string, unknown>,
    cursor: c.path,
    waitingUntil: c.waitingUntil ?? null,
    pending: pending ? { approverIds: pending.approverIds, preview: pending.preview } : null,
    log: opts.withLog === false ? [] : await logFor(db, r.id, v),
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    error: r.error,
    projectIds: r.projectIds.filter((p) => sees(v, p)),
    parentRunId: r.parentRunId,
    origin: r.origin,
    ...(r.status === "suspended" && c.suspendedFrom ? { suspendedFrom: c.suspendedFrom as AutomationRun["suspendedFrom"] } : {}),
  };
  if (pending && typeof pending.preview.progetto === "string" && v !== "all") hideProject(run.pending!.preview, v);
  return { ...run, code: runCode(a, r.n), automationCode: a.code, automationName: a.name, automationProjectId: a.projectId, round: pending?.round ?? 0 };
}

/** Un'esecuzione che chi guarda vede (l'automazione, o è fra chi decide adesso); 404 altrimenti. */
export async function visibleRun(db: Db, viewer: Viewer, code: string, n: number): Promise<{ run: RunRecord; automation: AutomationRecord; deciders: string[] }> {
  const [a] = await db.select().from(automations).where(eq(automations.code, code.toUpperCase()));
  if (!a) throw notFound();
  const [r] = await db.select().from(automationRuns).where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.n, n)));
  if (!r) throw notFound();
  const deciders = await decidersOf(db, r, a);
  if (!sees(await seen(db, viewer), a.projectId) && !deciders.includes(viewer.id)) throw notFound();
  return { run: r, automation: a, deciders };
}

export async function getRun(db: Db, viewer: Viewer, code: string, n: number): Promise<AutomationRunDetail> {
  const { run, automation, deciders } = await visibleRun(db, viewer, code, n);
  const visible = await seen(db, viewer);
  const row = await runRowOf(db, viewer, run, automation, visible);
  const flow = (await flowOfRun(db, run)) ?? { trigger: { kind: "manual" as const }, steps: [], titleTemplate: "" };
  const seesAutomation = sees(visible, automation.projectId);
  const manage = seesAutomation && (await canManage(db, viewer, automation.projectId));
  const [parent] = run.parentRunId && seesAutomation ? await db.select().from(automationRuns).where(eq(automationRuns.id, run.parentRunId)) : [];
  const parentAutomation = parent ? (await db.select().from(automations).where(eq(automations.id, parent.automationId)))[0] : undefined;
  const children = await db
    .select({ id: automationRuns.id, n: automationRuns.n, status: automationRuns.status, code: automations.code, projectId: automations.projectId })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(eq(automationRuns.parentRunId, run.id));
  return {
    ...row,
    flow: flowFor(visible, flow),
    deciders,
    ownerId: automation.ownerId,
    permissions: {
      manage,
      approve: run.status === "waiting_approval" && deciders.includes(viewer.id),
      chooseProject: run.status === "waiting_project" && deciders.includes(viewer.id),
    },
    parent: parent && parentAutomation && sees(visible, parentAutomation.projectId) ? { id: parent.id, code: runCode(parentAutomation, parent.n) } : null,
    children: children.filter((c) => sees(visible, c.projectId)).map((c) => ({ id: c.id, code: `${c.code} #${c.n}`, status: c.status })),
    pendingEffect: await pendingEffectOf(db, visible, run, automation, row, flow),
    // Un input di chi guarda in coda, non ancora applicato dal worker (review del renderer, I2).
    inputQueued:
      (
        await db
          .select({ id: automationRunInputs.id })
          .from(automationRunInputs)
          .where(and(eq(automationRunInputs.runId, run.id), eq(automationRunInputs.byId, viewer.id), sql`${automationRunInputs.consumedAt} is null`))
          .limit(1)
      ).length > 0,
  };
}

/** Le esecuzioni che chi guarda vede: filtri nella WHERE, prima del limite; paginazione per cursore. */
export async function listRuns(
  db: Db,
  viewer: Viewer,
  q: { automation?: string; project?: string; status?: RunStatus; cursor?: string; limit?: number; log?: "none" },
): Promise<{ items: AutomationRunRow[]; nextCursor: string | null }> {
  const visible = await seen(db, viewer);
  if (visible !== "all" && visible.size === 0) return { items: [], nextCursor: null };
  const limit = Math.min(q.limit ?? 50, 200);
  const [cAt, cId] = q.cursor ? q.cursor.split("|") : [];
  const rows = await db
    .select({ run: automationRuns, automation: automations })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        visible === "all" ? undefined : inArray(automations.projectId, [...visible]),
        q.automation ? eq(automations.code, q.automation.toUpperCase()) : undefined,
        q.project ? eq(automations.projectId, q.project) : undefined,
        q.status ? eq(automationRuns.status, q.status as never) : undefined,
        cAt && cId ? or(lt(automationRuns.startedAt, new Date(cAt)), and(eq(automationRuns.startedAt, new Date(cAt)), lt(automationRuns.id, cId))) : undefined,
      ),
    )
    .orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const items = [];
  for (const r of page) items.push(await runRowOf(db, viewer, r.run, r.automation, visible, { withLog: q.log !== "none" }));
  const last = page.at(-1);
  return { items, nextCursor: rows.length > limit && last ? `${last.run.startedAt.toISOString()}|${last.run.id}` : null };
}

const stale = () => new AutomationError(409, "stale", "The run is no longer waiting on that step");

/**
 * Una decisione vale per il passo che aspetta, da chi decide ADESSO. Gira in
 * una transazione con la run bloccata (review F1, M4): due decisioni insieme
 * si mettono in fila, e la seconda trova in coda la prima. Un input già in
 * coda dice perché la decisione non cade: una sospensione → `suspended`, una
 * decisione propria → `pending` (il passo è deciso, l'esecutore la applica),
 * quella di un altro → `stale`.
 */
async function decide(
  db: Db,
  viewer: Viewer,
  code: string,
  n: number,
  status: "waiting_approval" | "waiting_project",
  expected: { path: string; round?: number },
  write: (tx: Db, run: RunRecord) => Promise<Record<string, unknown>>,
): Promise<void> {
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [a] = await tx.select({ id: automations.id }).from(automations).where(eq(automations.code, code.toUpperCase()));
    if (a) await tx.select({ id: automationRuns.id }).from(automationRuns).where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.n, n))).for("update");
    const { run, deciders } = await visibleRun(tx, viewer, code, n);
    if (run.status === "suspended") throw new AutomationError(409, "suspended", "The automation is paused");
    const [queued] = await tx
      .select({ byId: automationRunInputs.byId, input: automationRunInputs.input })
      .from(automationRunInputs)
      .where(and(eq(automationRunInputs.runId, run.id), sql`${automationRunInputs.consumedAt} is null`))
      .orderBy(asc(automationRunInputs.createdAt))
      .limit(1);
    if (queued) {
      if ((queued.input as { control?: unknown } | null)?.control === "suspend") throw new AutomationError(409, "suspended", "The automation is paused");
      if (queued.byId === viewer.id) throw new AutomationError(409, "pending", "Your decision is already being applied");
      throw stale();
    }
    if (run.status !== status) throw stale();
    if (cursorOf(run).path !== expected.path || (pendingOf(run)?.round ?? 0) !== (expected.round ?? 0)) throw stale();
    if (!deciders.includes(viewer.id)) throw forbidden("to be an approver of this step");
    const input = await write(tx, run);
    await tx.insert(automationRunInputs).values({ runId: run.id, input, byId: viewer.id });
  });
}

export async function approveRun(db: Db, viewer: Viewer, code: string, n: number, body: { expectedPath: string; expectedRound?: number; edited?: Record<string, string> }): Promise<void> {
  await decide(db, viewer, code, n, "waiting_approval", { path: body.expectedPath, round: body.expectedRound }, async (tx, run) => {
    if (body.edited) {
      const flow = await flowOfRun(tx, run);
      try {
        checkEdited(flow ? stepAt(flow.steps, body.expectedPath)?.kind : undefined, body.edited);
      } catch {
        throw new AutomationError(400, "edited", "Those fields can't be edited on this step");
      }
    }
    return { kind: "approved", path: body.expectedPath, byId: viewer.id, ...(body.edited ? { edited: body.edited } : {}) };
  });
}

export async function rejectRun(db: Db, viewer: Viewer, code: string, n: number, body: { expectedPath: string; expectedRound?: number }): Promise<void> {
  await decide(db, viewer, code, n, "waiting_approval", { path: body.expectedPath, round: body.expectedRound }, async () => ({ kind: "rejected", path: body.expectedPath, byId: viewer.id }));
}

export async function chooseRunProject(db: Db, viewer: Viewer, code: string, n: number, body: { projectId: string; expectedPath: string; expectedRound?: number }): Promise<void> {
  await decide(db, viewer, code, n, "waiting_project", { path: body.expectedPath, round: body.expectedRound }, async (tx) => {
    if (!sees(await seen(tx, viewer), body.projectId)) throw notFound();
    return { kind: "project_chosen", projectId: body.projectId, byId: viewer.id };
  });
}

/** Annulla, Riprova, Salta: chi gestisce l'automazione; l'esecutore li applica. */
export async function controlRun(db: Db, viewer: Viewer, code: string, n: number, op: "cancel" | "retry" | "skip"): Promise<void> {
  const a = await visibleAutomation(db, viewer, code);
  if (!(await canManage(db, viewer, a.projectId))) throw forbidden();
  const [run] = await db.select().from(automationRuns).where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.n, n)));
  if (!run) throw notFound();
  if (op === "cancel" && TERMINAL.has(run.status)) throw new AutomationError(409, "finished", "The run has already finished");
  if (op !== "cancel" && (run.status !== "failed" || cursorOf(run).path === null)) throw new AutomationError(409, "not_failed", "Only a failed step can be retried or skipped");
  await db.insert(automationRunInputs).values({ runId: run.id, input: { control: op, byId: viewer.id }, byId: viewer.id });
}

export const OPEN_RUN_STATUSES = OPEN_STATUSES;

const str = (v: unknown) => (typeof v === "string" ? v : "");

async function projectFor(db: Db, visible: "all" | ReadonlySet<string>, id: string | null): Promise<SimulationProject> {
  if (!id || !sees(visible, id)) return { id: "", code: "", name: "" };
  const [p] = await db.select({ id: projects.id, code: projects.code, name: projects.name }).from(projects).where(eq(projects.id, id));
  return p ?? { id: "", code: "", name: "" };
}

/**
 * L'anteprima condivisa del passo che un'esecuzione aspetta di far approvare
 * (la stessa forma della prova, `SimulationEffectPreview`; la specifica è
 * `pendingEffect.ts` del prototipo). I testi vengono dall'anteprima COME LA
 * VEDE chi guarda (`viewed`, già passata da R-J12); dal passo si risolvono
 * solo incaricato, reparto e scadenza, coi piani dell'esecutore. `null` se
 * non aspetta un'approvazione o per i passi senza anteprima condivisa.
 */
export async function pendingEffectOf(
  db: Db,
  visible: "all" | ReadonlySet<string>,
  source: RunRecord,
  a: AutomationRecord,
  viewed: AutomationRunRow,
  flow: AutomationFlow,
): Promise<SimulationEffectPreview | null> {
  const path = cursorOf(source).path;
  if (source.status !== "waiting_approval" || !path) return null;
  const preview = viewed.pending?.preview ?? {};
  if (Object.keys(preview).length === 0) return null;
  const step = stepAt(flow.steps, path) as ActionStep | null;
  if (!step) return null;
  const where = { stepId: step.id, path };
  const owner = a.ownerId ?? "";
  const automation = a as unknown as Automation;
  const projectId = approvalProjectOf(pendingOf(source)?.preview ?? {}, automation);
  const now = new Date().toISOString();
  const effectOf = (): ActionEffect | null => {
    const progetto = pendingOf(source)?.preview.progetto;
    const target: ResolvedTarget | null = typeof progetto === "string" ? { mode: "fixed", projectId: progetto } : projectOf(step) ? { mode: "own" } : null;
    try {
      const st = restoreState(flow, { ...viewed, cursor: path, status: source.status }, now);
      const { args } = describe(st, step, target);
      return { kind: step.kind, stepId: step.id, path, args, ...(target ? { projectTarget: target } : {}) } as ActionEffect;
    } catch {
      return null;
    }
  };
  switch (step.kind) {
    case "createTask": {
      const eff = effectOf();
      if (!eff) return null;
      const world = await loadPlanWorld(db, { ownerId: owner, projectIds: [a.projectId, ...(projectId ? [projectId] : [])] });
      const plan = planTask(world, eff, automation, owner, now);
      if (!plan.ok) return null;
      const { assignee } = plan.plan;
      return {
        kind: "task",
        ...where,
        project: await projectFor(db, visible, projectId),
        title: str(preview.titolo),
        description: str(preview.descrizione),
        assigneeId: assignee.assigneeId,
        departmentId: plan.plan.departmentId,
        assignedBy: assignee.by,
        role: assignee.role,
        warning: assignee.why ?? null,
        dueDate: plan.plan.dueDate,
        dueInDays: step.dueInDays,
        milestone: null,
      };
    }
    case "createMilestone": {
      const eff = effectOf();
      if (!eff) return null;
      const world = await loadPlanWorld(db, { ownerId: owner, projectIds: [a.projectId, ...(projectId ? [projectId] : [])] });
      const plan = planMilestone(world, eff, automation, owner, now);
      if (!plan.ok) return null;
      return { kind: "milestone", ...where, project: await projectFor(db, visible, projectId), name: str(preview.nome), dueDate: plan.plan.dueDate, dueInDays: step.dueInDays };
    }
    case "createRequest":
      return { kind: "request", ...where, project: await projectFor(db, visible, projectId), title: str(preview.titolo), description: str(preview.descrizione) };
    default:
      return null;
  }
}
