import {
  advance,
  initialState,
  type EffectRequest,
  type EngineInput,
  type EngineState,
  type EngineStep,
  type ResolvedTarget,
} from "../../domain/automations/engine";
import { stepAt } from "../../domain/automations/fields";
import { describe, projectOf, type ActionStep } from "../../domain/automations/preview";
import type { FlowIssue } from "../../domain/automations/validate";
import { lower } from "../mail/compose";
import { onBeforePersonaChange } from "../session";
import { copy, gate, now, onStoreReset, state, visibleProjectIds } from "../store";
import type {
  Automation,
  RunLogEntry,
  SimulationEffectPreview,
  SimulationEmailPreview,
  SimulationMilestonePreview,
  SimulationProject,
  SimulationTaskPreview,
  SimulationView,
  SimulationWaiting,
} from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import { fakeClaude } from "./claudeFake";
import {
  bouncedFailure,
  planEmail,
  planMilestone,
  planNotify,
  planRequest,
  planStart,
  planTask,
  resolveProject,
  RUN_LIMIT_REASON,
  type ActionEffect,
  type EffectOutcome,
} from "./plans";
import { configErrorsOf, hideProject } from "./reads";
import { canStartRun, NO_APPROVER_REASON } from "./runner";
import {
  approvalProjectOf,
  approversFor,
  automationById,
  canManageAutomation,
  canSeeAutomation,
} from "./visibility";
import { checkEdited } from "./writes";

// La prova di un'automazione (area 7): lo STESSO motore delle esecuzioni
// (`advance`), con un esecutore finto che produce anteprime e non scrive
// MAI nello store — nessuna task, traguardo, richiesta, email, notifica,
// esecuzione, riga di registro vera, né un contatore che si muove.
//
// - Le anteprime usano i piani dell'esecutore vero (`plans.ts`): stesso
//   incaricato, stesso progetto (tabella cliente → progetto compresa),
//   stessi testi, stessa casella; e dove la vera fallirebbe, la prova
//   fallisce allo stesso passo con lo stesso codice e la stessa motivazione.
//   Claude risponde col Claude finto delle esecuzioni.
// - Non corre da sola: si avanza solo con «Passo successivo» (`next`: un
//   effetto) o «Vai alla prossima fermata» (`run`), e si sblocca dalle
//   fermate con gli input del motore (approvazione, risposta, tempo,
//   progetto scelto). Approva chi prova, a nome suo; la fermata dice chi
//   approverebbe davvero.
// - «Avvia un'altra automazione» dice solo che partirebbe: non ne percorre
//   i passi.
// - Chi vede ma non gestisce non prova; un flusso con errori di
//   configurazione non parte (`SimulationConfigError`, con l'elenco).
// - Le prove stanno in memoria, per persona; si buttano con
//   `endSimulation`, con `resetApi` e col cambio di persona. Mai salvate.

/** La prova non parte: il flusso ha errori di configurazione (`issues` dice dove). */
export class SimulationConfigError extends Error {
  constructor(readonly issues: FlowIssue[]) {
    super("invalid: config");
  }
}

/** Un input della prova: «Passo successivo», «Vai alla prossima fermata», o un input del motore. */
export type SimulationInput = EngineInput | { kind: "next" } | { kind: "run" };

interface Sim {
  id: string;
  personId: string;
  automationId: string;
  version: number;
  draft: boolean;
  ownerId: string;
  event: Record<string, unknown>;
  engine: EngineState;
  /** L'effetto chiesto dal motore, che «Passo successivo» farebbe. */
  pending: EffectRequest | null;
  log: RunLogEntry[];
  /** I riferimenti interni dati al motore per i traguardi (`milestoneRef`): mai mostrati. */
  milestoneRefs: Map<string, SimulationMilestonePreview>;
  preview: SimulationView["preview"];
}

const sims = new Map<string, Sim>();
let seq = 0;
onStoreReset(() => sims.clear());
onBeforePersonaChange(() => sims.clear());

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** Un progetto per un'anteprima (pieno: la vista lo nasconde a chi non lo vede). */
function projectRef(id: string): SimulationProject {
  const p = state.projectsById.get(id);
  return { id, code: p?.code ?? "", name: p?.name ?? "" };
}

