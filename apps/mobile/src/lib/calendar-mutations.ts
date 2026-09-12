import { ApiError } from "@stubwise/api-client";
import type { CalendarRange } from "@stubwise/api-client";
import type { CalendarSeriesPatch } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useAuth } from "../app/providers";
import { useIsOnline } from "./inbox-mutations";

export const calendarKeys = {
  all: ["calendar"] as const,
  range: (range: CalendarRange) => [...calendarKeys.all, "range", range] as const,
  series: (account?: string) => [...calendarKeys.all, "series", account ?? null] as const,
};

/**
 * Messaggio d'errore del Calendario, dal solo `code` — stessa dottrina di
 * `describeMailError`/`describeInboxError`: mai da `error.message`, che è
 * inglese e non fa parte del contratto.
 *
 * `project_required` è l'unico errore che una persona può causare da qui
 * (accendere una serie senza aver scelto il progetto), e la UI non dovrebbe
 * nemmeno permetterlo — ma il messaggio serve lo stesso: quel 400 è la rete
 * sotto il trapezio, e se ci si finisce dentro va detto cosa manca, non
 * «qualcosa è andato storto». `not_found` copre la casella o la serie che
 * non sono (più) di questo utente.
 */
export function describeCalendarError(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError)) return t("mobile.calendar.errors.generic");
  switch (error.code) {
    case "project_required":
      return t("mobile.calendar.errors.projectRequired");
    case "not_found":
      return t("mobile.calendar.errors.notFound");
    case "range_too_wide":
    case "invalid_range":
      return t("mobile.calendar.errors.badRange");
    default:
      return t("mobile.calendar.errors.generic");
  }
}

/**
 * Gli eventi di un intervallo `[from, to)`. La griglia mensile chiede le
 * settimane INTERE del mese (`rangeForView("month", …)` di
 * `@stubwise/shared`), quindi al più ~6 settimane: ben sotto il tetto di 100
 * giorni della rotta.
 *
 * `staleTime` di 30s: il calendario cambia quando il poller gira (ogni
 * `GMAIL_POLL_MINUTES`, 5 minuti in prod), non a ogni secondo — rileggerlo a
 * ogni rimonta di un tab costerebbe una richiesta per niente.
 */
export function useCalendarRange(range: CalendarRange) {
  const { client } = useAuth();
  return useQuery({
    queryKey: calendarKeys.range(range),
    queryFn: () => {
      if (!client) throw new Error("useCalendarRange richiede un client autenticato");
      return client.calendar.range(range);
    },
    enabled: client !== null,
    staleTime: 30_000,
  });
}

/**
 * Le serie ricorrenti riconosciute, con la loro configurazione. Una lista
 * per definizione corta (riunioni ricorrenti, non messaggi) e senza filtro
 * di finestra: una serie le cui occorrenze cadono tutte fuori dalla griglia
 * visibile resta comunque qui — è ciò che la rende ancora SPEGNIBILE.
 */
export function useCalendarSeries(account?: string) {
  const { client } = useAuth();
  return useQuery({
    queryKey: calendarKeys.series(account),
    queryFn: () => {
      if (!client) throw new Error("useCalendarSeries richiede un client autenticato");
      return client.calendar.series(account);
    },
    enabled: client !== null,
    staleTime: 30_000,
  });
}

export interface SeriesMutation {
  save: (patch: CalendarSeriesPatch) => void;
  disable: () => void;
  isPending: boolean;
  disabled: boolean;
  errorMessage: string | null;
  reset: () => void;
}

/**
 * Scrivere la configurazione di una serie (App M3, Fase D, Task 12).
 *
 * Due mutazioni sotto un'interfaccia sola perché sono due facce della stessa
 * azione: «salva» (`PUT`, sostituzione integrale) e «spegni» (`DELETE`, che
 * ELIMINA la riga invece di mettere un flag a `false` — per
 * `isReadyForProposal` una serie mai configurata e una spenta di nuovo sono
 * la stessa cosa).
 *
 * ⚠️ `save` prende il corpo INTERO dal chiamante e non lo compone: il
 * `PUT` è una sostituzione, quindi un corpo parziale azzererebbe in silenzio
 * i campi omessi. Chi chiama legge prima lo stato corrente dal form, che a
 * sua volta nasce dalla serie appena letta.
 */
export function useSeriesMutation(accountId: string, recurringEventId: string): SeriesMutation {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const { t } = useTranslation();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
  };

  const save = useMutation({
    mutationFn: (patch: CalendarSeriesPatch) => {
      if (!client) throw new Error("useSeriesMutation richiede un client autenticato");
      return client.calendar.putSeries(recurringEventId, patch);
    },
    onSuccess: invalidate,
  });

  const disable = useMutation({
    mutationFn: () => {
      if (!client) throw new Error("useSeriesMutation richiede un client autenticato");
      return client.calendar.deleteSeries(recurringEventId, accountId);
    },
    onSuccess: invalidate,
  });

  const error = save.error ?? disable.error;
  const isPending = save.isPending || disable.isPending;

  return {
    save: (patch) => save.mutate(patch),
    disable: () => disable.mutate(),
    isPending,
    disabled: !online || isPending,
    errorMessage: error ? describeCalendarError(error, t) : null,
    reset: () => {
      save.reset();
      disable.reset();
    },
  };
}
