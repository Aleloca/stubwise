import type { AiModelChoice, AiOperation } from "@stubwise/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import * as api from "../api";
import { useSessionPersonId, useWrite } from "../queries";

// Gli hook dell'istanza (area 9b); `data/queries` li ri-esporta. L'import
// circolare con `../queries` è innocuo: gli helper si usano solo dentro le
// funzioni. I Task 3–7 ci aggiungono i loro.

export type { UsageDimension, UsageRange, UsageRow, UsageView } from "../instance/usage";
export { OTHER_PROJECTS_KEY } from "../instance/usage";
export type {
  AutomationRule,
  AutomationSettings,
  BudgetSaveEffect,
  BudgetView,
  ContentLanguage,
  GitAccountView,
  GoogleAppView,
  InstanceResult,
  StorageStatus,
  StorageView,
  WebhookEventId,
  WebhookFormat,
  WebhookGroup,
  WebhookView,
  PluginView,
  ModelRow,
  ModelSource,
  ProviderView,
  QuotaView,
  TestOutcome,
} from "../instance";
export { BACKGROUND_WEEKLY_THRESHOLD } from "../instance/providers";
export { GOOGLE_SETUP } from "../instance/google";
export { WEBHOOK_EVENTS } from "../instance/webhook";

/** I consumi della scheda Usage (errore `forbidden` senza `usage.view`). */
export function useUsage(input: {
  range: api.instance.UsageRange;
  groupBy: api.instance.UsageDimension;
  thenBy?: api.instance.UsageDimension;
}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "usage", input] as const,
    queryFn: () => api.instance.getUsage(input),
  });
}

/**
 * Le aree che un cambio dei blocchi d'istanza (budget, pausa, archiviazione)
 * tocca nelle altre aree: i blocchi stessi e il lavoro delle task
 * (`TaskWork.blocked`, le sessioni in attesa), le esecuzioni delle automazioni.
 */
const INSTANCE_EFFECT_AREAS: readonly string[] = [
  "instance",
  "conversations",
  "automations",
  // I segnali delle tessere del binario e il polso: «Claude waiting».
  "projects",
  "pulse",
];

/**
 * Rilegge i blocchi quando cambiano (Task 6, shape EF §5): alzato il budget o
 * ripresa la coda, i controlli tornano accesi al giro dopo, senza un
 * ricaricamento a mano.
 */
export function useInstanceChanges(): void {
  const client = useQueryClient();
  useEffect(
    () =>
      api.onInstanceChange(() => {
        void client.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "as" &&
            INSTANCE_EFFECT_AREAS.includes(query.queryKey[2] as string),
        });
      }),
    [client],
  );
}

/**
 * Perché un lavoro nuovo di Claude non partirebbe adesso nel progetto
 * (ruling 6): budget del mese esaurito o coda in pausa; `projectId` nullo
 * per «Chiedi a Claude» (solo il budget). Le pagine non lo deducono da sole.
 */
export function useAiBlock(projectId: string | null) {
  const me = useSessionPersonId();
  useInstanceChanges();
  return useQuery({
    queryKey: ["as", me, "instance", "ai-block", projectId] as const,
    queryFn: () => api.instance.getAiBlock(projectId),
  });
}

/**
 * La sola pausa della coda del progetto (chi, da quando): la testata del
 * progetto e la riga di All projects la dicono anche col budget raggiunto,
 * che invece vince sugli avvii (shape [EF 4]).
 */
export function useQueuePause(projectId: string) {
  const me = useSessionPersonId();
  useInstanceChanges();
  return useQuery({
    queryKey: ["as", me, "instance", "queue-pause", projectId] as const,
    queryFn: () => api.instance.getQueuePause(projectId),
  });
}

/** Se si possono caricare file adesso (ruling 6): il Drive e gli allegati dei composer. */
export function useStorageAllowsUploads() {
  const me = useSessionPersonId();
  useInstanceChanges();
  return useQuery({
    queryKey: ["as", me, "instance", "uploads-allowed"] as const,
    queryFn: () => api.instance.getUploadsAllowed(),
  });
}

