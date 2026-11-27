import {
  aiProviderViewSchema,
  aiUsageSnapshotsSchema,
  automationSettingsSchema,
  defaultReviewerResponseSchema,
  gitAccountSchema,
  gitValidateResponseSchema,
  googleWorkspaceSchema,
  instanceSettingsViewSchema,
  instanceStatusSchema,
  usageSummarySchema,
  pluginRegistrySchema,
  pluginSchema,
} from "@stubwise/shared";
import type {
  AiProviderView,
  AiUsageSnapshot,
  AutomationSettings,
  CreateAiProviderInput,
  CreateGitAccountInput,
  CreatePluginInput,
  DefaultReviewerResponse,
  GitAccount,
  GoogleWorkspace,
  GoogleWorkspaceDraft,
  GoogleWorkspacePatch,
  InstanceSettingsView,
  InstanceStatus,
  UsageDimension,
  UsageRange,
  UsageSummary,
  Plugin,
  PluginRegistry,
  Reader,
  UpdateAiProviderInput,
  UpdateAutomationSettingsInput,
  UpdateGitAccountInput,
  UpdateInstanceSettingsInput,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * Area 9, F3, Task 8b: le pagine d'istanza della 9b nell'app nuova. I segreti
 * si MANDANO (creazione, sostituzione) ma non tornano mai: le risposte dicono
 * solo se ci sono (`secretSet`, `clientSecretSet`, `s3SecretKeySet`). Le
 * scritture che toccano un segreto chiedono la riconferma (403 `reauth_required`).
 */

/** Provider AI (`/api/ai-providers`, `ai_providers.manage`): la catena di failover. */
export function createAiProviderEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<AiProviderView>[]> {
      return request("GET", "/api/ai-providers", undefined, z.array(aiProviderViewSchema));
    },
    create(input: CreateAiProviderInput): Promise<Reader<AiProviderView>> {
      return request("POST", "/api/ai-providers", input, aiProviderViewSchema);
    },
    /** Nome, interruttore, posizione; `secret` = sostituisce la credenziale. */
    update(id: string, patch: UpdateAiProviderInput): Promise<Reader<AiProviderView>> {
      return request("PATCH", `/api/ai-providers/${seg(id)}`, patch, aiProviderViewSchema);
    },
    /** Il nuovo ordine: TUTTI gli id, nessun doppione. */
    reorder(orderedIds: string[]): Promise<Reader<AiProviderView>[]> {
      return request("POST", "/api/ai-providers/reorder", { orderedIds }, z.array(aiProviderViewSchema));
    },
    /** Chiede la prova della credenziale (la fa il worker; l'esito in `testStatus`). */
    test(id: string): Promise<Reader<AiProviderView>> {
      return request("POST", `/api/ai-providers/${seg(id)}/test`, undefined, aiProviderViewSchema);
    },
    remove(id: string): Promise<void> {
      return request("DELETE", `/api/ai-providers/${seg(id)}`);
    },
  };
}

/** Account git (`/api/git-accounts`, `git_accounts.manage`; l'elenco con `git_accounts.view`). */
export function createGitAccountEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<GitAccount>[]> {
      return request("GET", "/api/git-accounts", undefined, z.array(gitAccountSchema));
    },
    create(input: CreateGitAccountInput): Promise<Reader<GitAccount>> {
      return request("POST", "/api/git-accounts", input, gitAccountSchema);
    },
    /** Nome, workspace; `credentials` = sostituisce il token. */
    update(id: string, patch: UpdateGitAccountInput): Promise<Reader<GitAccount>> {
      return request("PATCH", `/api/git-accounts/${seg(id)}`, patch, gitAccountSchema);
    },
    validate(id: string) {
      return request("POST", `/api/git-accounts/${seg(id)}/validate`, undefined, gitValidateResponseSchema);
    },
    /**
     * Ritiro del web vecchio (la creazione di un repository): i repository che
     * l'account vede sulla piattaforma, i rami di uno, e la verifica che lo
     * raggiunga. Tutte con `git_accounts.manage`.
     */
    repositories(id: string) {
      return request(
        "GET",
        `/api/git-accounts/${seg(id)}/repositories`,
        undefined,
        z.array(z.object({ fullName: z.string(), name: z.string(), cloneUrl: z.string(), defaultBranch: z.string().nullable() })),
      );
    },
    branches(id: string, repo: string) {
      return request(
        "GET",
        `/api/git-accounts/${seg(id)}/branches?repo=${encodeURIComponent(repo)}`,
        undefined,
        z.object({ branches: z.array(z.string()), defaultBranch: z.string().nullable() }),
      );
    },
    validateRepo(id: string, repo: string) {
      return request("GET", `/api/git-accounts/${seg(id)}/validate-repo?repo=${encodeURIComponent(repo)}`, undefined, gitValidateResponseSchema);
    },
    setDefaultReviewer(id: string): Promise<Reader<DefaultReviewerResponse>> {
      return request("PUT", `/api/git-accounts/${seg(id)}/default-reviewer`, undefined, defaultReviewerResponseSchema);
    },
    unsetDefaultReviewer(id: string): Promise<void> {
      return request("DELETE", `/api/git-accounts/${seg(id)}/default-reviewer`);
    },
    /** 409 `git_account_in_use` se un repository lo usa. */
    remove(id: string): Promise<void> {
      return request("DELETE", `/api/git-accounts/${seg(id)}`);
    },
  };
}

/**
 * Plugin (`/api/plugins`, `plugins.manage`). Registrare e cambiare il ref
 * vogliono `trust: true` («Mi fido»: il codice gira subito, nello smoke run).
 */
