import { ApiError } from "@stubwise/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../app/providers";
import { describeInboxError, useIsOnline } from "./inbox-mutations";

/**
 * Chiavi di query del lavoro di UN ticket: dettaglio ticket (`implementationPlan`
 * incluso), job (la timeline) e domande dell'agente. Raggruppate sotto lo
 * stesso genitore (`all(ticketId)`) così un'unica `invalidateQueries` dopo
 * approva/rifiuta rinfresca tutt'e tre — la schermata Lavoro (Task 16) le
 * legge tutte per costruire la timeline in parole (`lib/timeline.ts`).
 */
export const workKeys = {
  all: (ticketId: string) => ["work", ticketId] as const,
  ticket: (ticketId: string) => [...workKeys.all(ticketId), "ticket"] as const,
  jobs: (ticketId: string) => [...workKeys.all(ticketId), "jobs"] as const,
  questions: (ticketId: string) => [...workKeys.all(ticketId), "questions"] as const,
};

export interface PlanDecisionMutation<TInput> {
  mutate: (input: TInput) => void;
  isPending: boolean;
  /** `true` offline O in volo: stessa convenzione di `DecisionMutation` in `lib/inbox-mutations.ts`. */
  disabled: boolean;
  online: boolean;
  errorMessage: string | null;
  reset: () => void;
}

/**
 * Approva/rifiuta il piano di UN TICKET (`POST /api/tickets/:id/approve-plan`
 * o `/reject-plan`) — DIVERSO dalle mutazioni decisionali dell'inbox
 * (`useApprove`/`useReject` in `lib/inbox-mutations.ts`), che agiscono su un
 * ID di NOTIFICA via `/api/inbox/:id/actions/:action`. La schermata Lavoro
 * (Task 16) apre da un ticket, non da una notifica: qui il gate `requireAdmin`
 * lato server è l'autorità, la UI si limita a non mostrare i bottoni a chi non
 * è maintainer.
 *
 * Volutamente NON ottimistica, stesso motivo di `useDecision`: la decisione
 * può perdere una corsa con un altro maintainer (409 `plan_not_pending`), e
 * promettere in ottimismo un esito potenzialmente falso sarebbe peggio di
 * aspettare la risposta del server. Disabilitata offline per lo stesso motivo.
 *
 * `onError` su un 409 invalida `workKeys.all(ticketId)` — STESSO pattern di
 * `useDecision` in `inbox-mutations.ts`: se un altro maintainer ha già deciso
 * (`plan_not_pending`), il job non è più `awaiting_plan_approval`, e senza
 * questa invalidazione `PlanSection` resterebbe con Approva/Rifiuta ancora
 * attivi finché `staleTime` non scade o lo screen non si rimonta — la UI
 * mostrerebbe il messaggio d'errore ma resterebbe altrimenti "bloccata" su uno
 * stato stantio. Il refetch che ne segue aggiorna `job.status`, e `WorkScreen`
 * ricalcola `canDecide` da lì.
 */
function usePlanDecision<TInput>(mutationFn: (client: NonNullable<ReturnType<typeof useAuth>["client"]>, input: TInput) => Promise<unknown>, ticketId: string): PlanDecisionMutation<TInput> {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: (input: TInput) => {
      if (!client) return Promise.reject(new Error("usePlanDecision richiede un client autenticato"));
      return mutationFn(client, input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workKeys.all(ticketId) });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: workKeys.all(ticketId) });
      }
    },
  });

  return {
    mutate: (input: TInput) => mutation.mutate(input),
    isPending: mutation.isPending,
    disabled: !online || mutation.isPending,
    online,
    errorMessage: mutation.error ? describeInboxError(mutation.error, t) : null,
    reset: () => mutation.reset(),
  };
}

/** Approva il piano in attesa sul ticket (solo maintainer — il server lo impone comunque). */
export function useApprovePlan(ticketId: string): PlanDecisionMutation<void> {
  return usePlanDecision<void>((client) => client.tickets.approvePlan(ticketId), ticketId);
}

/** Rifiuta il piano con istruzioni opzionali: il worker ri-pianifica. */
export function useRejectPlan(ticketId: string): PlanDecisionMutation<string | undefined> {
  return usePlanDecision<string | undefined>(
    (client, instructions) => client.tickets.rejectPlan(ticketId, instructions ? { instructions } : undefined),
    ticketId,
  );
}