// --- AI: Providers, Models, Automation, Budget & language (Task 8) -----------
//
// Le letture stanno nell'area «instance»; ogni scrittura la ricarica, insieme
// al registro («changelog»). Il budget e la sua simulazione cambiano i
// blocchi delle altre aree: ricaricano anche quelle. Nessuna lettura porta un
// segreto: la chiave scritta passa solo come argomento di una scrittura.

const AI_WRITE_AREAS: readonly string[] = ["instance", "changelog"];
const BUDGET_WRITE_AREAS: readonly string[] = [...INSTANCE_EFFECT_AREAS, "changelog"];

/** La catena dei provider (errore `forbidden` senza `ai_providers.manage` né `settings.manage`). */
export function useProviders() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "providers"] as const,
    queryFn: () => api.instance.listProviders(),
  });
}

/** Aggiunge un account (+R, da `useReauth`). */
export function useCreateProvider() {
  return useWrite(
    (input: Parameters<typeof api.instance.createProvider>[0]) => api.instance.createProvider(input),
    AI_WRITE_AREAS,
    // La chiave sta negli argomenti: la cache delle mutazioni non la tiene.
    { secret: true },
  );
}

export function useSetProviderEnabled() {
  return useWrite(
    ([id, enabled]: [string, boolean]) => api.instance.setProviderEnabled(id, enabled),
    AI_WRITE_AREAS,
  );
}

export function useMoveProvider() {
  return useWrite(
    ([id, toIndex]: [string, number]) => api.instance.moveProvider(id, toIndex),
    AI_WRITE_AREAS,
  );
}

export function useTestProvider() {
  return useWrite((id: string) => api.instance.testProvider(id), AI_WRITE_AREAS);
}

/** Sostituisce la chiave (+R). */
export function useReplaceProviderCredential() {
  return useWrite(
    ([id, credential]: [string, string]) => api.instance.replaceProviderCredential(id, credential),
    AI_WRITE_AREAS,
    { secret: true },
  );
}

/** Elimina un account (+R). */
export function useDeleteProvider() {
  return useWrite((id: string) => api.instance.deleteProvider(id), AI_WRITE_AREAS);
}

/** SOLO PROTOTIPO: l'esito della prossima prova (un provider, un account, "storage" o "webhook"). */
export function useSimulateNextTest() {
  return useWrite(
    ([target, outcome]: [string, api.instance.TestOutcome]) =>
      api.instance.simulateNextTest(target, outcome),
    ["instance"],
  );
}

/** Il modello per operazione, con la fonte e il ritorno di «Use default». */
export function useModels() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "models"] as const,
    queryFn: () => api.instance.listModels(),
  });
}

/** Imposta il modello; `null` torna all'env o al default. */
export function useSetModel() {
  return useWrite(
    ([operation, model]: [AiOperation, AiModelChoice | null]) =>
      api.instance.setModel(operation, model),
    AI_WRITE_AREAS,
  );
}

export function useAiAutomation() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "automation"] as const,
    queryFn: () => api.instance.getAutomation(),
  });
}

export function useSaveAiAutomation() {
  return useWrite(
    (input: api.instance.AutomationSettings) => api.instance.saveAutomation(input),
    AI_WRITE_AREAS,
  );
}

/** Budget, speso del mese, se è raggiunto e lingua dei contenuti. */
export function useBudget() {
  const me = useSessionPersonId();
  useInstanceChanges();
  return useQuery({
    queryKey: ["as", me, "instance", "budget"] as const,
    queryFn: () => api.instance.getBudget(),
  });
}

export function useSaveBudget() {
  return useWrite(
    (input: Parameters<typeof api.instance.saveBudget>[0]) => api.instance.saveBudget(input),
    BUDGET_WRITE_AREAS,
  );
}

/** SOLO PROTOTIPO: il budget raggiunto, nel riquadro. */
export function useSimulateBudgetReached() {
  return useWrite(
    (on: boolean) => api.instance.simulateBudgetReached(on),
    INSTANCE_EFFECT_AREAS,
  );
}

// --- Git accounts e Plugins (Task 10) ----------------------------------------
//
// Ogni scrittura ricarica l'istanza e il registro. Il token passa solo come
// argomento di una scrittura: nessuna lettura lo porta (RF 1). Le transizioni
// dei plugin (preparazione, smoke test) non passano da una chiamata: mentre
// un plugin ha un passo in corso (`busy`, dal livello dati) le letture si
// ripetono da sole.