// --- l'esecutore finto --------------------------------------------------------------

type Previewed =
  | { ok: true; preview: SimulationEffectPreview; reason?: string }
  | { ok: false; outcome: EffectOutcome };

/** Cosa farebbe un'azione, coi piani dell'esecutore vero. Non scrive. */
function previewOf(sim: Sim, a: Automation, eff: ActionEffect, at: string): Previewed {
  const owner = sim.ownerId;
  const where = { stepId: eff.stepId, path: eff.path };
  const dueInDays = (eff.args as { dueInDays?: number | null }).dueInDays ?? null;
  switch (eff.kind) {
    case "createTask": {
      const p = planTask(eff, a, owner, at);
      if (!p.ok) return p;
      const { plan } = p;
      const ms = plan.milestoneCode ? sim.milestoneRefs.get(plan.milestoneCode) : undefined;
      return {
        ok: true,
        reason: plan.assignee.reason,
        preview: {
          kind: "task",
          ...where,
          project: projectRef(plan.projectId),
          title: plan.title,
          description: plan.description,
          assigneeId: plan.assignee.assigneeId,
          departmentId: plan.departmentId,
          assignedBy: plan.assignee.by,
          role: plan.assignee.role,
          warning: plan.assignee.reason ?? null,
          dueDate: plan.dueDate,
          dueInDays,
          milestone:
            ms && ms.project.id === plan.projectId
              ? { name: ms.name, stepId: ms.stepId, path: ms.path }
              : null,
        },
      };
    }
    case "createMilestone": {
      const p = planMilestone(eff, a, owner, at);
      if (!p.ok) return p;
      return {
        ok: true,
        preview: {
          kind: "milestone",
          ...where,
          project: projectRef(p.plan.projectId),
          name: p.plan.name,
          dueDate: p.plan.dueDate,
          dueInDays,
        },
      };
    }
    case "createRequest": {
      const p = planRequest(eff, a, owner);
      if (!p.ok) return p;
      return {
        ok: true,
        preview: {
          kind: "request",
          ...where,
          project: projectRef(p.plan.projectId),
          title: p.plan.title,
          description: p.plan.description,
        },
      };
    }
    case "sendEmail": {
      // Nella prova non ci sono messaggi veri: i controlli si fanno come per
      // una conversazione nuova, e la conversazione si dice nell'anteprima.
      const p = planEmail(
        eff,
        owner,
        sim.preview.emails.length,
        () => ({ threadId: null, mode: "new", replyToMessageId: null }),
        (i: number) => `att-${sim.id}-${eff.stepId}-${i}`,
        // La casella scelta vale per il proprietario di adesso; chi prova una bozza usa la sua (R-J15).
        owner === a.ownerId ? (a.mailbox ?? null) : null,
      );
      if (!p.ok) return p;
      if (p.plan.bounced) return { ok: false, outcome: bouncedFailure(p.plan.to) };
      // Come `threadFor` dell'esecutore vero: le email allo stesso indirizzo
      // stanno in UNA conversazione, quella aperta dalla prima.
      const first = sim.preview.emails.find((e) => lower(e.to) === lower(p.plan.to));
      return {
        ok: true,
        preview: {
          kind: "email",
          ...where,
          from: p.plan.from,
          to: p.plan.to,
          subject: p.plan.subject,
          body: p.plan.body,
          attachments: p.plan.input.attachments.map((x) => x.name),
          sameConversationAs: first ? { stepId: first.stepId, path: first.path } : null,
        },
      };
    }
    case "notify": {
      const p = planNotify(eff, a);
      if (!p.ok) return p;
      return {
        ok: true,
        preview: {
          kind: "notification",
          ...where,
          personId: p.plan.personId,
          text: p.plan.text,
          project: p.plan.projectId ? projectRef(p.plan.projectId) : null,
        },
      };
    }
    case "startAutomation": {
      // Nella prova la catena è la sola automazione provata.
      const p = planStart(eff, owner, [a.id]);
      if (!p.ok) return p;
      const target = p.plan;
      if (!canStartRun(target)) {
        return {
          ok: false,
          outcome: {
            input: {
              kind: "effect_result",
              ok: false,
              error: "run_limit",
              reason: RUN_LIMIT_REASON(target.name),
            },
          },
        };
      }
      return {
        ok: true,
        preview: {
          kind: "start",
          ...where,
          automationId: target.id,
          code: target.code,
          name: target.name,
        },
      };
    }
  }
}

