import type { AiModelChoice, AiOperation } from "@stubwise/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import * as api from "../api";
import { useSessionPersonId, useWrite } from "../queries";

// Gli hook dell'istanza (area 9b); `data/queries` li ri-esporta. L'import
// circolare con `../queries` è innocuo: gli helper si usano solo dentro le
// funzioni. I Task 3–7 ci aggiungono i loro.

export type { UsageDimension, UsageRange, UsageRow, UsageView } from "../instance/usage";
export type {
  AutomationRule,
  AutomationSettings,
  BudgetSaveEffect,
  BudgetView,
  ContentLanguage,
  InstanceResult,
  ModelRow,
  ModelSource,
  ProviderView,
  QuotaView,
  TestOutcome,
} from "../instance";
export { BACKGROUND_WEEKLY_THRESHOLD } from "../instance/providers";

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
