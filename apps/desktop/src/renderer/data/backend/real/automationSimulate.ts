import { ApiError } from "@stubwise/api-client";
import {
  clientKeyOf,
  planEmail,
  planStartAutomation,
  PROJECT_NOT_FOUND,
  sameConversation,
  truncationNote,
} from "@stubwise/shared";
import type {
  Automation,
  SimulationClientProject,
  SimulationContext,
  SimulationExample,
  SimulationExamplesView,
  SimulationView,
} from "@stubwise/shared";
import type { ClaudeResult } from "@stubwise/shared";
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
  /**
   * F4 (46, R5 = a): il progetto in cui il cliente dell'esempio porterebbe il
   * passo, risolto dal server per il proprietario con la regola del worker —
   * mai la tabella. Assente (un server di prima): non disponibile.
   */
  clientProject?(
    automationId: string,
    version: number | "draft",
    client: string,
  ): Promise<SimulationClientProject>;
  /**
   * F3: i passi di Claude della prova passano dal server (il client non chiama
   * mai il modello). Assente (un server della F2): Claude non è disponibile.
   */
  claude?: {
    /** Gratuita: il prompt vero sull'evento dell'esempio. `estimateUsd` null = modello senza tariffa. */
    estimate(
      automationId: string,
      version: number | "draft",
      event: Record<string, unknown>,
    ): Promise<{
      claudeSteps: number;
      estimateUsd: number | null;
      model: string;
      upperBound?: boolean;
    }>;
    /** La risposta di Claude per il passo; `truncated`: gli input tagliati a 20 000 caratteri. */
    run(
      automationId: string,
      /** `rev`: la revisione provata; cambiata, il server risponde 409 `stale`. */
      body: { version: number; rev: number | null; path: string; vars: Record<string, unknown> },
    ): Promise<ClaudeResult & { truncated?: string[] }>;
  };
}

/**
 * La risposta di Claude non si è potuta leggere (non JSON, 422 con `raw`): il
 * passo fallisce `claude_invalid`, come nell'esecuzione vera, e non si richiama.
 */
export class ClaudeAnswerUnreadable extends Error {
  constructor() {
    super("claude_invalid");
  }
}

/** Il codice di un errore delle rotte di Claude, per le parole della pagina. */
const codeOf = (failure: unknown) =>
  failure instanceof Error ? failure.message.replace(/^invalid: /, "") : "other";

/** Un passo di Claude di cui la prova non ha ancora la risposta del server. */
class ClaudePending extends Error {
  constructor(readonly key: string) {
    super("claude_pending");
  }
}

/** Il cliente più lungo che `…/test/client-project` accetta. */
const CLIENT_MAX = 200;

/** Un cliente di cui la prova non ha ancora la risoluzione del server (F4). */
class ClientPending extends Error {
  constructor(
    readonly client: string,
    readonly key: string,
  ) {
    super("client_pending");
  }
}

/** Il passo nella prova (col suo giro) e i suoi dati: ogni giro chiede la sua risposta. */
const answerKey = (path: string, vars: Record<string, unknown>) =>
  `${path}:${JSON.stringify(vars)}`;

const notFound = () => new ApiError(404, "not_found", "not_found");

