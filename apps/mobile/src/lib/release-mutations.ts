import { ApiError } from "@stubwise/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useAuth } from "../app/providers";
import { projectsPulseKey, ticketKeys, workKeys } from "./query-keys";

/**
 * La frase per l'errore di un merge (28 set 2026, dettaglio progetto v3 §6).
 * Una per ogni risposta della rotta di rilascio
 * (`apps/server/src/routes/release.ts`), e un errore di rete distinto: chi
 * preme Mergia deve sapere se riprovare ha senso.
 *
 * `checks_unreadable` e il 502 dicono la stessa cosa a chi legge — il provider
 * non ha risposto — anche se il server li tiene distinti: `checks_unreadable`
 * NON è «i controlli falliscono», e confonderli direbbe una cosa falsa.
 */
export function describeReleaseError(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError)) return t("mobile.projects.merge.errors.network");
  if (error.status === 502) return t("mobile.projects.merge.errors.unreachable");
  switch (error.code) {
    case "checks_failed":
      return t("mobile.projects.merge.errors.checksFailed");
    case "already_closed":
      return t("mobile.projects.merge.errors.alreadyClosed");
    case "checks_unreadable":
      return t("mobile.projects.merge.errors.unreachable");
    case "forbidden":
      return t("mobile.projects.merge.errors.forbidden");
    case "not_found":
      return t("mobile.projects.merge.errors.notFound");
    // Due rifiuti del PROVIDER che riprovare non cambia: conflitti o regole
    // del branch, e credenziali git senza il permesso di merge. Stesse due
    // frasi del web (`release:errors.notMergeable`/`mergeForbidden`).
    case "not_mergeable":
      return t("mobile.projects.merge.errors.notMergeable");
    case "merge_forbidden":
      return t("mobile.projects.merge.errors.mergeForbidden");
    default:
      return t("mobile.projects.merge.errors.generic");
  }
}

export interface ReleaseInput {
  ticketId: string;
  repositoryId: string;
}

/**
 * IL MERGE DALL'APP (28 set 2026, dettaglio progetto v3 §6): la STESSA rotta
 * della coda di rilascio del web, col suo `requireAdmin` e il controllo
 * ridondante dentro `releasePullRequest`. Qui non si decide chi può: il
 * bottone compare solo dove il polso dice `canMerge`, e il cancello vero
 * resta sul server.
 *
 * Al successo si ricaricano il polso (la PR esce da «Tocca a te»), i ticket e
 * il lavoro di QUEL ticket. Il ticket si chiude col webhook del provider, come
 * per un merge fatto a mano: la fase 8 non scrive su `ticket_repositories`,
 * quindi per qualche secondo il polso può ancora mostrare la PR — il
 * ricaricamento periodico la toglie.
 *
 * Gli errori si MOSTRANO (`errorMessage`), mai ingoiati: `onDone` parte solo
 * al successo, così chi apre un pannello lo tiene aperto sull'errore.
 */
export function useRelease() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: ({ ticketId, repositoryId }: ReleaseInput) => {
      if (!client) return Promise.reject(new Error("useRelease richiede un client autenticato"));
      return client.tickets.release(ticketId, repositoryId);
    },
    onSuccess: (_result, { ticketId }) => {
      void queryClient.invalidateQueries({ queryKey: projectsPulseKey });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.all });
      void queryClient.invalidateQueries({ queryKey: workKeys.all(ticketId) });
    },
  });

  return {
    release: (input: ReleaseInput, onDone: () => void) => mutation.mutate(input, { onSuccess: onDone }),
    isPending: mutation.isPending,
    errorMessage: mutation.error ? describeReleaseError(mutation.error, t) : null,
    // Il metodo di `useMutation`, già stabile: vedi `lib/work-mutations.ts`.
    reset: mutation.reset,
  };
}
