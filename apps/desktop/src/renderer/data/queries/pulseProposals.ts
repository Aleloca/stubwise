import { useQuery } from "@tanstack/react-query";
import * as api from "@backend/api";
import { featureIntegrated } from "../integration";
// L'import circolare con `../queries` è innocuo: gli helper si usano solo
// dentro le funzioni, mai al caricamento del modulo.
import { CONVERSATION_AREAS, REQUEST_AREAS, TASK_AREAS, useInvalidate, useSessionPersonId } from "../queries";

// Le proposte del polso in «Da decidere» (shape `pulse-proposals.md`, PQ-1b).

const AREA = "pulseProposals";

export function usePulseProposals() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, AREA] as const,
    queryFn: () => api.pulse.listPulseProposals(),
    enabled: featureIntegrated("pulse-proposals"),
  });
}

/** Start e Not now: alla fine si rilegge, e la riga sparisce con la lettura. */
export function usePulseDecide() {
  const invalidate = useInvalidate([AREA, ...TASK_AREAS, ...REQUEST_AREAS, ...CONVERSATION_AREAS, "pulse"]);
  const settle = async <R,>(call: Promise<R>): Promise<R> => {
    try {
      return await call;
    } finally {
      await invalidate();
    }
  };
  return {
    start: (id: string, optionIndex: number) => settle(api.pulse.startPulseProposal(id, optionIndex)),
    dismiss: (id: string) => settle(api.pulse.dismissPulseProposal(id)),
  };
}
