import type {
  Automation,
  AutomationDetail,
  AutomationFlow,
  AutomationMeta,
  AutomationOrigin,
  AutomationRow,
  AutomationRunRow,
  FlowIssue,
  ProjectAutomationsView,
  RunStatus,
} from "@stubwise/shared";
import type { AutomationRef } from "../../model";
import { createRealDecisions, type DecisionApi } from "./automationDecisions";
import {
  createAutomationRefs,
  inPrototypeWords,
  orNull,
  type AutomationRefs,
} from "./automationRefs";

// Il livello dati delle Automations nella build app (area 7, F1, R2): le
// funzioni del prototipo (`data/automations/index.ts`), con la loro firma,
// sopra le rotte vere. Le pagine vanno per id, le rotte per codice: codice e
// revisione li ricordano le letture (`automationRefs.ts`). Gli errori nelle
// parole del prototipo: `not_found`, `forbidden`, `invalid: <codice>` — un 409
// `stale` sulla bozza è `invalid: stale`, che il costruttore dice già
// («ricarica»; il testo a schermo resta, niente si butta).
//
// Fuori dalla fetta 1 (restano gli stub `notIntegrated`): sorgenti, webhook,
// tabella cliente, «Pass time», le funzioni di Claude (area 10b) e i
// modelli di «New automation» (P2 = a).

/** Le rotte (sul client vero: `client.automations`). */
export interface AutomationsApi extends DecisionApi {
  list(q: {
    project?: string;
    status?: Automation["status"];
    owner?: string;
  }): Promise<{ items: AutomationRow[] }>;
  get(code: string): Promise<AutomationDetail>;
  /** Gli errori di configurazione di un flusso non ancora salvato (non scrive). */
  check(code: string, body: { flow: AutomationFlow }): Promise<{ issues: FlowIssue[] }>;
  create(body: { name: string; projectId: string | null }): Promise<Automation>;
  saveDraft(
    code: string,
    body: { flow: AutomationFlow; expectedRev: number | null } & AutomationMeta,
  ): Promise<Automation>;
  patch(code: string, body: AutomationMeta): Promise<Automation>;
  publish(code: string, body: { expectedRev: number | null }): Promise<Automation>;
  activate(code: string, body: { expectedRev: number | null }): Promise<Automation>;
  pause(code: string): Promise<Automation>;
  duplicate(code: string, body: { version?: number; name: string }): Promise<Automation>;
  deleteDraft(code: string, body: { expectedRev: number | null }): Promise<void>;
  runs(q: {
    automation?: string;
    project?: string;
    status?: RunStatus;
  }): Promise<{ items: AutomationRunRow[] }>;
  startRun(code: string, body: { event?: Record<string, unknown> }): Promise<AutomationRunRow>;
  cancelRun(code: string, n: number): Promise<void>;
  retryStep(code: string, n: number): Promise<void>;
  skipStep(code: string, n: number): Promise<void>;
  chooseProject(
    code: string,
    n: number,
    body: { projectId: string; expectedPath: string; expectedRound: number },
  ): Promise<void>;
  projectAutomations(projectId: string): Promise<ProjectAutomationsView>;
  origin(q: { task: string } | { milestone: string }): Promise<AutomationOrigin>;
}

