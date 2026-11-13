import type {
  Automation,
  AutomationDetail,
  AutomationFlow,
  AutomationMeta,
  AutomationRow,
  AutomationRunDetail,
  AutomationRunRow,
  AutomationDecision,
  AutomationOrigin,
  FlowIssue,
  MyAutomationRun,
  ProjectAutomationsView,
  SimulationExamplesView,
  RunStatus,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/** I filtri dell'elenco delle automazioni. */
export interface AutomationListOptions {
  project?: string;
  status?: Automation["status"];
  owner?: string;
  mine?: boolean;
}

/** I filtri dell'elenco delle esecuzioni (la vista «Runs»). */
export interface AutomationRunListOptions {
  automation?: string;
  project?: string;
  status?: RunStatus;
  cursor?: string;
}

/** La decisione su un passo in attesa: vale solo per quel passo e quel giro (R-J8). */
export interface AutomationDecisionBody {
  expectedPath: string;
  expectedRound?: number;
}

/**
 * Le Automations di progetto (area 7, fetta 1). Le forme sono i tipi di
 * `@stubwise/shared/automations`, calcolati dal server (permessi, chi decide,
 * R-G5): il client li legge, non li deduce. Un'automazione di un progetto che
 * non si vede è 404, come una che non esiste; senza `automations.manage` 403.
 * Gli errori portano `code` (`stale` col `rev`, `config` con gli `issues`,
 * `permission`, `suspended`, `not_failed`, `finished`, `no_draft`,
 * `not_active`, `run_limit`). Le decisioni sulle esecuzioni (approva, rifiuta,
 * annulla…) entrano in coda e le applica il worker: la risposta è 204, e
 * l'esecuzione si rilegge.
 */
export function createAutomationEndpoints(request: ApiRequest) {
  const base = (code: string) => `/api/automations/${seg(code)}`;
  const run = (code: string, n: number) => `${base(code)}/runs/${n}`;
  return {
    list(opts: AutomationListOptions = {}): Promise<{ items: AutomationRow[] }> {
      return request("GET", `/api/automations${toQuery({ project: opts.project, status: opts.status, owner: opts.owner, mine: opts.mine ? "true" : undefined })}`);
    },
    get(code: string): Promise<AutomationDetail> {
      return request("GET", base(code));
    },
    create(input: { name: string; projectId: string; description?: string; flow?: AutomationFlow }): Promise<Automation> {
      return request("POST", "/api/automations", input);
    },
    saveDraft(code: string, input: { flow: AutomationFlow; expectedRev: number | null } & AutomationMeta): Promise<Automation> {
      return request("PUT", `${base(code)}/draft`, input);
    },
    patch(code: string, meta: AutomationMeta): Promise<Automation> {
      return request("PATCH", base(code), meta);
    },
    publish(code: string, opts: { expectedRev?: number | null } = {}): Promise<Automation> {
      return request("POST", `${base(code)}/publish`, opts);
    },
    activate(code: string, opts: { expectedRev?: number | null } = {}): Promise<Automation> {
      return request("POST", `${base(code)}/activate`, opts);
    },
    pause(code: string): Promise<Automation> {
      return request("POST", `${base(code)}/pause`);
    },
    duplicate(code: string, input: { name: string; version?: number }): Promise<Automation> {
      return request("POST", `${base(code)}/duplicate`, input);
    },
    deleteDraft(code: string, opts: { expectedRev?: number | null } = {}): Promise<void> {
      return request("DELETE", `${base(code)}/draft${toQuery({ expectedRev: opts.expectedRev ?? undefined })}`);
    },
    /** Gli errori di un flusso a schermo non ancora salvato (sola lettura). */
    check(code: string, flow: AutomationFlow): Promise<{ issues: FlowIssue[] }> {
      return request("POST", `${base(code)}/check`, { flow });
    },
    /** La prova: gli esempi veri e il contesto (chi gestisce l'automazione). */
    examples(code: string, version: number | "draft"): Promise<SimulationExamplesView> {
      return request("GET", `${base(code)}/examples${toQuery({ version })}`);
    },
    /** R-J19: la revisione provata fino in fondo (409 `stale` se è cambiata). */
    markTested(code: string, input: { version: number; rev: number | null }): Promise<void> {
      return request("POST", `${base(code)}/tested`, input);
    },
    /** «Avvia ora»: l'esecuzione nuova (la muove il worker). */
    startRun(code: string, input: { event?: Record<string, unknown> } = {}): Promise<AutomationRunDetail> {
      return request("POST", `${base(code)}/runs`, input);
    },
    runs(opts: AutomationRunListOptions = {}): Promise<{ items: AutomationRunRow[]; nextCursor: string | null }> {
      return request("GET", `/api/automation-runs${toQuery({ automation: opts.automation, project: opts.project, status: opts.status, cursor: opts.cursor })}`);
    },
    run(code: string, n: number): Promise<AutomationRunDetail> {
      return request("GET", run(code, n));
    },
    approve(code: string, n: number, body: AutomationDecisionBody & { edited?: Record<string, string> }): Promise<void> {
      return request("POST", `${run(code, n)}/approve`, body);
    },
    reject(code: string, n: number, body: AutomationDecisionBody): Promise<void> {
      return request("POST", `${run(code, n)}/reject`, body);
    },
    chooseProject(code: string, n: number, body: AutomationDecisionBody & { projectId: string }): Promise<void> {
      return request("POST", `${run(code, n)}/project`, body);
    },
    cancelRun(code: string, n: number): Promise<void> {
      return request("POST", `${run(code, n)}/cancel`);
    },
    retryStep(code: string, n: number): Promise<void> {
      return request("POST", `${run(code, n)}/retry`);
    },
    skipStep(code: string, n: number): Promise<void> {
      return request("POST", `${run(code, n)}/skip`);
    },
    /** «Da decidere»: le esecuzioni ferme che aspettano chi chiama, adesso. */
    myApprovals(): Promise<{ items: AutomationDecision[] }> {
      return request("GET", "/api/me/automation-approvals");
    },
    /** La sezione «Automations» di un progetto (404 se non lo si vede). */
    projectAutomations(projectId: string): Promise<ProjectAutomationsView> {
      return request("GET", `/api/projects/${seg(projectId)}/automations`);
    },
    /** «Created by automation …» su una task (codice) o un traguardo (id); 404 se non l'ha creata un'automazione. */
    origin(ref: { task: string } | { milestone: string }): Promise<AutomationOrigin> {
      const q = typeof ref === "object" && ref !== null && "task" in ref ? { task: ref.task } : { milestone: (ref as { milestone?: string } | null)?.milestone };
      return request("GET", `/api/automation-origin${toQuery(q)}`);
    },
    /** Il blocco Home: aspetta me, fallite che gestisco, mie non finite. */
    myRuns(): Promise<{ items: MyAutomationRun[] }> {
      return request("GET", "/api/me/automation-runs");
    },
  };
}