/** Esegue un effetto per finta: un'anteprima al posto della scrittura, e l'input per il motore. */
function execute(sim: Sim, a: Automation, eff: EffectRequest): EngineInput {
  if (eff.kind === "claude") {
    const r = fakeClaude(eff.step, eff.vars, sim.ownerId);
    sim.preview.claude.push({
      stepId: eff.stepId,
      path: eff.path,
      outcome: r.outcome ?? null,
      fields: copy(r.fields ?? {}),
      reason: r.reason,
      read: r.read,
    });
    return r;
  }
  if (eff.kind === "resolve_project") return resolveProject(eff, sim.ownerId).input;
  const r = previewOf(sim, a, eff, sim.engine.now);
  if (!r.ok) return r.outcome.input;
  // Il motore lega i traguardi alle task per «codice»: nella prova un riferimento interno.
  const ref = `${sim.id}:${eff.path}`;
  const { kind, ...item } = r.preview;
  if (kind === "task") sim.preview.tasks.push(item as SimulationTaskPreview);
  else if (kind === "milestone") {
    sim.preview.milestones.push(item as SimulationMilestonePreview);
    sim.milestoneRefs.set(ref, item as SimulationMilestonePreview);
  } else if (kind === "request")
    sim.preview.requests.push(item as SimulationView["preview"]["requests"][number]);
  else if (kind === "email") sim.preview.emails.push(item as SimulationEmailPreview);
  else if (kind === "notification")
    sim.preview.notifications.push(item as SimulationView["preview"]["notifications"][number]);
  else sim.preview.starts.push(item as SimulationView["preview"]["starts"][number]);
  return {
    kind: "effect_result",
    ok: true,
    codes: [ref],
    ...(r.reason ? { reason: r.reason } : {}),
  };
}

// --- il motore ----------------------------------------------------------------------

/** Scrive nella prova un passo del motore; il progetto del cliente si cerca subito (non è un passo). */
function apply(sim: Sim, a: Automation, r: EngineStep): void {
  for (const row of r.log) sim.log.push({ at: r.state.now, ...copy(row), effects: blank(row) });
  // Un input che il motore ignora (es. `time` mentre un effetto aspetta)
  // non chiede di nuovo l'effetto: quello in sospeso resta finché il motore
  // lo aspetta, o la prova non avanzerebbe più.
  const stillAwaited =
    r.state.status === "running" &&
    (r.state.awaiting?.kind === "effect" || r.state.awaiting?.kind === "claude") &&
    sim.pending?.path === r.state.awaiting.path;
  sim.engine = r.state;
  sim.pending = r.effects[0] ?? (stillAwaited ? sim.pending : null);
  if (sim.pending?.kind === "resolve_project") {
    const eff = sim.pending;
    sim.pending = null;
    return apply(sim, a, advance(sim.engine, resolveProject(eff, sim.ownerId).input));
  }
  failIfNoApprover(sim, a);
}

/** Nel registro della prova nessun codice: non nasce niente. */
const blank = (row: EngineStep["log"][number]) =>
  row.effects.map((x) => ({ kind: x.kind, code: "" }));

