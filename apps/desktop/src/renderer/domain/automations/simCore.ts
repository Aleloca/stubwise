import {
  advance,
  describe,
  initialState,
  projectOf,
  show,
  stepAt,
  type ActionStep,
  type EffectRequest,
  type EngineInput,
  type EngineState,
  type EngineStep,
  type FlowIssue,
  type ResolvedTarget,
} from "@stubwise/shared";
import type {
  Automation,
  AutomationVersion,
  RunLogEntry,
  SimulationEffectPreview,
  SimulationEmailPreview,
  SimulationMilestonePreview,
  SimulationProject,
  SimulationTaskPreview,
  SimulationView,
  SimulationWaiting,
} from "../../data/types";
import {
  planMilestone,
  planNotify,
  planRequest,
  planTask,
  type ActionEffect,
  type EffectOutcome,
  type PlanWorld,
} from "./planCore";
import {
  approvalProjectOf,
  checkEdited,
  hideProject,
  NO_APPROVER_REASON,
  NO_APPROVER_WHY,
  passesStartFilter,
  startFilterChecks,
} from "./runRules";

// La prova di un'automazione (area 7, R3), senza lo store: lo STESSO motore
// delle esecuzioni (`advance`), con un esecutore finto che produce anteprime
// coi piani dell'esecutore vero (`planCore.ts`) e non scrive MAI. Il mondo
// arriva da fuori (`SimWorld`): nel prototipo dallo store
// (`data/automations/simulate.ts`), nella build app dal server. I passi fuori
// dalla fetta 1 (email, Claude, «avvia un'altra», il progetto del cliente)
// passano dagli agganci `outside`, che ha solo il prototipo: nella build app
// quei passi non si pubblicano né si provano (`not_available`).
//
// Le regole sono quelle di prima, spostate: la prova si ferma al primo passo
// che farebbe qualcosa, avanza con «Passo successivo» (`next`) o «Vai alla
// prossima fermata» (`run`), si sblocca con gli input del motore; approva
// chi prova, a nome suo; R-J11 (`no_approver`) come nell'esecuzione vera;
// R-G5 nella vista (progetti e automazioni che chi guarda non vede).

export const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** Un'anteprima, o il fallimento con cui l'esecuzione vera si fermerebbe. */
export type Previewed =
  | {
      ok: true;
      preview: SimulationEffectPreview;
      /** Gli altri avvisi dello stesso passo («Avvisa» un reparto, area 10b). */
      more?: SimulationEffectPreview[];
      reason?: string;
    }
  | { ok: false; outcome: EffectOutcome };

export interface Sim {
  id: string;
  personId: string;
  automationId: string;
  version: number;
  /** La revisione provata (R-J19): se la prova finisce bene e la versione è ancora questa, è provata. */
  rev: number | null;
  draft: boolean;
  ownerId: string;
  event: Record<string, unknown>;
  engine: EngineState;
  /** Gli elementi di ogni «Per ogni» visto (il motore li toglie a giri finiti). */
  loopItems: Record<string, unknown[]>;
  /** L'effetto chiesto dal motore, che «Passo successivo» farebbe. */
  pending: EffectRequest | null;
  log: RunLogEntry[];
  /** I riferimenti interni dati al motore per i traguardi (`milestoneRef`): mai mostrati. */
  milestoneRefs: Map<string, SimulationMilestonePreview>;
  preview: SimulationView["preview"];
  /** D3 (area 10b): il filtro dell'inizio esclude l'esempio, la prova è finita senza partire. */
  filteredOut?: boolean;
  filterChecks?: SimulationView["filterChecks"];
  /** Area 10b (D2): l'esempio l'ha scelto o scritto Claude (`trialAs`). */
  claudeExample?: SimulationView["claudeExample"];
}

/** Un input della prova: «Passo successivo», «Vai alla prossima fermata», o un input del motore. */
export type SimulationInput = EngineInput | { kind: "next" } | { kind: "run" };

/** La prova non parte: il flusso ha errori di configurazione (`issues` dice dove). */
export class SimulationConfigError extends Error {
  constructor(readonly issues: FlowIssue[]) {
    super("invalid: config");
  }
}

/** Il risultato di un passo di Claude, come lo produce il Claude finto del prototipo. */
export type ClaudeResult = EngineInput & {
  outcome?: string;
  fields?: Record<string, unknown>;
  reason: string;
  read: string[];
};

/** I fatti della prova: quelli dei piani, più progetti, automazioni e configurazione. */
export interface SimWorld extends PlanWorld {
  now(): string;
  project(id: string): { code: string; name: string } | undefined;
  visibleProjectIds(personId: string): ReadonlySet<string>;
  canSeeAutomation(personId: string, automationId: string): boolean;
  configErrors(a: Automation, flow: AutomationVersion["flow"], ownerId: string): FlowIssue[];
  /** Solo il prototipo: i passi fuori dalla fetta 1. */
  /** Ognuno c'è dove la build offre il suo passo (nella build app, dalla F2, l'email). */
  outside?: {
    claude?(step: Extract<EffectRequest, { kind: "claude" }>["step"], vars: Record<string, unknown>, ownerId: string): ClaudeResult;
    resolveProject?(eff: Extract<EffectRequest, { kind: "resolve_project" }>, ownerId: string): EffectOutcome;
    previewEmail?(sim: Sim, a: Automation, eff: ActionEffect, where: { stepId: string; path: string }): Previewed;
    previewStart?(sim: Sim, a: Automation, eff: ActionEffect, where: { stepId: string; path: string }): Previewed;
  };
}

