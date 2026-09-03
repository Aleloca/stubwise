import { ApiError, handledByFromError } from "@stubwise/api-client";
import type { InboxActionBody } from "@stubwise/api-client";
import type { InboxDecisionAction, InboxPage, Reader, SnoozeUntil } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNetInfo } from "@react-native-community/netinfo";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useAuth } from "../app/providers";

/**
 * Chiavi di query dell'inbox — stesso schema di `inboxKeys` in
 * `apps/web/src/lib/queries.ts`, ma SENZA filtri: l'app mobile legge sempre
 * l'inbox APERTA per intero (nessuna vista per progetto/stato in questo task).
 */
export const inboxKeys = {
  all: ["inbox"] as const,
  list: () => [...inboxKeys.all, "list"] as const,
  unread: () => [...inboxKeys.all, "unread"] as const,
};

type InboxListData = Reader<InboxPage>;

/**
 * Il device ha rete? Le mutazioni NON ottimistiche (`useAnswer`, `useApprove`…)
 * restano disabilitate offline — non c'è nulla da promettere in ottimismo su
 * una decisione che chiude le notifiche di ALTRI utenti (vedi il commento su
 * `useDecision`).
 *
 * `isConnected === false` è l'unico caso trattato come offline: `null`
 * (stato non ancora noto, es. al primissimo render) resta online per
 * default, per non disabilitare bottoni per un istante a ogni avvio schermo.
 */
export function useIsOnline(): boolean {
  const netInfo = useNetInfo();
  return netInfo.isConnected !== false;
}

/**
 * Contatore non letto: alimenta il badge del tab Inbox (`app/navigation.tsx`).
 * Stesso intervallo di polling della campanella web (30s) — vedi
 * `inboxUnreadQueryOptions` in `apps/web/src/lib/queries.ts`.
 */
export function useUnreadCount() {
  const { client } = useAuth();
  return useQuery({
    queryKey: inboxKeys.unread(),
    queryFn: async () => {
      if (!client) throw new Error("useUnreadCount richiede un client autenticato");
      const result = await client.inbox.unreadCount();
      return result.count;
    },
    enabled: client !== null,
    refetchInterval: 30_000,
  });
}

/**
 * Mutazione OTTIMISTICA generica: rimuove subito la riga dalla lista in cache
 * (la card sparisce), e la ripristina se il server rifiuta. Fattorizzata da
 * `useSnooze`/`useHandled`, che sono igiene PERSONALE — non possono fallire
 * per colpa di altri (nessuna corsa con un collega, a differenza delle azioni
 * decisionali) — quindi l'ottimismo è sicuro. Stessa scelta di
 * `apps/web/src/components/inbox-item.tsx`.
 */
function useOptimisticRemoval<TInput extends { id: string }>(mutationFn: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (input: TInput) => {
      await queryClient.cancelQueries({ queryKey: inboxKeys.list() });
      const previous = queryClient.getQueryData<InboxListData>(inboxKeys.list());
      queryClient.setQueryData<InboxListData>(inboxKeys.list(), (page) =>
        page ? { ...page, items: page.items.filter((row) => row.id !== input.id) } : page,
      );
      return { previous };
    },
    // `context` può mancare (`onMutate` non ancora girato, caso di scuola in
    // test sincroni): il rollback si applica solo se c'è qualcosa da ripristinare.
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(inboxKeys.list(), context.previous);
    },
    // `onSettled` e non `onSuccess`: dopo un rollback la lista va comunque
    // riallineata al server (e il badge non letto con lei).
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
    },
  });
}

export function useSnooze() {
  const { client } = useAuth();
  return useOptimisticRemoval<{ id: string; until: SnoozeUntil }>(({ id, until }) => {
    if (!client) return Promise.reject(new Error("useSnooze richiede un client autenticato"));
    return client.inbox.snooze(id, until);
  });
}

export function useHandled() {
  const { client } = useAuth();
  return useOptimisticRemoval<{ id: string }>(({ id }) => {
    if (!client) return Promise.reject(new Error("useHandled richiede un client autenticato"));
    return client.inbox.handled(id);
  });
}

/**
 * Messaggio d'errore di un'azione decisionale, dal solo `code` (mai da
 * `error.message`: i messaggi del server sono in inglese e non sono
 * contratto). Stessa mappatura di `messageForError`/`answerErrorMessage` in
 * `apps/web/src/components/inbox-item.tsx` e `question-panel.tsx`, riunite qui
 * perché sull'app mobile le sei azioni decisionali condividono UN pannello
 * d'errore per card, non due come sul web (card + pannello domanda separati).
 */
