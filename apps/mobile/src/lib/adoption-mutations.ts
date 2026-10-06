import { ApiError } from "@stubwise/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../app/providers";
import { useIsOnline } from "./inbox-mutations";
import { projectsPulseKey, ticketKeys, workKeys } from "./query-keys";

/**
 * La frase per un rifiuto dell'ADOZIONE di una PR (6 ott 2026): «Fai
 * correggere a Stubwise» (`POST …/adoption`) e «Smetti di correggere»
 * (`DELETE …/adoption`). Decide il `code`, MAI lo status (come
 * `describeCorrectionError`); la rete ha il suo testo.
 */
export function describeAdoptionError(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError) || error.status === 0) return t("mobile.work.adoption.errors.network");
  switch (error.code) {
    case "already_adopted":
      return t("mobile.work.adoption.errors.alreadyAdopted");
    case "not_adopted":
      return t("mobile.work.adoption.errors.notAdopted");
    case "pr_from_fork":
      return t("mobile.work.adoption.errors.prFromFork");
    case "pr_fork_unverifiable":
      return t("mobile.work.adoption.errors.prForkUnverifiable");
    case "stubwise_pr":
      return t("mobile.work.adoption.errors.stubwisePr");
    case "base_branch":
      return t("mobile.work.adoption.errors.baseBranch");
    case "pr_unverifiable":
      return t("mobile.work.adoption.errors.prUnverifiable");
    case "pr_not_open":
      return t("mobile.work.adoption.errors.prNotOpen");
    case "forbidden":
      return t("mobile.work.adoption.errors.forbidden");
    default:
      return t("mobile.work.adoption.errors.generic");
  }
}

function useInvalidateWork(ticketId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: workKeys.all(ticketId) });
    void queryClient.invalidateQueries({ queryKey: ticketKeys.all });
    void queryClient.invalidateQueries({ queryKey: projectsPulseKey });
  };
}

export interface AdoptInput {
  repositoryId: string;
  /** Già ripulita da chi chiama: `undefined` = nessuna nota. */
  note?: string;
}

/**
 * «FAI CORREGGERE A STUBWISE» dall'app: la stessa rotta del web. Gemella di
 * `useRequestCorrection`: il pannello si chiude solo al SUCCESSO (`onDone`),
 * e la guardia sincrona ferma il doppio tap.
 *
 * ⚠️ **Nessun controllo di ruolo qui.** Chi monta il bottone lo fa solo con
 * `prAdoption.canManage` (calcolato dal server col ruolo di chi guarda), e il
 * cancello vero è sul server (`requireAdmin`). `correctionId` null nella
 * risposta = affidata, ma la prima correzione non è partita: lo dice
 * `firstCorrectionNotStarted`.
 */
export function useAdoptPr(ticketId: string) {
  const { client } = useAuth();
  const online = useIsOnline();
  const { t } = useTranslation();
  const invalidate = useInvalidateWork(ticketId);
  const inFlight = useRef(false);

  const mutation = useMutation({
    mutationFn: ({ repositoryId, note }: AdoptInput) => {
      if (!client) return Promise.reject(new Error("useAdoptPr richiede un client autenticato"));
      return client.tickets.adoptPr(ticketId, repositoryId, note !== undefined ? { note } : {});
    },
    // Su qualunque esito il dettaglio si rilegge: anche un rifiuto (es.
    // `already_adopted`) vuol dire che la schermata è vecchia.
    onSettled: () => {
      inFlight.current = false;
      invalidate();
    },
  });

  return {
    adopt: (input: AdoptInput, onDone: () => void) => {
      if (inFlight.current) return;
      inFlight.current = true;
      mutation.mutate(input, { onSuccess: onDone });
    },
    isPending: mutation.isPending,
    online,
    disabled: !online || mutation.isPending,
    errorMessage: mutation.error ? describeAdoptionError(mutation.error, t) : null,
    firstCorrectionNotStarted:
      mutation.isSuccess && mutation.data.correctionId === null && !mutation.data.reviewApproved,
    /** Affidata con l'ultima review che approva: nessuna correzione ora, di proposito. */
    reviewApproved: mutation.isSuccess && mutation.data.reviewApproved,
    reset: mutation.reset,
  };
}

/** «SMETTI DI CORREGGERE» dall'app. Stesse regole di `useAdoptPr`. */
export function useReleasePrAdoption(ticketId: string) {
  const { client } = useAuth();
  const online = useIsOnline();
  const { t } = useTranslation();
  const invalidate = useInvalidateWork(ticketId);
  const inFlight = useRef(false);

  const mutation = useMutation({
    mutationFn: (repositoryId: string) => {
      if (!client) return Promise.reject(new Error("useReleasePrAdoption richiede un client autenticato"));
      return client.tickets.releasePrAdoption(ticketId, repositoryId);
    },
    onSettled: () => {
      inFlight.current = false;
      invalidate();
    },
  });

  return {
    release: (repositoryId: string, onDone: () => void) => {
      if (inFlight.current) return;
      inFlight.current = true;
      mutation.mutate(repositoryId, { onSuccess: onDone });
    },
    isPending: mutation.isPending,
    online,
    disabled: !online || mutation.isPending,
    errorMessage: mutation.error ? describeAdoptionError(mutation.error, t) : null,
    reset: mutation.reset,
  };
}
