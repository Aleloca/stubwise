import { ApiError, isAgentSessionsUnavailable, type StubwiseClient } from "@stubwise/api-client";
import type { AgentSessionListQuery } from "@stubwise/shared";
import { queryOptions } from "@tanstack/react-query";
import { agentSessionKeys } from "./query-keys";

/**
 * Opzioni di query delle sessioni degli agenti: gemelle di
 * `apps/web/src/lib/queries.ts`. A differenza del web ricevono il `client`
 * (l'app lo prende da `useAuth`, non ha un modulo `api` globale) e un
 * `focused` dove il polling deve fermarsi a schermata non a fuoco
 * (`useScreenFocused`, deciso dal chiamante).
 */

/** Un 4xx è definitivo: riprovare spreca tentativi e ritarda il messaggio giusto. */
function retryUnlessClientError(count: number, error: Error): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return count < 3;
}

const AGENT_SESSIONS_POLL_MS = 5_000;
const ENDED_SESSION_POLL_MS = 10_000;
const LOOKUP_POLL_MS = 10_000;

/**
 * L'elenco. Polling 5 s SOLO a schermata a fuoco, e mai dopo un 404 senza
 * `code` (server senza la funzione: riprovare non lo cambia, M9).
 */
export function agentSessionsQueryOptions(
  client: StubwiseClient,
  filters?: AgentSessionListQuery,
  { focused = true }: { focused?: boolean } = {},
) {
  return queryOptions({
    queryKey: agentSessionKeys.list(filters),
    queryFn: () => client.agentSessions.list(filters),
    staleTime: 2_000,
    retry: (count, error) => !isAgentSessionsUnavailable(error) && count < 3,
    refetchInterval: (query) =>
      !focused || isAgentSessionsUnavailable(query.state.error) ? false : AGENT_SESSIONS_POLL_MS,
  });
}

/** Stati del job in cui non nascerà più una sessione nuova. */
const TERMINAL_JOB_STATUSES = new Set(["pr_opened", "pr_merged", "failed", "skipped", "pr_closed"]);

/**
 * Il lookup del ticket deve ripetersi? Sì solo se il job più recente è ancora
 * in cammino (non terminale), nessuna sessione è stata trovata e la schermata
 * è a fuoco: la sessione nasce quando il worker prende il job, DOPO la prima
 * ricerca. `jobStatus` assente (nessun job) = niente da aspettare.
 */
export function shouldPollAgentSessionLookup(input: {
  jobStatus: string | undefined;
  found: boolean;
  focused: boolean;
}): boolean {
  return (
    input.focused && !input.found && input.jobStatus !== undefined && !TERMINAL_JOB_STATUSES.has(input.jobStatus)
  );
}

/**
 * La ricerca di UNA sessione per ticket/job (link «Guarda la sessione»).
 * `revision` (lo stato del job) sta nella chiave: cambiando, rifà la ricerca.
 * Con `focused` definito polla ogni 10 s secondo `shouldPollAgentSessionLookup`
 * (la `revision` è lo stato del job); senza, nessun polling.
 */
export function agentSessionsLookupQueryOptions(
  client: StubwiseClient,
  filters?: AgentSessionListQuery,
  revision?: string,
  poll?: { focused: boolean },
) {
  return queryOptions({
    queryKey: [...agentSessionKeys.list(filters), "lookup", revision ?? null] as const,
    queryFn: () => client.agentSessions.list(filters),
    staleTime: 10_000,
    retry: false,
    refetchInterval: (query) =>
      poll &&
      shouldPollAgentSessionLookup({
        jobStatus: revision,
        found: (query.state.data?.live.length ?? 0) + (query.state.data?.recent.length ?? 0) > 0,
        focused: poll.focused,
      })
        ? LOOKUP_POLL_MS
        : false,
  });
}

/** 10 s solo se `ended` e senza errore (una sessione conclusa può tornare viva). */
export function agentSessionRefetchInterval(detail: { state: string } | undefined, error: unknown): number | false {
  return error == null && detail?.state === "ended" ? ENDED_SESSION_POLL_MS : false;
}

/** Il dettaglio: la messa a fuoco del polling è del chiamante (Task 6). */
export function agentSessionQueryOptions(client: StubwiseClient, id: string) {
  return queryOptions({
    queryKey: agentSessionKeys.detail(id),
    queryFn: () => client.agentSessions.get(id),
    retry: retryUnlessClientError,
    refetchInterval: (query) => agentSessionRefetchInterval(query.state.data, query.state.error),
  });
}

/** La prima pagina di eventi: mai rinfrescata da sola, scartata allo smontaggio (M10). */
export function agentSessionEventsQueryOptions(client: StubwiseClient, id: string) {
  return queryOptions({
    queryKey: agentSessionKeys.events(id),
    queryFn: () => client.agentSessions.events(id),
    retry: retryUnlessClientError,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}
