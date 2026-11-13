import { automationRunInputs, automationRunLog, automationRuns, automations, automationVersions, googleAccounts, projects, type Db } from "@stubwise/db";
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
  hideReplies,
  stepAt,
  taintedKeys,
  visitSteps,
  type Step,
  type Automation,
  type AutomationFlow,
  type AutomationRun,
  type AutomationRunDetail,
  type AutomationRunRow,
  type ReasonCode,
  type RunLogEntry,
  type RunStatus,
} from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { canManageIntegrations, writeClientLink } from "./sources.js";
import { AutomationError, sourcesFor, canManage, flowFor, forbidden, GENERAL_PERMISSION, managesGeneral, notFound, seen, sees, seesAutomation, visibleAutomation, type AutomationRecord, type Viewer } from "./model.js";

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
export async function runRowOf(db: Db, viewer: Viewer, r: RunRecord, a: AutomationRecord, visible?: "all" | ReadonlySet<string>, opts: { withLog?: boolean; decider?: boolean } = {}): Promise<AutomationRunRow> {
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
    // F3 (C-F3-4): ferma al passo di Claude per il budget del mese; riparte da sola.
    aiWaiting: (c as { aiWaiting?: { reason: "monthly_budget" } | null }).aiWaiting ?? null,
  };
  if (pending && typeof pending.preview.progetto === "string" && v !== "all") hideProject(run.pending!.preview, v);
  // R-J16 (area 7, F2): il testo della risposta del cliente lo vede solo il proprietario; chi decide ne vede l'anteprima intera (R-J14).
  // C1 (review F2): la posta di un'esecuzione la legge il proprietario della SUA
  // casella (ripubblicare con un'altra casella non la passa a un altro); senza
  // casella, il proprietario dell'automazione.
  // F4, R-J13 lungo la catena: una figlia di «avvia un'altra» porta la posta della casella d'ORIGINE:
  // la legge solo il proprietario di quella, anche se la figlia è di un altro.
  const mailBox = r.mailOriginAccountId ?? r.mailboxAccountId;
  const [box] = mailBox ? await db.select({ userId: googleAccounts.userId }).from(googleAccounts).where(eq(googleAccounts.id, mailBox)) : [];
  const mailOwner = mailBox ? (box?.userId ?? null) : a.ownerId;
  if (viewer.id !== mailOwner) hideReplies(run, opts.decider !== true);
  // R-J13 (area 7, F2, la regola di `viewRun` del prototipo): di un'esecuzione
  // partita da un'email solo il proprietario vede mittente, oggetto e testo.
  // Gli altri leggono l'evento vuoto con `mailHidden`, il titolo col solo nome
  // e le righe senza dati (nessuna eco dell'email); chi decide vede
  // l'anteprima del passo. Lungo la catena («avvia un'altra», F4) vale la casella d'origine.
  // F3, C-F3-7 e review F3 I3: ciò che Claude ha ricavato da un dato tinto (di
  // fuori: la risposta di un cliente, un'email, una richiesta dal supporto) lo
  // legge solo il proprietario della posta, admin compresi. Per gli altri: la
  // motivazione e i campi della riga di Claude, le stesse chiavi in `vars`, ogni
  // eco dei loro valori nelle righe dopo, nel titolo e nell'anteprima, e
  // l'uscita rifiutata di un `unknown_outcome`.
  if (viewer.id !== mailOwner && run.log.some((e) => e.kind === "claude")) {
    const flow = await flowOfRun(db, r);
    if (flow) {
      // F4: i campi di una sorgente (il webhook in arrivo) sono tinti come gli altri dati di fuori.
      // Review F4: per una figlia il cui evento viene da fuori (`event_untrusted`), ogni campo dell'inizio è tinto.
      const tainted = taintedKeys(flow, await sourcesFor(db, flow), { eventUntrusted: r.eventUntrusted });
      const isTainted = (k: string) => tainted.has(k) || [...tainted].some((t) => k.startsWith(`${t}.`));
      const claudeSteps = new Map<string, Extract<Step, { kind: "claude" }>>();
      visitSteps(flow.steps, (st) => {
        if (st.kind === "claude") claudeSteps.set(st.id, st);
      });
      const hiddenKeys = new Set<string>();
      const secrets = new Set<string>();
      const collect = (v: unknown) => {
        if (typeof v === "string" && v.trim().length >= 3) secrets.add(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === "object") Object.values(v).forEach(collect);
      };
      for (const e of run.log) {
        const st = e.kind === "claude" ? claudeSteps.get(e.stepId) : undefined;
        if (!st || !st.inputs.some(isTainted)) continue;
        for (const f of st.fields) {
          hiddenKeys.add(f.key);
          collect(e.output[f.key]);
          collect(run.vars[f.key]);
        }
        if (typeof e.output.uscita === "string" && !st.outcomes.includes(e.output.uscita)) collect(e.output.uscita);
        if (typeof e.why?.params?.outcome === "string") collect(e.why.params.outcome);
        e.reason = null;
        e.output = Object.fromEntries(Object.entries(e.output).filter(([k]) => k === "uscita" && typeof e.output.uscita === "string" && st.outcomes.includes(e.output.uscita)));
        if (e.why) e.why = { code: e.why.code };
        e.reasonHidden = true;
      }
      if (hiddenKeys.size > 0 || secrets.size > 0) {
        const blank = (v: unknown) => (Array.isArray(v) ? [] : typeof v === "string" ? "" : null);
        for (const k of hiddenKeys) if (k in run.vars) run.vars[k] = blank(run.vars[k]);
        const echoes = (text: string) => [...secrets].some((x) => text.includes(x));
        const scrub = (o: unknown): boolean => {
          if (!o || typeof o !== "object") return false;
          let hit = false;
          for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
            if (typeof v === "string" && echoes(v)) {
              (o as Record<string, unknown>)[k] = "";
              hit = true;
            } else if (v && typeof v === "object" && scrub(v)) hit = true;
          }
          return hit;
        };
        for (const e of run.log) if (scrub(e.input) || scrub(e.output)) e.reasonHidden = true;
        scrub(run.vars);
        if (run.title && echoes(run.title)) run.title = a.name;
        if (run.pending && opts.decider !== true) scrub(run.pending.preview);
      }
    }
  }
  if (viewer.id !== mailOwner && run.event && typeof run.event === "object" && "email" in run.event) {
    const hidden = { email: { mittente: "", oggetto: "", testo: "" } };
    run.event = hidden;
    run.title = a.name;
    run.mailHidden = true;
    run.vars = {};
    for (const e of run.log) {
      if (e.kind === "trigger") e.output = structuredClone(hidden);
      else {
        e.input = {};
        e.output = {};
        e.reason = null;
        e.why = e.why ? { code: e.why.code } : null;
      }
    }
    if (run.pending && opts.decider !== true) run.pending.preview = {};
  }
  return { ...run, code: runCode(a, r.n), automationCode: a.code, automationName: a.name, automationProjectId: a.projectId, round: pending?.round ?? 0 };
}

