import { ApiError } from "@stubwise/api-client";
import type { TicketPatch } from "@stubwise/api-client";
import type { AnswerBody } from "@stubwise/shared";
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
  /** Il feed di attività del ticket (fase 5): date reali dei passi della timeline. */
  activity: (ticketId: string) => [...workKeys.all(ticketId), "activity"] as const,
  /** I commenti del ticket: la conversazione attorno al lavoro. */
  comments: (ticketId: string) => [...workKeys.all(ticketId), "comments"] as const,
};

export interface TicketActionMutation<TInput> {
  mutate: (input: TInput) => void;
  isPending: boolean;
  /** `true` offline O in volo: stessa convenzione di `DecisionMutation` in `lib/inbox-mutations.ts`. */
  disabled: boolean;
  online: boolean;
  errorMessage: string | null;
  reset: () => void;
}

/**
 * OGNI azione su UN ticket passa di qui: decisioni sul piano, modifica dei
 * campi, commento, avvio del lavoro, risposta a una domanda, cancellazione di
 * design e piano. Un helper solo perché tutte condividono le stesse quattro
 * cose — invalidare l'albero del ticket, tacere offline, tradurre l'errore,
 * non essere ottimistiche.
 *
 * ⚠️ **Non impone nessun ruolo, di proposito.** Delle dieci azioni solo le
 * quattro sul piano sono `requireAdmin` lato server; le altre sono
 * `requireAuth`, e un operatore le usa tutte. Chi monta un bottone decide se
 * MOSTRARLO (come fa `PlanSection` con `isAdmin`), ma un controllo di ruolo
 * aggiunto qui sarebbe una seconda copia della regola — e la copia sbagliata
 * starebbe nell'app, cioè dalla parte che si aggiorna dagli store e non dai
 * nostri deploy.
 *
 * Nato per approva/rifiuta il piano (`POST /api/tickets/:id/approve-plan`
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
function useTicketAction<TInput>(mutationFn: (client: NonNullable<ReturnType<typeof useAuth>["client"]>, input: TInput) => Promise<unknown>, ticketId: string): TicketActionMutation<TInput> {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: (input: TInput) => {
      if (!client) return Promise.reject(new Error("useTicketAction richiede un client autenticato"));
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
    // Il metodo di `useMutation`, già stabile — NON `() => mutation.reset()`,
    // che ricrea una funzione nuova a ogni render: innocuo qui (nessun
    // effetto lo mette in un dep array oggi), ma è lo stesso difetto latente
    // chiuso in `lib/backlog-mutations.ts` (App M3 Fase A, Task 2) dopo che
    // ci aveva prodotto un loop di render infinito — fix preventivo qui,
    // stessa causa possibile.
    reset: mutation.reset,
  };
}

/** Approva il piano in attesa sul ticket (solo maintainer — il server lo impone comunque). */
export function useApprovePlan(ticketId: string): TicketActionMutation<void> {
  return useTicketAction<void>((client) => client.tickets.approvePlan(ticketId), ticketId);
}

/** Rifiuta il piano con istruzioni opzionali: il worker ri-pianifica. */
export function useRejectPlan(ticketId: string): TicketActionMutation<string | undefined> {
  return useTicketAction<string | undefined>(
    (client, instructions) => client.tickets.rejectPlan(ticketId, instructions ? { instructions } : undefined),
    ticketId,
  );
}

/**
 * Pre-approva IN ANTICIPO il piano CORRENTE (fase 7, App M3 Fase B): un
 * operatore può far partire il fix senza fermarsi sul gate. Stesso
 * `useTicketAction` di approva/rifiuta — invalida `workKeys.all(ticketId)`
 * al successo, e su un 409 (`no_plan`, il piano è sparito nel frattempo).
 * Solo maintainer lato UI — il server lo impone comunque (`requireAdmin` +
 * ricontrollo nel servizio).
 */
