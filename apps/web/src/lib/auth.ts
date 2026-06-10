import { queryOptions } from "@tanstack/react-query";
import { getMe, getSetupStatus } from "./api";

/**
 * Query dell'utente corrente. Niente retry: un 401 è una risposta definitiva
 * (non autenticato), non un errore transitorio da ritentare.
 */
export const meQueryOptions = queryOptions({
  queryKey: ["auth", "me"],
  queryFn: getMe,
  retry: false,
  staleTime: 60_000,
});

/**
 * Stato del primo setup. Passa da TanStack Query solo per deduplicare le
 * richieste concorrenti (staleTime 0, quindi mai servito da cache stantia):
 * lo stato cambia una volta completato il setup e non va memorizzato.
 */
export const setupStatusQueryOptions = queryOptions({
  queryKey: ["auth", "setup-status"],
  queryFn: getSetupStatus,
  retry: false,
});
