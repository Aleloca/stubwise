import { ApiError } from "@stubwise/api-client";
import { planEmail, sameConversation } from "@stubwise/shared";
import type {
  Automation,
  SimulationContext,
  SimulationExample,
  SimulationExamplesView,
  SimulationView,
} from "@stubwise/shared";
import {
  createSimulator,
  type Sim,
  type SimulationInput,
  type SimWorld,
} from "../../../domain/automations/simCore";

// La prova nella build app (area 7, F1, R3 — P1 = a): gira nel CLIENT, sullo
// stesso nucleo puro del prototipo (`domain/automations/simCore.ts`), coi
// fatti che il server risolve per chi prova (`GET …/examples`: persone, ruoli,
// reparti, permessi del proprietario, errori di configurazione). Non scrive
// niente per costruzione: il mondo non ha scritture, e l'unica chiamata oltre
// agli esempi è `POST …/tested` con la rev, a prova finita bene (R-J19).
// Le prove stanno in memoria; i passi fuori dalla fetta 1 non hanno agganci
// (`outside` assente) e il server li ha già dati come `not_available`.
//
// Non importa niente di `data/automations/*` né del seme
// (`scripts/check-no-seed.mjs`).

/** Le rotte che la prova usa (sul client vero: `client.automations`). */
export interface SimulationApi {
  /** Chi è dentro. */
  me(): string;
  now(): string;
  examples(automationId: string, version: number | "draft"): Promise<SimulationExamplesView>;
  markTested(automationId: string, body: { version: number; rev: number | null }): Promise<void>;
}

const notFound = () => new ApiError(404, "not_found", "not_found");

/** Il mondo della prova dai fatti del server. Ogni lettura è sul contesto, sincrona. */
export function contextWorld(ctx: SimulationContext, now: () => string): SimWorld {
  const people = new Map(ctx.people.map((p) => [p.id, p]));
  const projects = new Map(ctx.projects.map((p) => [p.id, p]));
  const sees = (personId: string, projectId: string) => {
    const p = projects.get(projectId);
    return !!p && !p.gone && p.seenBy.includes(personId);
  };
  const check = (
    owner: string,
    projectId: string,
    can: keyof SimulationContext["projects"][number]["ownerCan"],
  ) => {
    const p = projects.get(projectId);
    if (!p || p.gone) throw new Error("not_found");
    if (owner !== ctx.ownerId || !p.seenBy.includes(owner) || !p.ownerCan[can])
      throw new Error("forbidden");
  };
  // Le stesse parole del mondo del worker (`loadPlanWorld`): una prova non
  // passa dove l'esecuzione vera fallirebbe.
  const notBlank = (what: string, value: string) => {
    if (value.trim() === "") throw new Error(`${what} vuoto`);
  };
  const world: SimWorld = {
    person: (id) => people.get(id),
    isDeactivated: (id) => people.get(id)?.deactivated ?? false,
    holdersOfRole: (projectId, role) => projects.get(projectId)?.roleHolders[role] ?? [],
    departmentRecipients: (departmentId, projectId) =>
      projectId === null ? [] : (projects.get(projectId)?.departmentMembers[departmentId] ?? []),
    canSeeProject: sees,
    projectGone: (projectId) => projects.get(projectId)?.gone ?? true,
    checkNewTask: (owner, input) => {
      check(owner, input.projectId, "createTask");
      notBlank("titolo", input.title);
    },
    checkNewMilestone: (owner, projectId, input) => {
      check(owner, projectId, "createMilestone");
      notBlank("nome", input.name);
    },
    checkNewRequest: (owner, input) => {
      check(owner, input.projectId, "createRequest");
      notBlank("titolo", input.title);
    },
    defaultDepartmentOf: (id) => people.get(id)?.defaultDepartmentId ?? null,
    // I nomi che il progetto ha già (`milestoneNames`, assente da un server più vecchio).
    milestoneNameTaken: (projectId, name) =>
      projects.get(projectId)?.milestoneNames?.includes(name) ?? false,
    now,
    project: (id) => {
      const p = projects.get(id);
      return p && !p.gone ? { code: p.code, name: p.name } : undefined;
    },
    visibleProjectIds: (personId) =>
      new Set(ctx.projects.filter((p) => sees(personId, p.id)).map((p) => p.id)),
    // Nella fetta 1 nessun passo avvia un'altra automazione: si vede solo questa.
    canSeeAutomation: (_personId, automationId) => automationId === ctx.automation.id,
    // Gli errori li calcola il server per questa versione e questo proprietario.
    configErrors: () => ctx.configErrors,
    // F2 (R5): l'email, coi controlli del motore condiviso e la casella che
    // il server ha risolto per il proprietario (`ownerMailbox`; assente = nessuna).
    outside: {
      previewEmail(sim, _a, eff, where) {
        const p = planEmail(
          { ...world, ownerMailbox: () => ctx.ownerMailbox ?? { ok: false, reason: "none" } },
          eff,
          sim.ownerId,
          sim.preview.emails.length,
          null,
        );
        if (!p.ok) return p;
        const first = sameConversation(sim.preview.emails, p.plan.to);
        return {
          ok: true,
          preview: {
            kind: "email",
            ...where,
            from: p.plan.from,
            to: p.plan.to,
            subject: p.plan.subject,
            body: p.plan.body,
            attachments: [],
            sameConversationAs: first ? { stepId: first.stepId, path: first.path } : null,
          },
        };
      },
    },
  };
  return world;
}