/** R-J11 come nell'esecuzione vera: un'approvazione che nessuno può dare fallisce `no_approver`. */
function failIfNoApprover(sim: Sim, a: Automation): void {
  const st = sim.engine;
  const aw = st.awaiting;
  if (st.status !== "waiting_approval" || aw?.kind !== "approval") return;
  if (approversFor(a, aw.who, approvalProjectOf(aw.preview, a)).length > 0) return;
  const step = stepAt(st.flow.steps, aw.path);
  sim.log.push({
    at: st.now,
    stepId: step?.id ?? "trigger",
    path: aw.path,
    kind: step?.kind ?? "trigger",
    input: copy(aw.preview),
    output: {},
    reason: NO_APPROVER_REASON,
    byId: null,
    effects: [],
    outcome: "failed",
  });
  sim.engine = {
    ...st,
    status: "failed",
    error: "no_approver",
    awaiting: null,
    waitingUntil: null,
  };
}

/** «Passo successivo»: l'effetto in sospeso, eseguito per finta. */
function stepOnce(sim: Sim, a: Automation): void {
  if (TERMINAL.has(sim.engine.status)) throw invalid("finished");
  // Ferma (attesa, approvazione, progetto): il motore non chiede effetti.
  const eff = sim.pending;
  if (!eff) throw invalid("stopped");
  sim.pending = null;
  apply(sim, a, advance(sim.engine, execute(sim, a, eff)));
}

function handle(me: string, sim: Sim, a: Automation, input: SimulationInput): void {
  const st = sim.engine;
  switch (input.kind) {
    case "next":
      return stepOnce(sim, a);
    case "run":
      stepOnce(sim, a);
      while (sim.pending) stepOnce(sim, a);
      return;
    case "approved":
    case "rejected": {
      if (st.status !== "waiting_approval" || st.cursor === null) throw invalid("not_waiting");
      // Nella prova approva chi prova, a nome suo, e il passo è quello che aspetta.
      if (input.kind === "approved" && input.edited) {
        checkEdited(stepAt(st.flow.steps, st.cursor)?.kind, input.edited);
      }
      const decided =
        input.kind === "approved"
          ? {
              kind: "approved" as const,
              path: st.cursor,
              byId: me,
              ...(input.edited ? { edited: { ...input.edited } } : {}),
            }
          : { kind: "rejected" as const, path: st.cursor, byId: me };
      return apply(sim, a, advance(st, decided));
    }
    case "project_chosen": {
      if (st.status !== "waiting_project") throw invalid("not_waiting");
      if (!state.projectsById.has(input.projectId) || !visibleProjectIds(me).has(input.projectId))
        throw notFound();
      return apply(sim, a, advance(st, { ...input, byId: me }));
    }
    case "event":
      if (st.status !== "waiting_event") throw invalid("not_waiting");
      return apply(sim, a, advance(st, input));
    case "time":
      // «Avanti» vale solo per un'attesa: altrove il tempo della prova non si sposta.
      if (st.status !== "waiting_event") throw invalid("not_waiting");
      if (Number.isNaN(Date.parse(input.now))) throw invalid("time");
      return apply(sim, a, advance(st, input));
    default:
      // Gli esiti degli effetti e di Claude li produce solo l'esecutore finto.
      throw invalid("input");
  }
}

// --- la vista -----------------------------------------------------------------------

/** Il passo al cursore quando sta per fare qualcosa: la sua anteprima, o il fallimento. */
function currentOf(sim: Sim, a: Automation): SimulationView["current"] {
  const st = sim.engine;
  const aw = st.awaiting;
  if (!aw || TERMINAL.has(st.status)) return null;
  const step = stepAt(st.flow.steps, aw.path);
  if (!step) return null;
  const at = { stepId: step.id, path: aw.path, kind: step.kind };
  let eff: ActionEffect | null = null;
  if (aw.kind === "effect" && sim.pending && "args" in sim.pending) eff = sim.pending;
  else if (aw.kind === "approval") {
    // L'effetto che l'approvazione sbloccherebbe, coi dati di adesso.
    const action = step as ActionStep;
    const progetto = aw.preview.progetto;
    const target: ResolvedTarget | null =
      typeof progetto === "string"
        ? { mode: "fixed", projectId: progetto }
        : projectOf(action)
          ? { mode: "own" }
          : null;
    const { args } = describe(st, action, target);
    eff = {
      kind: action.kind,
      stepId: action.id,
      path: aw.path,
      args,
      ...(target ? { projectTarget: target } : {}),
    };
  } else if (aw.kind !== "claude") return null;
  if (!eff) return { ...at, preview: null, failure: null };
  const r = previewOf(sim, a, eff, st.now);
  if (r.ok) return { ...at, preview: r.preview, failure: null };
  const out = r.outcome.input as Extract<EngineInput, { kind: "effect_result" }>;
  return { ...at, preview: null, failure: { error: out.error ?? "", reason: out.reason ?? null } };
}

