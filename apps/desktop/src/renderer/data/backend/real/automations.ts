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
import { createRealDecisions, type SettleClock, type DecisionApi } from "./automationDecisions";
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
  check(code: string, flow: AutomationFlow): Promise<{ issues: FlowIssue[] }>;
  /** Solo di progetto nella fetta 1: le generali sono della F4. */
  create(body: { name: string; projectId: string }): Promise<Automation>;
  saveDraft(
    code: string,
    body: { flow: AutomationFlow; expectedRev: number | null } & AutomationMeta,
  ): Promise<Automation>;
  patch(code: string, body: AutomationMeta): Promise<Automation>;
  publish(
    code: string,
    body: { expectedRev: number | null; mailboxAccountId?: string },
  ): Promise<Automation>;
  activate(
    code: string,
    body: { expectedRev: number | null; mailboxAccountId?: string },
  ): Promise<Automation>;
  pause(code: string): Promise<Automation>;
  duplicate(code: string, body: { version?: number; name: string }): Promise<Automation>;
  deleteDraft(code: string, body: { expectedRev: number | null }): Promise<void>;
  runs(q: {
    automation?: string;
    project?: string;
    status?: RunStatus;
    log?: "none";
  }): Promise<{ items: AutomationRunRow[]; nextCursor?: string | null }>;
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
  clock?: SettleClock,
  /** Le caselle di chi accende (F2): la pagina sceglie per indirizzo, il server per id. */
  mailboxAccounts: () => Promise<readonly { id: string; email: string }[]> = async () => [],
) {
  const decisions = createRealDecisions(api, refs, clock);
  const code = (id: string) => refs.automation(id).code;
  /** Una scrittura che risponde con l'automazione: se ne ricorda la revisione nuova. */
  const written = async (call: () => Promise<Automation>): Promise<Automation> => {
    const a = await inPrototypeWords(call);
    refs.rememberAutomation(a);
    return a;
  };
  /** La casella scelta per indirizzo → il suo id; una che non è più mia è `mailbox_missing`. */
  const accountOf = async (mailbox: string | undefined) => {
    if (mailbox === undefined) return {};
    const found = (await mailboxAccounts()).find(
      (a) => a.email.toLowerCase() === mailbox.toLowerCase(),
    );
    if (!found) throw new Error("invalid: mailbox_missing");
    return { mailboxAccountId: found.id };
  };
  /** Accendere o pubblicare: `mailbox_required` del server è `mailbox_missing` del prototipo. */
  const turnedOn = async (call: () => Promise<Automation>) => {
    try {
      return await written(call);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid: mailbox_required")
        throw new Error("invalid: mailbox_missing");
      throw error;
    }
  };
  const onRun = async (runId: string, call: (code: string, n: number) => Promise<void>) => {
    const r = refs.run(runId);
    try {
      await inPrototypeWords(() => call(r.code, r.n));
    } catch (error) {
      // Già in coda un input di chi chiama (409 `pending`): aspetta il worker anche lui.
      if (error instanceof Error && error.message === "invalid: pending") decisions.markRun(runId);
      throw error;
    }
    decisions.markRun(runId);
  };

  return {
    ...decisions,

    async listAutomations(
      filter: { projectId?: string; status?: Automation["status"]; ownerId?: string } = {},
    ): Promise<AutomationRow[]> {
      // Un server senza le rotte dell'area 7 (404): nessuna automazione, lo stato vuoto.
      const { items } = (await orNull(() =>
        api.list({ project: filter.projectId, status: filter.status, owner: filter.ownerId }),
      )) ?? { items: [] };
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
      return (await inPrototypeWords(() => api.check(code(id), flow))).issues;
    },

    async createAutomation(input: {
      name: string;
      projectId: string | null;
      template?: string;
      language?: string;
    }): Promise<Automation> {
      // P2 = a: nella fetta 1 solo da zero.
      // Le automazioni generali sono della F4.
      if (input.template || input.projectId === null) throw new Error("invalid: not_available");
      const projectId = input.projectId;
      return written(() => api.create({ name: input.name, projectId }));
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
    publish: async (id: string, opts: { mailbox?: string } = {}) => {
      const mailboxAccountId = await accountOf(opts.mailbox);
      return turnedOn(() =>
        api.publish(code(id), { expectedRev: refs.automation(id).rev, ...mailboxAccountId }),
      );
    },
    activate: async (id: string, opts: { mailbox?: string } = {}) => {
      const mailboxAccountId = await accountOf(opts.mailbox);
      return turnedOn(() =>
        api.activate(code(id), { expectedRev: refs.automation(id).rev, ...mailboxAccountId }),
      );
    },
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
          // Le righe senza registro (lo legge il dettaglio): 50 esecuzioni rilette spesso.
          log: "none",
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
      const view = await orNull(() => api.projectAutomations(projectId));
      // Da qui si apre un'automazione o un'esecuzione senza essere passati dagli elenchi.
      for (const a of view?.automations ?? []) refs.rememberAutomation(a);
      for (const r of view?.runs ?? []) refs.rememberRun(r);
      return view;
    },

    async automationOrigin(
      _ref: AutomationRef,
      createdCode: string,
      kind: "task" | "milestone" = "task",
    ): Promise<AutomationOrigin> {
      // Derivata a lettura dal server (P5): l'automazione e l'esecuzione le sa lui.
      // 404 (l'oggetto non si vede più, o non l'ha creato un'automazione): la riga non dice niente.
      const origin = await orNull(() =>
        api.origin(kind === "task" ? { task: createdCode } : { milestone: createdCode }),
      );
      return origin ?? { visible: false };
    },

    /** Al cambio di sessione i riferimenti si buttano. */
    reset: () => refs.clear(),
  };
}
