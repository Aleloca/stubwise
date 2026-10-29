import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import type { ChangeFilter } from "../changelog/types";
import { queryKeys, useSessionPersonId, useWrite } from "../queries";

// Gli hook dell'amministrazione e della riconferma (area 9a); `data/queries`
// li ri-esporta. L'import circolare con `../queries` è innocuo: gli helper si
// usano solo dentro le funzioni.

export type { ChangeEntryView, ChangeFilter } from "../changelog/types";
export type { SecondFactorInput, SecondFactorResult, TotpSetup } from "../auth/reauth";

/** Il registro delle modifiche in Amministrazione: le voci che chi guarda legge. */
export function useChanges(filter: ChangeFilter = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.changes(me, filter),
    queryFn: () => api.changelog.listChanges(filter),
  });
}

/**
 * Il registro di un progetto (Settings → Change log). Errore `not_found` per
 * un progetto nascosto o inesistente (R-G5), `forbidden` per chi non lo gestisce.
 */
export function useProjectChanges(
  projectId: string | undefined,
  filter: Omit<ChangeFilter, "projectId"> = {},
) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.projectChanges(me, projectId ?? "", filter),
    queryFn: () => api.changelog.listProjectChanges(projectId!, filter),
    enabled: !!projectId,
  });
}

/**
 * Il dialogo «Confirm it's you»: verifica il secondo fattore. Non cambia
 * nessuna lettura (apre solo la finestra di grazia), quindi non ricarica
 * niente; l'azione che l'ha aperto si ripete da sé.
 */
export function useReauthenticate() {
  return useWrite(api.auth.reauthenticate, []);
}

/** L'iscrizione al volo dentro la riconferma: il segreto TOTP, una volta. */
export function useEnrollDuringReauth() {
  return useWrite(() => api.auth.enrollDuringReauth(), []);
}