/** Quanto spesso si rilegge un plugin con un passo in corso (il passo dura `PLUGIN_STEP_MS`). */
const PLUGIN_REFRESH_MS = 300;
const INTEGRATION_WRITE_AREAS: readonly string[] = ["instance", "changelog"];

/** Gli account git, coi repository che li usano (errore `forbidden` senza `git_accounts.view` né `.manage`). */
export function useGitAccounts() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "git-accounts"] as const,
    queryFn: () => api.instance.listGitAccounts(),
  });
}

/**
 * Aggiunge un account (+R). Il token sta negli argomenti: `secret` toglie la
 * mutazione dalla cache appena finisce (`gcTime: 0`), come nella 9a.
 */
export function useCreateGitAccount() {
  return useWrite(
    (input: Parameters<typeof api.instance.createGitAccount>[0]) =>
      api.instance.createGitAccount(input),
    INTEGRATION_WRITE_AREAS,
    { secret: true },
  );
}

export function useUpdateGitAccount() {
  return useWrite(
    ([id, input]: [string, Parameters<typeof api.instance.updateGitAccount>[1]]) =>
      api.instance.updateGitAccount(id, input),
    INTEGRATION_WRITE_AREAS,
  );
}

/** Sostituisce il token (+R). */
export function useReplaceGitToken() {
  return useWrite(
    ([id, token]: [string, string]) => api.instance.replaceGitToken(id, token),
    INTEGRATION_WRITE_AREAS,
    { secret: true },
  );
}

export function useValidateGitAccount() {
  return useWrite((id: string) => api.instance.validateGitAccount(id), INTEGRATION_WRITE_AREAS);
}

/** Elimina un account (+R); in uso → `in_use` coi repository visibili e gli altri contati. */
export function useDeleteGitAccount() {
  return useWrite((id: string) => api.instance.deleteGitAccount(id), INTEGRATION_WRITE_AREAS);
}

export function useSetDefaultReviewer() {
  return useWrite(
    ([id, on]: [string, boolean]) => api.instance.setDefaultReviewer(id, on),
    INTEGRATION_WRITE_AREAS,
  );
}

/** I plugin del registro; si rileggono da soli finché uno ha un passo in corso. */
export function usePlugins() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "plugins"] as const,
    queryFn: () => api.instance.listPlugins(),
    refetchInterval: (query) =>
      query.state.data?.some((p) => p.busy) ? PLUGIN_REFRESH_MS : false,
  });
}

/** Un plugin con l'inventario intero; si rilegge da solo finché ha un passo in corso. */
export function usePlugin(id: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "plugin", id] as const,
    queryFn: () => api.instance.getPlugin(id),
    refetchInterval: (query) => (query.state.data?.busy ? PLUGIN_REFRESH_MS : false),
  });
}

/** Registra un plugin (casella «Mi fido» e +R). */
export function useRegisterPlugin() {
  return useWrite(
    (input: Parameters<typeof api.instance.registerPlugin>[0]) =>
      api.instance.registerPlugin(input),
    INTEGRATION_WRITE_AREAS,
  );
}

/** Aggiorna a un ref (casella «Mi fido» e +R). */
export function useUpdatePluginRef() {
  return useWrite(
    ([id, input]: [string, Parameters<typeof api.instance.updatePluginRef>[1]]) =>
      api.instance.updatePluginRef(id, input),
    INTEGRATION_WRITE_AREAS,
  );
}

export function useRerunSmoke() {
  return useWrite((id: string) => api.instance.rerunSmoke(id), INTEGRATION_WRITE_AREAS);
}

export function useRemovePlugin() {
  return useWrite((id: string) => api.instance.removePlugin(id), INTEGRATION_WRITE_AREAS);
}

/** SOLO PROTOTIPO: come finirà la prossima preparazione, per il riquadro. */
export function useNextPluginOutcome() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "plugin-outcome"] as const,
    queryFn: () => api.instance.getNextPluginOutcome(),
  });
}

export function useSimulateNextPluginOutcome() {
  return useWrite(
    (outcome: "ready" | "failed") => api.instance.simulateNextPluginOutcome(outcome),
    ["instance"],
  );
}

