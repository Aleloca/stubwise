import type { FetchLike } from "@stubwise/git";

/**
 * Il `fetch` verso il provider git usato dagli script operativi
 * (`resync-webhooks`, `backfill-pr-states`). Sta in un modulo a sé perché è
 * la stessa regola in due script: un provider che non risponde deve far
 * fallire QUELLA richiesta, non appendere lo script per sempre.
 */

/** Timeout di default di ogni richiesta al provider negli script. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Il `fetch` dato al provider, con un timeout per richiesta combinato con un
 * eventuale `signal` già presente (il primo dei due che scatta interrompe).
 * Allo scadere la richiesta rifiuta con un errore `name: "TimeoutError"`.
 */
export function fetchWithRequestTimeout(base: FetchLike, timeoutMs: number): FetchLike {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}
