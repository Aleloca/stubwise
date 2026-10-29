import type { ConversationDetail, ServerFixBlock } from "../../../data/types";
import { can, useViewer } from "../../../data/viewer";

/**
 * Quello che la scheda del piano di una correzione di server (area 8b)
 * legge in più: il server, se chi guarda può rifiutare anche con
 * l'approvazione spenta (`canRejectPlan`) e perché è spenta
 * (`planBlockedReason`), entrambi calcolati dal livello dati; se l'ha
 * avviata chi guarda; dove si ricollega l'accesso, solo a chi gestisce gli
 * accessi SSH.
 */
export interface ServerFixPlan {
  code: string;
  canReject: boolean;
  blockedReason: ServerFixBlock | null;
  startedByViewer: boolean;
  /** Il progetto da cui aprire la parte SSH del server; `null` senza `servers.ssh.manage`. */
  accessProject: string | null;
}

export function useServerFixPlan(
  detail: ConversationDetail | null,
  projectCode: string | null,
): ServerFixPlan | undefined {
  const { viewer } = useViewer();
  if (!detail?.serverFix) return undefined;
  const code = detail.serverFix.serverCode;
  return {
    code,
    canReject: detail.canRejectPlan,
    blockedReason: detail.planBlockedReason,
    startedByViewer: detail.isOwner,
    accessProject: projectCode && can(viewer, "servers.ssh.manage") ? projectCode : null,
  };
}
