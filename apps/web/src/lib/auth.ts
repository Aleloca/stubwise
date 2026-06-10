import { queryOptions } from "@tanstack/react-query";
import { getMe } from "./api";

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