export function usePreApprovePlan(ticketId: string): TicketActionMutation<void> {
  return useTicketAction<void>((client) => client.tickets.preApprovePlan(ticketId), ticketId);
}

/** Revoca la pre-approvazione: idempotente lato server, stessa mutazione. */
export function useRevokePlanApproval(ticketId: string): TicketActionMutation<void> {
  return useTicketAction<void>((client) => client.tickets.revokePlanApproval(ticketId), ticketId);
}

/**
 * Modifica parziale del ticket: stato, priorità, assegnatario, milestone,
 * etichette — gli stessi cinque campi che la pagina web modifica.
 *
 * `requireAuth` lato server: nessun gate di ruolo qui (vedi il docblock di
 * `useTicketAction`).
 */
export function usePatchTicket(ticketId: string): TicketActionMutation<TicketPatch> {
  return useTicketAction<TicketPatch>((client, patch) => client.tickets.patch(ticketId, patch), ticketId);
}

/**
 * Aggiunge un commento. Invalida l'albero del ticket, quindi l'elenco dei
 * commenti si rilegge da sé: chi scrive vede comparire la propria riga, che è
 * l'unico modo che ha di sapere che è andata.
 */
export function useAddComment(ticketId: string): TicketActionMutation<string> {
  return useTicketAction<string>((client, body) => client.tickets.comment(ticketId, body), ticketId);
}

/**
 * Avvia il lavoro dell'agente (202), con o senza istruzioni — `withInstructions`
 * fa ripartire l'agente dal commento appena lasciato, come sul web.
 *
 * ⚠️ Un `member` può lanciarlo: il divieto dell'operatore NON è "non avviare",
 * è "non approvare da solo il piano" — e quel gate vive in `jobs.ts` lato
 * server, che per un operatore fa nascere il run già fermo su
 * `awaiting_plan_approval` invece che in coda. Nascondere il bottone qui
 * toglierebbe a un operatore il suo lavoro quotidiano senza proteggere nulla.
 *
 * 409 `job_in_flight` se un run è già in volo: l'invalidazione su 409
 * dell'helper rinfresca la schermata, che allora lo mostra.
 */
export function useRunAi(ticketId: string): TicketActionMutation<{ withInstructions?: boolean } | undefined> {
  return useTicketAction<{ withInstructions?: boolean } | undefined>(
    (client, opts) => client.tickets.runAi(ticketId, opts),
    ticketId,
  );
}

/**
 * Risponde alla domanda aperta dell'agente: il job parcheggiato in
 * `awaiting_input` riparte da solo.
 *
 * `questionId` viaggia sempre insieme alla risposta — il server lo confronta
 * con la domanda DAVVERO aperta, così una schermata ferma su un giro superato
 * viene rifiutata (409) invece di rispondere alla domanda successiva. Su quel
 * 409 l'helper invalida, e la schermata mostra la domanda nuova.
 */
export function useAnswerQuestion(ticketId: string): TicketActionMutation<{ questionId: string; answer: AnswerBody }> {
  return useTicketAction<{ questionId: string; answer: AnswerBody }>(
    (client, { questionId, answer }) => client.tickets.answerQuestion(ticketId, questionId, answer),
    ticketId,
  );
}

/**
 * Cancella il design collegato: il corpo del ticket torna all'originale.
 * **Irreversibile.** Chi la monta chiede conferma esplicita — la mutazione
 * non la chiede per sé, come non la chiede il server.
 */
export function useDeleteDesign(ticketId: string): TicketActionMutation<void> {
  return useTicketAction<void>((client) => client.tickets.deleteDesign(ticketId), ticketId);
}

/** Azzera il piano di implementazione. **Irreversibile**, come `useDeleteDesign`. */
export function useDeletePlan(ticketId: string): TicketActionMutation<void> {
  return useTicketAction<void>((client) => client.tickets.deletePlan(ticketId), ticketId);
}