export function createRealAutomations(
  api: AutomationsApi,
  refs: AutomationRefs = createAutomationRefs(),
) {
  const decisions = createRealDecisions(api, refs);
  const code = (id: string) => refs.automation(id).code;
  /** Una scrittura che risponde con l'automazione: se ne ricorda la revisione nuova. */
  const written = async (call: () => Promise<Automation>): Promise<Automation> => {
    const a = await inPrototypeWords(call);
    refs.rememberAutomation(a);
    return a;
  };
  const onRun = async (runId: string, call: (code: string, n: number) => Promise<void>) => {
    const r = refs.run(runId);
    await inPrototypeWords(() => call(r.code, r.n));
  };

  return {
    ...decisions,

    async listAutomations(
      filter: { projectId?: string; status?: Automation["status"]; ownerId?: string } = {},
    ): Promise<AutomationRow[]> {
      const { items } = await inPrototypeWords(() =>
        api.list({ project: filter.projectId, status: filter.status, owner: filter.ownerId }),
      );
      for (const a of items) refs.rememberAutomation(a);
      return items;
    },

    async getAutomation(id: string): Promise<AutomationDetail | null> {
      if (!refs.knowsAutomation(id)) return null;
      const detail = await orNull(() => api.get(code(id)));
      if (detail) {
        refs.rememberAutomation(detail.automation);
        for (const r of detail.runs) refs.rememberRun(r);
      }
      return detail;
    },

    async checkDraft(id: string, flow: AutomationFlow): Promise<FlowIssue[]> {
      return (await inPrototypeWords(() => api.check(code(id), { flow }))).issues;
    },

    async createAutomation(input: {
      name: string;
      projectId: string | null;
      template?: string;
      language?: string;
    }): Promise<Automation> {
      // P2 = a: nella fetta 1 solo da zero.
      if (input.template) throw new Error("invalid: not_available");
      return written(() => api.create({ name: input.name, projectId: input.projectId }));
    },

    async saveDraft(
      id: string,
      flow: AutomationFlow,
      meta: AutomationMeta = {},
      opts: { expected?: number | null } = {},
    ): Promise<Automation> {
      const expectedRev = opts.expected !== undefined ? opts.expected : refs.automation(id).rev;
      return written(() => api.saveDraft(code(id), { flow, expectedRev, ...meta }));
    },

    renameAutomation: (id: string, meta: AutomationMeta) =>
      written(() => api.patch(code(id), meta)),
    publish: (id: string) =>
      written(() => api.publish(code(id), { expectedRev: refs.automation(id).rev })),
    activate: (id: string) =>
      written(() => api.activate(code(id), { expectedRev: refs.automation(id).rev })),
    pause: (id: string) => written(() => api.pause(code(id))),
    duplicateAutomation: (id: string, opts: { version?: number; name: string }) =>
      written(() => api.duplicate(code(id), opts)),

    async deleteDraft(id: string, opts: { expected?: number | null } = {}): Promise<void> {
      const expectedRev = opts.expected !== undefined ? opts.expected : refs.automation(id).rev;
      await inPrototypeWords(() => api.deleteDraft(code(id), { expectedRev }));
    },

    async listRuns(
      filter: { automationId?: string; projectId?: string; status?: RunStatus } = {},
    ): Promise<AutomationRunRow[]> {
      const { items } = await inPrototypeWords(() =>
        api.runs({
          automation: filter.automationId ? code(filter.automationId) : undefined,
          project: filter.projectId,
          status: filter.status,
        }),
      );
      for (const r of items) refs.rememberRun(r);
      return items;
    },

    async startManual(id: string, event?: Record<string, unknown>): Promise<string> {
      const run = await inPrototypeWords(() => api.startRun(code(id), event ? { event } : {}));
      refs.rememberRun(run);
      return run.id;
    },

    cancelRun: (runId: string) => onRun(runId, (c, n) => api.cancelRun(c, n)),
    retryStep: (runId: string) => onRun(runId, (c, n) => api.retryStep(c, n)),
    skipStep: (runId: string) => onRun(runId, (c, n) => api.skipStep(c, n)),

    async chooseProject(
      runId: string,
      projectId: string,
      opts: { remember?: boolean; expectedPath: string },
    ): Promise<void> {
      // `remember` (la tabella cliente → progetto) è della F4.
      const expectedRound = refs.roundFor(runId, opts.expectedPath);
      await onRun(runId, (c, n) =>
        api.chooseProject(c, n, { projectId, expectedPath: opts.expectedPath, expectedRound }),
      );
    },

    async getProjectAutomations(projectId: string): Promise<ProjectAutomationsView | null> {
      return orNull(() => api.projectAutomations(projectId));
    },

    async automationOrigin(
      _ref: AutomationRef,
      createdCode: string,
      kind: "task" | "milestone" = "task",
    ): Promise<AutomationOrigin> {
      // Derivata a lettura dal server (P5): l'automazione e l'esecuzione le sa lui.
      return inPrototypeWords(() =>
        api.origin(kind === "task" ? { task: createdCode } : { milestone: createdCode }),
      );
    },

    /** Al cambio di sessione i riferimenti si buttano. */
    reset: () => refs.clear(),
  };
}
