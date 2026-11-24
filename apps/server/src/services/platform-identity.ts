import { getProvider } from "@stubwise/git";
import type { FetchPlatformIdentity } from "@stubwise/notifications";

/**
 * Il {@link FetchPlatformIdentity} del server: chi è il token sulla
 * piattaforma. Un modulo a sé perché lo usano il webhook "Request changes" e
 * la validazione dell'account revisore, e i test lo intercettano spiando
 * `getAuthenticatedUserId` sul prototype del provider.
 */
export const fetchPlatformIdentity: FetchPlatformIdentity = ({ provider, credentials }) =>
  getProvider(provider).getAuthenticatedUserId({ credentials }, { timeoutMs: PLATFORM_CALL_TIMEOUT_MS });

/**
 * Tempo massimo di UNA chiamata alla piattaforma fatta dal server (identità,
 * permesso dell'autore). Il webhook "Request changes" può farne più d'una in
 * sequenza prima di rispondere, e GitHub concede 10 s alla risposta: col
 * default di `fetchWithTimeout` (10 s) una sola chiamata lenta basterebbe a
 * far scadere la consegna.
 */
export const PLATFORM_CALL_TIMEOUT_MS = 5_000;

/**
 * Revisione dei lotti 6–7 (M-1): la stessa chiamata, che si ferma quando
 * `signal` scatta (il tempo massimo del preflight non lascia chiamate appese).
 */
export function fetchPlatformIdentityWith(signal: AbortSignal): FetchPlatformIdentity {
  return ({ provider, credentials }) =>
    getProvider(provider).getAuthenticatedUserId({ credentials }, { timeoutMs: PLATFORM_CALL_TIMEOUT_MS, fetchImpl: abortableFetch(signal) });
}

/** Un `fetch` che porta `signal` (insieme a quello che la chiamata passa già, se c'è). */
export function abortableFetch(signal: AbortSignal): typeof fetch {
  return (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}
