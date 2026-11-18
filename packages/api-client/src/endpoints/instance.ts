import {
  aiProviderViewSchema,
  aiUsageSnapshotsSchema,
  automationSettingsSchema,
  defaultReviewerResponseSchema,
  gitAccountSchema,
  gitValidateResponseSchema,
  googleWorkspaceSchema,
  instanceSettingsViewSchema,
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
import { seg } from "../query.js";

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
     * `contentLanguage` e `monthlyBudgetUsd` SEMPRE: il server tratta un budget
     * assente come «nessun budget» (e lo registra), quindi non è una patch. I
     * campi S3 presenti aggiornano; `s3SecretKey` solo se cambia.
     */
    save(input: UpdateInstanceSettingsInput & { monthlyBudgetUsd: number | null }): Promise<Reader<InstanceSettingsView>> {
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