/** Il mondo della prova dai fatti del server. Ogni lettura è sul contesto, sincrona. */
export function contextWorld(
  ctx: SimulationContext,
  now: () => string,
  /** F3: le risposte di Claude già avute dal server; senza, Claude non c'è. */
  answers?: Map<string, ClaudeResult>,
  /**
   * F4: le risoluzioni «cliente → progetto» già avute (per `clientKeyOf`);
   * senza, il progetto dal cliente non c'è. Il progetto e le persone che
   * portano entrano nei fatti della prova come quelli del contesto.
   */
  clients?: Map<string, SimulationClientProject>,
): SimWorld {
  const ctxPeople = new Map(ctx.people.map((p) => [p.id, p]));
  const ctxProjects = new Map(ctx.projects.map((p) => [p.id, p]));
  const resolved = () => [...(clients?.values() ?? [])];
  const people = {
    get: (id: string) =>
      ctxPeople.get(id) ??
      resolved()
        .flatMap((c) => c.people)
        .find((p) => p.id === id),
  };
  const projects = {
    get: (id: string) =>
      ctxProjects.get(id) ?? resolved().find((c) => c.project?.id === id)?.project ?? undefined,
    all: () => [
      ...ctx.projects,
      ...resolved().flatMap((c) =>
        c.project && !ctxProjects.has(c.project.id) ? [c.project] : [],
      ),
    ],
  };
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
      new Set(
        projects
          .all()
          .filter((p) => sees(personId, p.id))
          .map((p) => p.id),
      ),
    // Questa, e (F4) quelle che «avvia un'altra» nomina e che chi prova vede (il codice c'è).
    canSeeAutomation: (_personId, automationId) =>
      automationId === ctx.automation.id ||
      (ctx.automations?.some((x) => x.id === automationId && x.code !== "") ?? false),
    // Gli errori li calcola il server per questa versione e questo proprietario.
    configErrors: () => ctx.configErrors,
    // F2 (R5): l'email, coi controlli del motore condiviso e la casella che
    // il server ha risolto per il proprietario (`ownerMailbox`; assente = nessuna).
    outside: {
      // F4 (R5 = a): il progetto del cliente risolto dal server, o «in attesa».
      ...(clients
        ? {
            resolveProject(eff: { clientKey: string }) {
              const key = clientKeyOf(eff.clientKey);
              const r = key ? clients.get(key) : { project: null, people: [] };
              if (!r) throw new ClientPending(eff.clientKey, key);
              if (!r.project)
                return {
                  input: { kind: "effect_result" as const, ok: false, error: PROJECT_NOT_FOUND },
                };
              return {
                input: { kind: "project_chosen" as const, projectId: r.project.id },
                projectId: r.project.id,
              };
            },
          }
        : {}),
      // F4: «avvia un'altra» con le regole dell'esecutore; nella prova la catena è solo questa.
      ...(ctx.automations
        ? {
            previewStart(
              sim: { ownerId: string },
              a: Automation,
              eff: { args: unknown },
              where: { stepId: string; path: string },
            ) {
              const id = (eff.args as { automationId?: string }).automationId;
              const target = ctx.automations?.find((x) => x.id === id) ?? null;
              const p = planStartAutomation(target, people.get(sim.ownerId)?.name ?? "", [a.id]);
              if (!p.ok) return p;
              return {
                ok: true as const,
                preview: {
                  kind: "start" as const,
                  ...where,
                  automationId: p.plan.id,
                  code: target?.code ?? "",
                  name: target?.name ?? "",
                },
              };
            },
          }
        : {}),
      // F3: la risposta del server per questo passo e queste variabili, o «in attesa».
      ...(answers
        ? {
            claude(
              step: { id: string; inputs: string[] },
              vars: Record<string, unknown>,
              _ownerId: string,
              path: string,
            ) {
              const key = answerKey(path, vars);
              const r = answers.get(key);
              if (!r) throw new ClaudePending(key);
              // L'input del motore: la risposta (già verificata dal server, e di
              // nuovo dal motore) e i dati che il passo ha letto.
              return { kind: "claude_result" as const, ...r, read: [...step.inputs] };
            },
          }
        : {}),
      previewEmail(sim, _a, eff, where) {
        const p = planEmail(
          { ...world, ownerMailbox: () => ctx.ownerMailbox ?? { ok: false, reason: "none" } },
          eff,
          sim.ownerId,
          sim.preview.emails.length,
          // La casella scelta vale per il proprietario di adesso (come il prototipo):
          // nomina quella che non c'è più; la risoluzione l'ha già fatta il server.
          sim.ownerId === ctx.automation.ownerId ? (ctx.automation.mailbox ?? null) : null,
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
  version: number | "draft";
  /** F3: le risposte di Claude, il costo stimato e se chi prova l'ha confermato (una volta). */
  answers: Map<string, ClaudeResult>;
  /** F4: le risoluzioni «cliente → progetto» chieste al server in questa prova. */
  clients: Map<string, SimulationClientProject>;
  event: Record<string, unknown>;
  cost: {
    claudeSteps: number;
    estimateUsd: number | null;
    model: string;
    upperBound?: boolean;
  } | null;
  confirmed: boolean;
  waitingCost: boolean;
  /** L'ultima interruzione per un errore di una rotta di Claude (vedi `SimulationView.interrupted`). */
  interrupted: string | null;
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

  const view = (t: Trial): SimulationView => ({
    ...t.run.view(api.me(), t.sim, t.a),
    costToConfirm: t.waitingCost ? t.cost : null,
    interrupted: t.interrupted,
  });

  /**
   * Un cliente che la prova non ha ancora risolto: lo chiede al server (una
   * GET, mai una scrittura) e lo ricorda. Un errore della rotta ferma la prova
   * qui, coi passi già fatti, come per Claude.
   */
  async function resolveClient(t: Trial, pending: ClientPending): Promise<boolean> {
    if (!api.clientProject) return false;
    // La rotta accetta al più 200 caratteri: troncare cambierebbe il cliente,
    // e «non trovato» potrebbe essere falso. La prova lo dice (review F4, m8).
    if (pending.client.length > CLIENT_MAX) {
      t.interrupted = "client_too_long";
      return false;
    }
    try {
      t.clients.set(
        pending.key,
        await api.clientProject(t.ctx.automation.id, t.version, pending.client),
      );
      return true;
    } catch (failure) {
      t.interrupted = codeOf(failure);
      return false;
    }
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
      const answers = new Map<string, ClaudeResult>();
      const clients = new Map<string, SimulationClientProject>();
      const run = createSimulator(
        contextWorld(
          ctx,
          () => api.now(),
          api.claude ? answers : undefined,
          api.clientProject ? clients : undefined,
        ),
      );
      let held: Trial | undefined;
      const hold = (sim: Trial["sim"]) => {
        held = {
          sim,
          ctx,
          run,
          a: { ...ctx.automation, ownerId: ctx.ownerId },
          version,
          answers,
          clients,
          event,
          cost: null,
          confirmed: false,
          waitingCost: false,
          interrupted: null,
        };
      };
      try {
        run.start(me, `sim-${++seq}`, ctx.automation, v, event, ctx.ownerId, hold);
      } catch (error) {
        // Il cliente dell'inizio non è ancora risolto: lo si chiede, poi si riprende.
        if (!(error instanceof ClientPending) || !held) throw error;
        let pending: ClientPending | null = error;
        while (pending && (await resolveClient(held, pending))) {
          try {
            run.handle(me, held.sim, held.a, { kind: "next" });
            pending = null;
          } catch (again) {
            if (!(again instanceof ClientPending)) throw again;
            pending = again;
          }
        }
      }
      const t = held!;
      trials.set(t.sim.id, t);
      // Un flusso che con questo esempio non fa niente finisce già qui: è finito bene.
      await markIfDone(t, false);
      return t.sim.id;
    },

    async simulationStep(id: string, input: SimulationInput): Promise<SimulationView> {
      const t = mine(id);
      t.interrupted = null;
      const wasDone = t.sim.engine.status === "done";
      for (;;) {
        try {
          t.run.handle(api.me(), t.sim, t.a, input);
          break;
        } catch (error) {
          if (error instanceof ClientPending) {
            if (!(await resolveClient(t, error))) break;
            // L'input è già stato applicato: si riprende dall'effetto in sospeso
            // (con «run» si continua fino alla prossima fermata).
            if (input.kind !== "run") input = { kind: "next" };
            continue;
          }
          if (!(error instanceof ClaudePending) || !api.claude) throw error;
          // Il primo passo di Claude: il costo stimato, da confermare una volta (D4, F3-3 = a).
          if (!t.confirmed) {
            try {
              t.cost ??= await api.claude.estimate(t.ctx.automation.id, t.version, t.event);
            } catch (failure) {
              t.interrupted = codeOf(failure);
              break;
            }
            t.waitingCost = true;
            break;
          }
          const path = t.sim.pending?.path ?? "";
          const vars = t.sim.pending?.kind === "claude" ? t.sim.pending.vars : {};
          let reply: Awaited<ReturnType<NonNullable<SimulationApi["claude"]>["run"]>>;
          try {
            reply = await api.claude.run(t.ctx.automation.id, {
              version: t.ctx.version,
              rev: t.ctx.rev,
              path,
              vars,
            });
          } catch (failure) {
            if (failure instanceof ClaudeAnswerUnreadable) {
              t.run.failPending(
                t.sim,
                "claude_invalid",
                "La risposta di Claude non era leggibile.",
                {
                  code: "claudeInvalid",
                },
              );
              break;
            }
            // Il budget finito o un altro guasto della rotta: i passi già fatti (e
            // pagati) restano, la prova si ferma qui e la pagina lo dice.
            t.interrupted = codeOf(failure);
            break;
          }
          const { truncated = [], ...answer } = reply;
          // Come l'esecuzione vera, con la stessa funzione: gli input tagliati in testa alla motivazione.
          answer.reason = `${truncationNote(truncated)}${answer.reason}`;
          t.answers.set(error.key, answer);
        }
      }
      await markIfDone(t, wasDone);
      return view(t);
    },

    /** Chi prova conferma il costo stimato: vale per tutta la prova. */
    async confirmSimulationCost(id: string): Promise<SimulationView> {
      const t = mine(id);
      t.confirmed = true;
      t.waitingCost = false;
      return view(t);
    },

    async getSimulation(id: string): Promise<SimulationView | null> {
      const t = trials.get(id);
      if (!t || t.sim.personId !== api.me()) return null;
      return view(t);
    },

    async endSimulation(id: string): Promise<void> {
      mine(id);
      trials.delete(id);
    },

    /** Al cambio di sessione le prove si buttano. */
    /**
     * Dopo un salvataggio: il contesto letto era del flusso di prima, e una
     * prova aperta chiederebbe al server il passo NUOVO controllandolo col
     * vecchio (review F3, m5): si buttano tutte e due.
     */
    forgetContext(automationId: string): void {
      for (const k of [...contexts.keys()])
        if (k.startsWith(`${automationId}:`)) contexts.delete(k);
      for (const [id, t] of trials) if (t.ctx.automation.id === automationId) trials.delete(id);
    },

    reset(): void {
      trials.clear();
      contexts.clear();
    },
  };
}