function waitingOf(sim: Sim, a: Automation): SimulationWaiting | null {
  const st = sim.engine;
  const aw = st.awaiting;
  if (!aw) return null;
  const step = stepAt(st.flow.steps, aw.path);
  const at = { stepId: step?.id ?? "", path: aw.path };
  if (st.status === "waiting_approval" && aw.kind === "approval") {
    return {
      ...at,
      kind: "approval",
      who: copy(aw.who),
      realApproverIds: approversFor(a, aw.who, approvalProjectOf(aw.preview, a)),
      ownerId: sim.ownerId,
    };
  }
  if (st.status === "waiting_event" && aw.kind === "wait" && step?.kind === "wait") {
    const w = step.for;
    const email =
      "replyTo" in w ? sim.preview.emails.filter((e) => e.stepId === w.replyTo).at(-1) : undefined;
    const task =
      "taskClosed" in w
        ? sim.preview.tasks.filter((t) => t.stepId === w.taskClosed).at(-1)
        : undefined;
    return {
      ...at,
      kind: "event",
      until: aw.until,
      wait: copy(w),
      email: email ? copy(email) : null,
      task: task ? copy(task) : null,
    };
  }
  if (st.status === "waiting_project" && aw.kind === "project") {
    const cliente = (sim.event.cliente as { nome?: unknown } | undefined)?.nome;
    return {
      ...at,
      kind: "project",
      clientKey: aw.clientKey,
      clientName: typeof cliente === "string" ? cliente : null,
      ownerId: sim.ownerId,
    };
  }
  return null;
}

/** La prova come la vede chi prova: i progetti che non vede restano senza id né nome (R-G5). */
function view(me: string, sim: Sim, a: Automation): SimulationView {
  const visible = visibleProjectIds(me);
  const HIDDEN: SimulationProject = { id: "", code: "", name: "" };
  // Un'automazione da avviare che chi prova non vede: né id, né codice, né nome.
  const seesAutomation = (id: unknown) => {
    const target = typeof id === "string" ? automationById(id) : undefined;
    return !!target && canSeeAutomation(me, target);
  };
  const mask = <T extends object>(x: T): T => {
    const out = copy(x) as T & {
      project?: SimulationProject | null;
      automationId?: string;
      code?: string;
      name?: string;
    };
    if (out.project && !visible.has(out.project.id)) out.project = { ...HIDDEN };
    if (out.automationId !== undefined && !seesAutomation(out.automationId))
      Object.assign(out, { automationId: "", code: "", name: "" });
    return out;
  };
  const log = sim.log.map((e) => {
    const row = copy(e);
    hideProject(row.input, visible);
    hideProject(row.output, visible);
    if (row.kind === "startAutomation" && !seesAutomation(row.input.automazione))
      row.input.automazione = "";
    return row;
  });
  const current = currentOf(sim, a);
  const waiting = waitingOf(sim, a);
  if (waiting?.kind === "event") {
    if (waiting.task) waiting.task = mask(waiting.task);
  }
  const st = sim.engine;
  return {
    id: sim.id,
    automationId: a.id,
    automationCode: a.code,
    automationName: a.name,
    version: sim.version,
    draft: sim.draft,
    ownerId: sim.ownerId,
    event: copy(sim.event),
    status: st.status,
    error: st.error,
    cursor: st.cursor,
    now: st.now,
    log,
    vars: copy(st.vars),
    loops: copy(st.loops),
    current: current && { ...current, preview: current.preview && mask(current.preview) },
    waiting,
    preview: {
      tasks: sim.preview.tasks.map(mask),
      milestones: sim.preview.milestones.map(mask),
      requests: sim.preview.requests.map(mask),
      emails: sim.preview.emails.map(copy),
      notifications: sim.preview.notifications.map(mask),
      starts: sim.preview.starts.map(mask),
      claude: sim.preview.claude.map(copy),
    },
  };
}