export function createPluginEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<PluginRegistry>> {
      return request("GET", "/api/plugins", undefined, pluginRegistrySchema);
    },
    get(id: string): Promise<Reader<Plugin>> {
      return request("GET", `/api/plugins/${seg(id)}`, undefined, pluginSchema);
    },
    register(input: CreatePluginInput & { trust: true }): Promise<Reader<Plugin>> {
      return request("POST", "/api/plugins", input, pluginSchema);
    },
    updateRef(id: string, ref: string, trust: true) {
      return request("POST", `/api/plugins/${seg(id)}/update`, { ref, trust }, z.object({ queued: z.literal(true) }));
    },
    rerunSmoke(id: string) {
      return request("POST", `/api/plugins/${seg(id)}/smoke`, undefined, z.object({ queued: z.literal(true) }));
    },
    /** 409 `plugin_in_use` se è acceso in un progetto. */
    remove(id: string): Promise<void> {
      return request("DELETE", `/api/plugins/${seg(id)}`);
    },
  };
}

/** App Google (`/api/settings/google-workspaces`, `integrations.manage`). */
export function createGoogleAppEndpoints(request: ApiRequest) {
  return {
    /** Con `accountCount`: le caselle collegate (eliminare chiede che siano zero). */
    list(): Promise<Reader<GoogleWorkspace>[]> {
      return request("GET", "/api/settings/google-workspaces", undefined, z.array(googleWorkspaceSchema));
    },
    create(input: GoogleWorkspaceDraft): Promise<Reader<GoogleWorkspace>> {
      return request("POST", "/api/settings/google-workspaces", input, googleWorkspaceSchema);
    },
    /** Nome, domini, clientId; `clientSecret` = sostituisce il secret. */
    update(id: string, patch: GoogleWorkspacePatch): Promise<Reader<GoogleWorkspace>> {
      return request("PATCH", `/api/settings/google-workspaces/${seg(id)}`, patch, googleWorkspaceSchema);
    },
    /** 409 `workspace_in_use` con caselle collegate. */
    remove(id: string): Promise<void> {
      return request("DELETE", `/api/settings/google-workspaces/${seg(id)}`);
    },
  };
}

/** Lingua, budget e archiviazione (`/api/settings/instance`), automazione (`/api/settings/automation`). */
export function createInstanceSettingsEndpoints(request: ApiRequest) {
  return {
    get(): Promise<Reader<InstanceSettingsView>> {
      return request("GET", "/api/settings/instance", undefined, instanceSettingsViewSchema);
    },
    /**
     * Una PATCH: un campo assente resta com'è (`monthlyBudgetUsd: null`
     * esplicito toglie il tetto). I campi S3 presenti aggiornano;
     * `s3SecretKey` solo se cambia (chiede la riconferma).
     */
    save(input: UpdateInstanceSettingsInput): Promise<Reader<InstanceSettingsView>> {
      return request("PUT", "/api/settings/instance", input, instanceSettingsViewSchema);
    },
    automation(): Promise<Reader<AutomationSettings>> {
      return request("GET", "/api/settings/automation", undefined, automationSettingsSchema);
    },
    saveAutomation(input: UpdateAutomationSettingsInput): Promise<Reader<AutomationSettings>> {
      return request("PUT", "/api/settings/automation", input, automationSettingsSchema);
    },
  };
}

/**
 * La quota degli account (`GET /api/ai-usage/snapshots`, `usage.view`):
 * l'ultimo campione per provider. La BANDA (ok, near, limited) la calcola il
 * server e sta nella vista del provider (`quotaBand`), non qui.
 */
export function createAiUsageEndpoints(request: ApiRequest) {
  return {
    snapshots(): Promise<Reader<AiUsageSnapshot>[]> {
      return request("GET", "/api/ai-usage/snapshots", undefined, aiUsageSnapshotsSchema);
    },
  };
}

/**
 * Area 9, F4: lo Stato dell'istanza (`instance.status.view`). Tutto calcolato
 * dal server; `href` arriva null: il link lo compone la pagina da `kind`,
 * `projectCode` e `code`.
 */
export function createInstanceStatusEndpoints(request: ApiRequest) {
  return {
    status(): Promise<Reader<InstanceStatus>> {
      return request("GET", "/api/instance/status", undefined, instanceStatusSchema);
    },
    /**
     * Task 6: rimette in coda un job fallito di una task (`project.settings.manage`
     * + `runs.start`). 409 `conflict` (già ripartito o superato da lavoro vivo),
     * 422 `not_retryable` / `monthly_budget`. `stopsAtPlan`: Claude si fermerà al piano.
     */
    retryJob(jobId: string) {
      return request("POST", `/api/instance/jobs/${seg(jobId)}/retry`, undefined, z.object({ jobId: z.string(), status: z.string(), stopsAtPlan: z.boolean().default(false) }));
    },
  };
}

/**
 * Area 9, F4: AI → Usage (`usage.view`, o `project.usage.view` per i propri
 * progetti). Il raggruppamento, i giorni a zero e R-G5 li fa il server: la
 * riga `other` (progetti che chi guarda non vede) e `none` (righe senza
 * progetto o provider) hanno la chiave come etichetta, le parole le mette la UI.
 */
export function createUsageEndpoints(request: ApiRequest) {
  return {
    summary(input: { range: UsageRange; groupBy: UsageDimension; thenBy?: UsageDimension }): Promise<Reader<UsageSummary>> {
      const r = input.range;
      const range = "days" in r ? { days: String(r.days) } : "month" in r ? { month: "1" } : { from: r.from, to: r.to };
      return request("GET", `/api/ai-usage/summary${toQuery({ ...range, groupBy: input.groupBy, thenBy: input.thenBy })}`, undefined, usageSummarySchema);
    },
  };
}
