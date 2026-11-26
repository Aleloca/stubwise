import type { TFunction } from "i18next";
import type { ServerPlan } from "@stubwise/shared";
import type { ConversationDetail, ServerFixBlock } from "../../../data/types";
import { actionKey } from "../../../domain/servers/fixPlan";

/**
 * Quello che la scheda del piano di una correzione di server (area 8, F4b)
 * legge in più: il server, se chi guarda può rifiutare anche con
 * l'approvazione spenta (`canRejectPlan`) e perché è spenta
 * (`planBlockedReason`), entrambi calcolati dal livello dati; se l'ha
 * avviata chi guarda; l'avviso prima di approvare «libera spazio» su un
 * server condiviso (`serverFixPruneWarning`, calcolato dal livello dati).
 */
export interface ServerFixPlan {
  code: string;
  canReject: boolean;
  blockedReason: ServerFixBlock | null;
  startedByViewer: boolean;
  pruneWarning: { projects: string[]; hiddenCount: number } | null;
}

export function useServerFixPlan(detail: ConversationDetail | null): ServerFixPlan | undefined {
  if (!detail?.serverFix) return undefined;
  return {
    code: detail.serverFix.serverCode,
    canReject: detail.canRejectPlan,
    blockedReason: detail.planBlockedReason,
    startedByViewer: detail.isOwner,
    pruneWarning: detail.serverFixPruneWarning ?? null,
  };
}

/**
 * Un passo del piano in parole, nella lingua di chi guarda: SOLO le azioni
 * dell'insieme chiuso hanno una frase (`taskDetail.server.planCard.steps`);
 * i parametri entrano come valori, mai come comando.
 */
export function stepLabel(t: TFunction, step: ServerPlan["steps"][number]): string {
  const K = "taskDetail.server.planCard.steps";
  const params = step.params as Record<string, string | number>;
  if (step.action === "docker.prune")
    return t(`${K}.docker_prune.${String(params["what"])}`, {
      defaultValue: t(`${K}.docker_prune.other`),
    });
  return t(`${K}.${actionKey(step.action)}`, { ...params, defaultValue: step.action });
}
