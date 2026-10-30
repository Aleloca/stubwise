import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import * as api from "../api";
import { useSessionPersonId } from "../queries";

// Gli hook dell'istanza (area 9b); `data/queries` li ri-esporta. L'import
// circolare con `../queries` è innocuo: gli helper si usano solo dentro le
// funzioni. I Task 3–7 ci aggiungono i loro.

export type { UsageDimension, UsageRange, UsageRow, UsageView } from "../instance/usage";

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
const INSTANCE_EFFECT_AREAS: readonly string[] = ["instance", "conversations", "automations"];

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

/** Se si possono caricare file adesso (ruling 6): il Drive e gli allegati dei composer. */
export function useStorageAllowsUploads() {
  const me = useSessionPersonId();
  useInstanceChanges();
  return useQuery({
    queryKey: ["as", me, "instance", "uploads-allowed"] as const,
    queryFn: () => api.instance.getUploadsAllowed(),
  });
}