/** Un'esecuzione che chi guarda vede (l'automazione, o è fra chi decide adesso); 404 altrimenti. */
export async function visibleRun(db: Db, viewer: Viewer, code: string, n: number): Promise<{ run: RunRecord; automation: AutomationRecord; deciders: string[] }> {
  const [a] = await db.select().from(automations).where(eq(automations.code, code.toUpperCase()));
  if (!a) throw notFound();
  const [r] = await db.select().from(automationRuns).where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.n, n)));
  if (!r) throw notFound();
  const deciders = await decidersOf(db, r, a);
  if (!seesAutomation(await seen(db, viewer), viewer, a) && !deciders.includes(viewer.id)) throw notFound();
  return { run: r, automation: a, deciders };
}

export async function getRun(db: Db, viewer: Viewer, code: string, n: number): Promise<AutomationRunDetail> {
  const { run, automation, deciders } = await visibleRun(db, viewer, code, n);
  const visible = await seen(db, viewer);
  const row = await runRowOf(db, viewer, run, automation, visible, { decider: deciders.includes(viewer.id) });
  const flow = (await flowOfRun(db, run)) ?? { trigger: { kind: "manual" as const }, steps: [], titleTemplate: "" };
  const seesIt = seesAutomation(visible, viewer, automation);
  const manage = seesIt && (await canManage(db, viewer, automation.projectId));
  const [parent] = run.parentRunId && seesIt ? await db.select().from(automationRuns).where(eq(automationRuns.id, run.parentRunId)) : [];
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
      rememberClient: run.status === "waiting_project" && deciders.includes(viewer.id) && canManageIntegrations(viewer),
    },
    parent: parent && parentAutomation && seesAutomation(visible, viewer, parentAutomation) ? { id: parent.id, code: runCode(parentAutomation, parent.n) } : null,
    children: children.filter((c) => seesAutomation(visible, viewer, c)).map((c) => ({ id: c.id, code: `${c.code} #${c.n}`, status: c.status })),
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
  const generals = managesGeneral(viewer);
  if (visible !== "all" && visible.size === 0 && !generals) return { items: [], nextCursor: null };
  const limit = Math.min(q.limit ?? 50, 200);
  // Le esecuzioni delle generali solo a chi le vede (R-G5), filtrate nella WHERE.
  const projectScope = visible === "all" ? isNotNull(automations.projectId) : visible.size > 0 ? inArray(automations.projectId, [...visible]) : sql`false`;
  const scope = generals ? or(projectScope, isNull(automations.projectId)) : projectScope;
  const [cAt, cId] = q.cursor ? q.cursor.split("|") : [];
  const rows = await db
    .select({ run: automationRuns, automation: automations })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        scope,
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

