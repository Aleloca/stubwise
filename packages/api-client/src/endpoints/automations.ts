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
  AutomationSourceEvent,
  AutomationSourceView,
  ClientLinkView,
  ClientSuggestion,
  FieldType,
  FlowIssue,
  WebhookExamplePreview,
  WebhookSourceCreated,
  AutomationTestClaudeResult,
  AutomationTestEstimate,
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
  /** Area 7, F4: solo le generali (a chi ha `automations.general.manage`; agli altri l'elenco è vuoto). */
  general?: boolean;
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
  /** `none`: righe senza registro (`log: []`), per un elenco letto spesso; il registro lo dà `run`. */
  log?: "none";
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
      return request("GET", `/api/automations${toQuery({ project: opts.project, general: opts.general ? "true" : undefined, status: opts.status, owner: opts.owner, mine: opts.mine ? "true" : undefined })}`);
    },
    get(code: string): Promise<AutomationDetail> {
      return request("GET", base(code));
    },
    /** `projectId: null` (F4): una generale, con `automations.general.manage` d'istanza (403 senza). */
    create(input: { name: string; projectId: string | null; description?: string; flow?: AutomationFlow }): Promise<Automation> {
      return request("POST", "/api/automations", input);
    },
    saveDraft(code: string, input: { flow: AutomationFlow; expectedRev: number | null } & AutomationMeta): Promise<Automation> {
      return request("PUT", `${base(code)}/draft`, input);
    },
    /**
     * Nome, descrizione e (F4-2 = c) il tetto del webhook: `webhookPerMinute`
     * e `webhookPerDay`, null = il default; oltre il massimo d'istanza si salva
     * ma vale il massimo (`webhookLimits.effective` lo dice).
     */
    patch(code: string, meta: AutomationMeta & { webhookPerMinute?: number | null; webhookPerDay?: number | null }): Promise<Automation> {
      return request("PATCH", base(code), meta);
    },
    /** `mailboxAccountId` (area 7, F2): la casella da cui partono le email; serve solo se il flusso ne manda. */
    publish(code: string, opts: { expectedRev?: number | null; mailboxAccountId?: string } = {}): Promise<Automation> {
      return request("POST", `${base(code)}/publish`, opts);
    },
    activate(code: string, opts: { expectedRev?: number | null; mailboxAccountId?: string } = {}): Promise<Automation> {
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
      return request("GET", `/api/automation-runs${toQuery({ automation: opts.automation, project: opts.project, status: opts.status, cursor: opts.cursor, log: opts.log })}`);
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
    /** `remember` (F4): anche nella tabella cliente → progetto; solo con `permissions.rememberClient` (403 senza). */
    chooseProject(code: string, n: number, body: AutomationDecisionBody & { projectId: string; remember?: boolean }): Promise<void> {
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
    /** Area 7, F3: la stima gratuita di una prova con passi di Claude (l'evento dell'esempio scelto). */
    testEstimate(code: string, input: { version: number | "draft"; event: Record<string, unknown> }): Promise<AutomationTestEstimate> {
      return request("POST", `${base(code)}/test/estimate`, input);
    },
    /** Area 7, F3: un passo di Claude della prova, sul server (409 `budget`, 422 `claude_invalid`). */
    testClaude(code: string, input: { version: number | "draft"; rev?: number | null; path: string; vars: Record<string, unknown> }): Promise<AutomationTestClaudeResult> {
      return request("POST", `${base(code)}/test/claude`, input);
    },
    myRuns(opts: { log?: "none" } = {}): Promise<{ items: MyAutomationRun[] }> {
      return request("GET", `/api/me/automation-runs${toQuery({ log: opts.log })}`);
    },
  };
}

/**
 * Le sorgenti delle automazioni (area 7, F4): per ora solo il webhook in
 * arrivo. Scrivere vuole `integrations.manage`; l'indirizzo intero (col
 * segreto) esce SOLO da `createWebhook` e `regenerate`; gli eventi recenti
 * solo a `integrations.manage` (403 agli altri).
 */
export function createAutomationSourceEndpoints(request: ApiRequest) {
  const base = (id: string) => `/api/automation-sources/${seg(id)}`;
  return {
    list(): Promise<{ items: AutomationSourceView[] }> {
      return request("GET", "/api/automation-sources");
    },
    createWebhook(input: { name: string }): Promise<WebhookSourceCreated> {
      return request("POST", "/api/automation-sources", input);
    },
    rename(id: string, input: { name: string }): Promise<AutomationSourceView> {
      return request("PATCH", base(id), input);
    },
    /** «Generate a new address»: il vecchio smette subito di funzionare. */
    regenerate(id: string): Promise<WebhookSourceCreated> {
      return request("POST", `${base(id)}/regenerate`);
    },
    previewExample(id: string, json: string): Promise<WebhookExamplePreview> {
      return request("POST", `${base(id)}/example/preview`, { json });
    },
    setExample(id: string, json: string): Promise<AutomationSourceView> {
      return request("PUT", `${base(id)}/example`, { json });
    },
    /** L'etichetta e il tipo di un campo (anche dentro un elenco: `prodotti.nome`). */
    updateField(id: string, key: string, patch: { label?: string; type?: FieldType }): Promise<AutomationSourceView> {
      return request("PATCH", `${base(id)}/fields/${seg(key)}`, patch);
    },
    events(id: string): Promise<{ items: AutomationSourceEvent[] }> {
      return request("GET", `${base(id)}/events`);
    },
  };
}

/**
 * La tabella cliente → progetto (area 7, F4). La chiave la normalizza il
 * server (`clientKeyOf`: trim + minuscole); un progetto che chi legge non
 * vede arriva senza id (`projectVisible: false`). Scrivere e i suggerimenti
 * vogliono `integrations.manage`.
 */
export function createClientLinkEndpoints(request: ApiRequest) {
  return {
    list(): Promise<{ items: ClientLinkView[] }> {
      return request("GET", "/api/client-links");
    },
    suggestions(): Promise<{ items: ClientSuggestion[] }> {
      return request("GET", "/api/client-links/suggestions");
    },
    put(clientKey: string, input: { clientName: string; projectId: string }): Promise<ClientLinkView> {
      return request("PUT", `/api/client-links/${seg(clientKey)}`, input);
    },
    remove(clientKey: string): Promise<void> {
      return request("DELETE", `/api/client-links/${seg(clientKey)}`);
    },
  };
}