// --- l'api --------------------------------------------------------------------------

/** La prova di chi agisce, con l'automazione vista dal proprietario che avrebbe. */
function mine(me: string, id: string): { sim: Sim; a: Automation } {
  const sim = sims.get(id);
  const a = sim ? automationById(sim.automationId) : undefined;
  if (!sim || sim.personId !== me || !a || !canSeeAutomation(me, a)) throw notFound();
  if (!canManageAutomation(me, a)) throw forbidden();
  return { sim, a: { ...a, ownerId: sim.ownerId } };
}

/**
 * Comincia la prova di una versione (`"draft"`: la bozza) su un evento
 * d'esempio. La prova si ferma subito sul primo passo che farebbe qualcosa.
 * Solo chi gestisce l'automazione; con errori di configurazione non parte
 * (`SimulationConfigError`). Il proprietario della prova è chi lo
 * diventerebbe: per una bozza chi prova (accenderla o pubblicarla lo fa
 * proprietario), per una versione pubblicata quello di adesso.
 */
export async function startSimulation(
  automationId: string,
  version: number | "draft",
  event: Record<string, unknown>,
): Promise<string> {
  const me = await writer("automations.startSimulation");
  const found = automationById(automationId);
  if (!found || !canSeeAutomation(me, found)) throw notFound();
  if (!canManageAutomation(me, found)) throw forbidden();
  const last = found.versions.at(-1)!;
  const v =
    version === "draft"
      ? last.publishedAt === null
        ? last
        : undefined
      : found.versions.find((x) => x.n === version);
  if (!v) throw invalid(version === "draft" ? "no_draft" : "version");
  if (event === null || typeof event !== "object" || Array.isArray(event)) throw invalid("event");
  const draft = v.publishedAt === null;
  const ownerId = draft ? me : (found.ownerId ?? me);
  const issues = configErrorsOf(found, v.flow, ownerId);
  if (issues.length > 0) throw new SimulationConfigError(issues);
  const a = { ...found, ownerId };
  const flow = copy(v.flow);
  const sim: Sim = {
    id: `sim-${++seq}`,
    personId: me,
    automationId: a.id,
    version: v.n,
    draft,
    ownerId,
    event: copy(event),
    engine: initialState(flow, now()),
    pending: null,
    log: [],
    milestoneRefs: new Map(),
    preview: {
      tasks: [],
      milestones: [],
      requests: [],
      emails: [],
      notifications: [],
      starts: [],
      claude: [],
    },
  };
  apply(sim, a, advance(sim.engine, { kind: "start", event: copy(event) }));
  sims.set(sim.id, sim);
  return sim.id;
}

/**
 * Fa avanzare la prova: `next` esegue per finta l'effetto in sospeso, `run`
 * va fino alla prossima fermata (attesa, approvazione, progetto, fine,
 * errore); gli input del motore sbloccano le fermate (`approved`/`rejected`
 * a nome di chi prova, `event` con la risposta scritta, `time` per
 * «Avanti», `project_chosen`). Restituisce la prova aggiornata.
 */
export async function simulationStep(id: string, input: SimulationInput): Promise<SimulationView> {
  const me = await writer("automations.simulationStep");
  const { sim, a } = mine(me, id);
  handle(me, sim, a, input);
  return view(me, sim, a);
}

/** La prova; `null` se non c'è (buttata, di un'altra persona, o di un'automazione che non gestisco). */
export async function getSimulation(id: string): Promise<SimulationView | null> {
  const me = await gate("automations.getSimulation");
  try {
    const { sim, a } = mine(me, id);
    return view(me, sim, a);
  } catch {
    return null;
  }
}

/** Butta la prova: non lascia traccia. */
export async function endSimulation(id: string): Promise<void> {
  const me = await writer("automations.endSimulation");
  mine(me, id);
  sims.delete(id);
}