/**
 * «Scegli il progetto» (il proprietario), fra quelli che vede. Con `remember`
 * (F4, shape [A 26]) la scelta entra anche nella tabella cliente → progetto,
 * a nome di chi sceglie, nella STESSA transazione: senza `integrations.manage`
 * è 403 e non si sceglie niente (decisione di 46, la regola del prototipo: un
 * progetto non si sceglie in silenzio lasciando credere che la tabella sia
 * stata scritta). La chiave è quella del `pending` (`clientKeyOf` la
 * normalizza), il nome quello del cliente se c'è, altrimenti la chiave.
 */
export async function chooseRunProject(db: Db, viewer: Viewer, code: string, n: number, body: { projectId: string; expectedPath: string; expectedRound?: number; remember?: boolean }): Promise<void> {
  await decide(db, viewer, code, n, "waiting_project", { path: body.expectedPath, round: body.expectedRound }, async (tx, run) => {
    if (!sees(await seen(tx, viewer), body.projectId)) throw notFound();
    if (body.remember) {
      if (!canManageIntegrations(viewer)) throw new AutomationError(403, "forbidden", "You need integrations.manage to remember the client");
      const preview = (pendingOf(run)?.preview ?? {}) as { clientKey?: unknown; clientName?: unknown };
      const key = typeof preview.clientKey === "string" ? preview.clientKey : "";
      const name = typeof preview.clientName === "string" && preview.clientName.trim() ? preview.clientName : key;
      if (!key.trim()) throw new AutomationError(409, "client", "This run has no client to remember");
      await writeClientLink(tx, viewer, key, { clientName: name, projectId: body.projectId });
    }
    return { kind: "project_chosen", projectId: body.projectId, byId: viewer.id };
  });
}

/** Annulla, Riprova, Salta: chi gestisce l'automazione; l'esecutore li applica. */
export async function controlRun(db: Db, viewer: Viewer, code: string, n: number, op: "cancel" | "retry" | "skip"): Promise<void> {
  const a = await visibleAutomation(db, viewer, code);
  if (!(await canManage(db, viewer, a.projectId))) throw forbidden(a.projectId === null ? GENERAL_PERMISSION : undefined);
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
      const world = await loadPlanWorld(db, { ownerId: owner, projectIds: [a.projectId, projectId].filter((p): p is string => !!p) });
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
      const world = await loadPlanWorld(db, { ownerId: owner, projectIds: [a.projectId, projectId].filter((p): p is string => !!p) });
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