// --- Google Workspace, Storage, Outgoing webhooks (Task 11) -------------------
//
// Come le integrazioni del Task 10: ogni scrittura ricarica l'istanza e il
// registro. Client secret e chiave S3 passano solo come argomento di una
// scrittura (`secret`: la cache delle mutazioni non li tiene). L'archiviazione
// decide se si può caricare (Drive, allegati dei composer): le sue scritture
// e le sue prove ricaricano anche quei blocchi. L'URL del webhook non è un
// segreto (maintainer, 30 ott 2026).

const STORAGE_WRITE_AREAS: readonly string[] = [...INSTANCE_EFFECT_AREAS, "changelog"];

/** Le app Google, con chi ha una casella collegata (errore `forbidden` senza `integrations.manage`). */
export function useGoogleApps() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "google-apps"] as const,
    queryFn: () => api.instance.listGoogleApps(),
  });
}

/** Aggiunge un'app (+R). Il client secret sta negli argomenti. */
export function useCreateGoogleApp() {
  return useWrite(
    (input: Parameters<typeof api.instance.createGoogleApp>[0]) =>
      api.instance.createGoogleApp(input),
    INTEGRATION_WRITE_AREAS,
    { secret: true },
  );
}

/** Nome, domini e client ID, senza riconferma; togliere un dominio con caselle → `in_use`. */
export function useUpdateGoogleApp() {
  return useWrite(
    ([id, input]: [string, Parameters<typeof api.instance.updateGoogleApp>[1]]) =>
      api.instance.updateGoogleApp(id, input),
    INTEGRATION_WRITE_AREAS,
  );
}

/** Sostituisce il client secret (+R). */
export function useReplaceGoogleSecret() {
  return useWrite(
    ([id, secret]: [string, string]) => api.instance.replaceGoogleSecret(id, secret),
    INTEGRATION_WRITE_AREAS,
    { secret: true },
  );
}

/** Elimina un'app (+R); con caselle → `in_use`. */
export function useDeleteGoogleApp() {
  return useWrite((id: string) => api.instance.deleteGoogleApp(id), INTEGRATION_WRITE_AREAS);
}

/** L'archiviazione, senza la chiave, con la riga di stato (`status`). */
export function useStorage() {
  const me = useSessionPersonId();
  useInstanceChanges();
  return useQuery({
    queryKey: ["as", me, "instance", "storage"] as const,
    queryFn: () => api.instance.getStorage(),
  });
}

/** Salva la configurazione; con una chiave nuova (+R), che sta negli argomenti. */
export function useSaveStorage() {
  return useWrite(
    (input: Parameters<typeof api.instance.saveStorage>[0]) => api.instance.saveStorage(input),
    STORAGE_WRITE_AREAS,
    { secret: true },
  );
}

export function useSetAttachments() {
  return useWrite((on: boolean) => api.instance.setAttachments(on), STORAGE_WRITE_AREAS);
}

export function useTestStorage() {
  return useWrite(() => api.instance.testStorage(), STORAGE_WRITE_AREAS);
}

/** Il webhook in uscita, con l'URL in chiaro e i 21 eventi. */
export function useWebhook() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "webhook"] as const,
    queryFn: () => api.instance.getWebhook(),
  });
}

/** Salva tutto il modulo, senza riconferma. */
export function useSaveWebhook() {
  return useWrite(
    (input: Parameters<typeof api.instance.saveWebhook>[0]) => api.instance.saveWebhook(input),
    INTEGRATION_WRITE_AREAS,
  );
}

export function useTestWebhook() {
  return useWrite(() => api.instance.testWebhook(), INTEGRATION_WRITE_AREAS);
}

/**
 * Il messaggio d'esempio di un evento in un formato, nella lingua dei
 * contenuti d'istanza (si rilegge con l'area «instance»).
 */
export function useWebhookPreview(
  eventId: api.instance.WebhookEventId,
  format: api.instance.WebhookFormat,
) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "webhook-preview", eventId, format] as const,
    queryFn: () => Promise.resolve(api.instance.previewWebhook(eventId, format)),
    // Passando da un evento all'altro l'anteprima non si svuota.
    placeholderData: (previous) => previous,
  });
}