export function describeInboxError(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError)) return t("mobile.inbox.errors.generic");
  switch (error.code) {
    case "already_handled": {
      const by = handledByFromError(error);
      return by
        ? t("mobile.inbox.errors.alreadyHandled", { email: by.email })
        : t("mobile.inbox.errors.alreadyHandledUnknown");
    }
    case "job_in_flight":
      return t("mobile.inbox.errors.jobInFlight");
    case "plan_not_pending":
      return t("mobile.inbox.errors.planNotPending");
    case "question_not_pending":
      return t("mobile.inbox.errors.questionNotPending");
    case "invalid_answer":
      return t("mobile.inbox.errors.invalidAnswer");
    case "proposal_stale":
      return t("mobile.inbox.errors.proposalStale");
    case "run_not_started":
      return t("mobile.inbox.errors.runNotStarted");
    case "forbidden":
      return t("mobile.inbox.errors.forbidden");
    case "invalid_action":
      return t("mobile.inbox.errors.invalidAction");
    default:
      return t("mobile.inbox.errors.generic");
  }
}

export interface DecisionMutation {
  mutate: (input: { id: string; body?: InboxActionBody }) => void;
  isPending: boolean;
  /** `true` offline O in volo: i chiamanti disabilitano il bottone su questo, non su `isPending` da solo. */
  disabled: boolean;
  /** Rete assente: i chiamanti mostrano «Serve la rete» al posto della label normale. */
  online: boolean;
  errorMessage: string | null;
  reset: () => void;
}

/**
 * Mutazione DECISIONALE generica (`POST /api/inbox/:id/actions/:action`): MAI
 * ottimistica, a differenza di `useSnooze`/`useHandled`. Una decisione chiude
 * le notifiche di TUTTI i destinatari e può legittimamente perdere una corsa
 * con un collega (409 `already_handled`): promettere in ottimismo un esito che
 * potrebbe non essere quello vero manderebbe l'utente a credere di aver
 * risposto quando in realtà ha risposto qualcun altro prima. Disabilitata
 * offline per lo stesso motivo — non c'è "riprova quando torna la rete" per
 * una decisione, va rifatta con gli occhi aperti sull'esito.
 *
 * Al successo: le righe di `changedNotificationIds` escono dalla lista in
 * cache (non sono più "aperte"), e tutto l'albero `inbox` si invalida — anche
 * il badge non letto, che deve scendere subito, non al prossimo poll di 30s.
 *
 * Al 409 (qualcun altro ha deciso prima): stessa invalidazione, così la card
 * stantia sparisce dalla lista appena il refetch atterra; il chiamante legge
 * il motivo da `errorMessage` (già localizzato, "ci ha pensato {{email}}"
 * quando il server lo sa dire).
 */
function useDecision(action: InboxDecisionAction): DecisionMutation {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: (input: { id: string; body?: InboxActionBody }) => {
      if (!client) return Promise.reject(new Error("useDecision richiede un client autenticato"));
      return client.inbox.act(input.id, action, input.body);
    },
    onSuccess: (result) => {
      queryClient.setQueryData<InboxListData>(inboxKeys.list(), (page) =>
        page
          ? { ...page, items: page.items.filter((row) => !result.changedNotificationIds.includes(row.id)) }
          : page,
      );
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
      }
    },
  });

  return {
    mutate: (input) => mutation.mutate(input),
    isPending: mutation.isPending,
    disabled: !online || mutation.isPending,
    online,
    errorMessage: mutation.error ? describeInboxError(mutation.error, t) : null,
    reset: () => mutation.reset(),
  };
}

/** Approva un piano fermo sul gate (`job.plan_review`, solo maintainer). */
export function useApprove(): DecisionMutation {
  return useDecision("approve_plan");
}

/** Rifiuta un piano con istruzioni: il piano successivo ne tiene conto. */
export function useReject(): DecisionMutation {
  return useDecision("reject_plan");
}

/** Rilancia un lavoro fermo (`held`, `budget_held`, `failed`, `pr_closed`). */
export function useRelaunch(): DecisionMutation {
  return useDecision("relaunch");
}

/** Risponde a una domanda dell'agente (`job.awaiting_input`). */
export function useAnswer(): DecisionMutation {
  return useDecision("answer");
}

/**
 * "Procedi con {{lettera}}" sulla card del pulse proattivo: stessa azione
 * `answer` della domanda dell'agente — un nome suo perché la UI del pulse (un
 * tap sull'opzione consigliata, niente sheet) è concettualmente un'AZIONE
 * diversa dal rispondere, non solo un'etichetta diversa.
 */
export function useProceed(): DecisionMutation {
  return useDecision("answer");
}
