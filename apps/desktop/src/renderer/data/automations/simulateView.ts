import type { EngineInput, ResolvedTarget } from "../../domain/automations/engine";
import { stepAt } from "../../domain/automations/fields";
import { describe, projectOf, show, type ActionStep } from "../../domain/automations/preview";
import { copy, state, visibleProjectIds } from "../store";
import type { Automation, SimulationProject, SimulationView, SimulationWaiting } from "../types";
import type { ActionEffect } from "./plans";
import { hideProject } from "./reads";
import { previewOf, projectRef, TERMINAL, type Sim } from "./simulateExecute";
import { approvalProjectOf, approversFor, automationById, canSeeAutomation } from "./visibility";

// La vista della prova (vedi `simulate.ts`): cosa vede chi prova, coi
// progetti e i dati che non vede oscurati (R-G5).

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
  // Un'email che non partirebbe resta leggibile: chi prova vede cosa avrebbe
  // mandato, e «From» vuoto dice che manca la casella.
  const args = eff.args as {
    to?: unknown;
    subject?: unknown;
    body?: unknown;
    attachments?: unknown;
  };
  const email =
    eff.kind === "sendEmail"
      ? {
          kind: "email" as const,
          stepId: eff.stepId,
          path: eff.path,
          from: "",
          to: show(args.to),
          subject: show(args.subject),
          body: show(args.body),
          attachments: (Array.isArray(args.attachments) ? args.attachments : [])
            .map(show)
            .filter((x) => x !== ""),
          sameConversationAs: null,
        }
      : null;
  return {
    ...at,
    preview: email,
    failure: { error: out.error ?? "", reason: out.reason ?? null, why: out.why ?? null },
  };
}

/** I progetti fra cui si sceglie nella prova: del proprietario, che chi prova vede; per codice. */
export function projectChoices(me: string, ownerId: string): SimulationProject[] {
  const mine = visibleProjectIds(me);
  return [...visibleProjectIds(ownerId)]
    .filter((id) => mine.has(id) && state.projectsById.has(id))
    .map(projectRef)
    .sort((x, y) => x.code.localeCompare(y.code));
}

function waitingOf(me: string, sim: Sim, a: Automation): SimulationWaiting | null {
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
      choices: projectChoices(me, sim.ownerId),
    };
  }
  return null;
}

/** La prova come la vede chi prova: i progetti che non vede restano senza id né nome (R-G5). */
export function view(me: string, sim: Sim, a: Automation): SimulationView {
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
  const waiting = waitingOf(me, sim, a);
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
    loopItems: copy(sim.loopItems),
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