interface Trial {
  sim: Sim;
  ctx: SimulationContext;
  run: ReturnType<typeof createSimulator>;
  a: Automation;
}

/** La prova sopra le rotte del server: la stessa API del prototipo (`data/automations/simulate.ts`). */
export function createRealSimulation(api: SimulationApi) {
  const trials = new Map<string, Trial>();
  /** L'ultimo contesto letto per (automazione, versione): gli esempi e l'inizio della prova lo condividono. */
  const contexts = new Map<string, SimulationContext>();
  let seq = 0;
  const key = (automationId: string, version: number | "draft") => `${automationId}:${version}`;

  async function load(automationId: string, version: number | "draft") {
    const view = await api.examples(automationId, version);
    contexts.set(key(automationId, version), view.context);
    return view;
  }

  function mine(id: string): Trial {
    const t = trials.get(id);
    if (!t || t.sim.personId !== api.me()) throw notFound();
    return t;
  }

  async function markIfDone(t: Trial, wasDone: boolean) {
    if (wasDone || !t.run.finishedWell(t.sim)) return;
    await api.markTested(t.ctx.automation.id, { version: t.ctx.version, rev: t.ctx.rev });
  }

  return {
    async listSimulationExamples(
      automationId: string,
      version: number | "draft",
    ): Promise<SimulationExample[]> {
      return (await load(automationId, version)).items;
    },

    async startSimulation(
      automationId: string,
      version: number | "draft",
      event: Record<string, unknown>,
    ): Promise<string> {
      const me = api.me();
      const ctx =
        contexts.get(key(automationId, version)) ?? (await load(automationId, version)).context;
      const v = ctx.automation.versions.find((x) => x.n === ctx.version);
      if (!v) throw notFound();
      const run = createSimulator(contextWorld(ctx, () => api.now()));
      const sim = run.start(me, `sim-${++seq}`, ctx.automation, v, event, ctx.ownerId);
      const t: Trial = { sim, ctx, run, a: { ...ctx.automation, ownerId: ctx.ownerId } };
      trials.set(sim.id, t);
      // Un flusso che con questo esempio non fa niente finisce già qui: è finito bene.
      await markIfDone(t, false);
      return sim.id;
    },

    async simulationStep(id: string, input: SimulationInput): Promise<SimulationView> {
      const t = mine(id);
      const wasDone = t.sim.engine.status === "done";
      t.run.handle(api.me(), t.sim, t.a, input);
      await markIfDone(t, wasDone);
      return t.run.view(api.me(), t.sim, t.a);
    },

    async getSimulation(id: string): Promise<SimulationView | null> {
      const t = trials.get(id);
      if (!t || t.sim.personId !== api.me()) return null;
      return t.run.view(api.me(), t.sim, t.a);
    },

    async endSimulation(id: string): Promise<void> {
      mine(id);
      trials.delete(id);
    },

    /** Al cambio di sessione le prove si buttano. */
    /** Dopo un salvataggio: il contesto letto era del flusso di prima. */
    forgetContext(automationId: string): void {
      for (const k of [...contexts.keys()]) if (k.startsWith(`${automationId}:`)) contexts.delete(k);
    },

    reset(): void {
      trials.clear();
      contexts.clear();
    },
  };
}