const copy = <T>(x: T): T => structuredClone(x);
const invalid = (what: string) => new Error(`invalid: ${what}`);

export function createSimulator(w: SimWorld) {
  /** Un progetto per un'anteprima (pieno: la vista lo nasconde a chi non lo vede). */
  const projectRef = (id: string): SimulationProject => {
    const p = w.project(id);
    return { id, code: p?.code ?? "", name: p?.name ?? "" };
  };

  /** Chi può approvare adesso (R-J8): la regola delle esecuzioni, col mondo della prova. */
  function approversFor(
    a: Automation,
    who: Extract<Extract<ActionStep, { approval: unknown }>["approval"], { mode: "ask" }>["who"],
    projectId: string | null,
  ): string[] {
    let ids: string[];
    if ("owner" in who) ids = a.ownerId ? [a.ownerId] : [];
    else if ("personId" in who) ids = who.personId ? [who.personId] : [];
    else ids = projectId ? w.holdersOfRole(projectId, who.projectRole) : [];
    return ids.filter(
      (id) => !w.isDeactivated(id) && (projectId === null || w.canSeeProject(id, projectId)),
    );
  }

  function previewOf(sim: Sim, a: Automation, eff: ActionEffect, at: string): Previewed {
    const owner = sim.ownerId;
    const where = { stepId: eff.stepId, path: eff.path };
    const dueInDays = (eff.args as { dueInDays?: number | null }).dueInDays ?? null;
    switch (eff.kind) {
      case "createTask": {
        const p = planTask(w, eff, a, owner, at);
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
            warning: plan.assignee.why ?? null,
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
        const p = planMilestone(w, eff, a, owner, at);
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
        const p = planRequest(w, eff, a, owner);
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
      case "notify": {
        const p = planNotify(w, eff, a, owner);
        if (!p.ok) return p;
        // Un reparto: un'anteprima per persona, allo stesso percorso (la vera ne fa una ciascuno).
        const [first, ...more] = p.plan.personIds.map((personId) => ({
          kind: "notification" as const,
          ...where,
          personId,
          text: p.plan.text,
          project: p.plan.projectId ? projectRef(p.plan.projectId) : null,
        }));
        return { ok: true, preview: first!, ...(more.length > 0 ? { more } : {}) };
      }
      case "sendEmail":
        return outsideOf("previewEmail", "sendEmail")(sim, a, eff, where);
      case "startAutomation":
        return outsideOf("previewStart", "startAutomation")(sim, a, eff, where);
    }
    throw invalid("step");
  }

  /** Un passo fuori dalla fetta 1: c'è solo dove il mondo lo offre (il prototipo). */
  function outsideOf<K extends keyof NonNullable<SimWorld["outside"]>>(
    hook: K,
    kind: string,
  ): NonNullable<NonNullable<SimWorld["outside"]>[K]> {
    const fn = w.outside?.[hook];
    if (!fn) throw invalid(`not_available: ${kind}`);
    return fn as NonNullable<NonNullable<SimWorld["outside"]>[K]>;
  }

  /** Esegue un effetto per finta: un'anteprima al posto della scrittura, e l'input per il motore. */
  function execute(sim: Sim, a: Automation, eff: EffectRequest): EngineInput {
    if (eff.kind === "claude") {
      const r = outsideOf("claude", "claude")(eff.step, eff.vars, sim.ownerId);
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
    if (eff.kind === "resolve_project") return outsideOf("resolveProject", "resolve_project")(eff, sim.ownerId).input;
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
    else if (kind === "notification") {
      for (const x of [r.preview, ...(r.more ?? [])]) {
        const one: Partial<typeof x> = { ...x };
        delete one.kind;
        sim.preview.notifications.push(one as SimulationView["preview"]["notifications"][number]);
      }
    } else sim.preview.starts.push(item as SimulationView["preview"]["starts"][number]);
    return {
      kind: "effect_result",
      ok: true,
      codes: [ref],
      ...(r.reason ? { reason: r.reason } : {}),
    };
  }

  /** Nel registro della prova nessun codice: non nasce niente. */
  const blank = (row: EngineStep["log"][number]) =>
    row.effects.map((x) => ({ kind: x.kind, code: "" }));

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
    for (const [path, items] of Object.entries(r.state.loops)) sim.loopItems[path] = copy(items);
    sim.pending = r.effects[0] ?? (stillAwaited ? sim.pending : null);
    if (sim.pending?.kind === "resolve_project") {
      const eff = sim.pending;
      sim.pending = null;
      return apply(sim, a, advance(sim.engine, outsideOf("resolveProject", "resolve_project")(eff, sim.ownerId).input));
    }
    failIfNoApprover(sim, a);
  }

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
      why: NO_APPROVER_WHY,
      byId: null,
      effects: [],
      outcome: "failed",
    });
    sim.engine = { ...st, status: "failed", error: "no_approver", awaiting: null, waitingUntil: null };
  }

  /** «Passo successivo»: l'effetto in sospeso, eseguito per finta. */
  function stepOnce(sim: Sim, a: Automation): void {
    if (TERMINAL.has(sim.engine.status)) throw invalid("finished");
    // Ferma (attesa, approvazione, progetto): il motore non chiede effetti.
    const eff = sim.pending;
    if (!eff) throw invalid("stopped");
    // Prima l'esecuzione, poi via dal sospeso: un aggancio che non ha ancora
    // la risposta (Claude nella build app, F3) lascia l'effetto dov'era.
    const input = execute(sim, a, eff);
    sim.pending = null;
    apply(sim, a, advance(sim.engine, input));
  }

  /** I progetti che si possono scegliere: quelli che vedono il proprietario e chi prova (R-G5). */
  function projectChoices(me: string, ownerId: string): SimulationProject[] {
    const mine = w.visibleProjectIds(me);
    return [...w.visibleProjectIds(ownerId)]
      .filter((id) => mine.has(id) && w.project(id) !== undefined)
      .map(projectRef)
      .sort((x, y) => x.code.localeCompare(y.code));
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
        if (!projectChoices(me, sim.ownerId).some((p) => p.id === input.projectId))
          throw new Error("not_found");
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

  /**
   * Comincia la prova di una versione `v` di `found` su un evento d'esempio,
   * col proprietario che avrebbe (`ownerId`). Chi può provare (vede e
   * gestisce) lo controlla chi chiama. Con errori di configurazione non parte
   * (`SimulationConfigError`). La prova si ferma subito sul primo passo che
   * farebbe qualcosa.
   */
  function start(
    me: string,
    id: string,
    found: Automation,
    v: AutomationVersion,
    event: Record<string, unknown>,
    ownerId: string,
  ): Sim {
    if (event === null || typeof event !== "object" || Array.isArray(event)) throw invalid("event");
    const issues = w.configErrors(found, v.flow, ownerId);
    if (issues.length > 0) throw new SimulationConfigError(issues);
    const a = { ...found, ownerId };
    const flow = copy(v.flow);
    const sim: Sim = {
      id,
      personId: me,
      automationId: a.id,
      version: v.n,
      rev: v.rev ?? null,
      draft: v.publishedAt === null,
      ownerId,
      event: copy(event),
      engine: initialState(flow, w.now()),
      loopItems: {},
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
    // D3 (area 10b): il filtro dell'inizio vale anche nella prova. Un esempio che
    // non lo soddisfa non farebbe partire la vera: la prova finisce qui, senza
    // anteprime e senza contare come provata.
    const t = flow.trigger;
    if (!passesStartFilter(t, event)) {
      sim.engine = { ...sim.engine, status: "done" };
      sim.filteredOut = true;
      sim.filterChecks = startFilterChecks(t, event);
      return sim;
    }
    apply(sim, a, advance(sim.engine, { kind: "start", event: copy(event) }));
    return sim;
  }

  /** La prova è finita bene adesso (per R-J19: si segna provata la revisione). */
  const finishedWell = (sim: Sim): boolean => !sim.filteredOut && sim.engine.status === "done";

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
    const args = eff.args as { to?: unknown; subject?: unknown; body?: unknown; attachments?: unknown };
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
      const wait = step.for;
      const email =
        "replyTo" in wait
          ? sim.preview.emails.filter((e) => e.stepId === wait.replyTo).at(-1)
          : undefined;
      const task =
        "taskClosed" in wait
          ? sim.preview.tasks.filter((t) => t.stepId === wait.taskClosed).at(-1)
          : undefined;
      return {
        ...at,
        kind: "event",
        until: aw.until,
        wait: copy(wait),
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

  /** La prova come la vede chi guarda: R-G5 sui progetti e sulle automazioni. */
  function view(me: string, sim: Sim, a: Automation): SimulationView {
    const visible = w.visibleProjectIds(me);
    const HIDDEN: SimulationProject = { id: "", code: "", name: "" };
    const seesAutomation = (id: unknown) => typeof id === "string" && w.canSeeAutomation(me, id);
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
      ...(sim.filteredOut ? { filteredOut: true, filterChecks: copy(sim.filterChecks ?? []) } : {}),
      ...(sim.claudeExample ? { claudeExample: { ...sim.claudeExample } } : {}),
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

  return {
    start,
    handle,
    stepOnce,
    view,
    approversFor,
    previewOf,
    projectChoices,
    projectRef,
    finishedWell,
  };
}

export type Simulator = ReturnType<typeof createSimulator>;
