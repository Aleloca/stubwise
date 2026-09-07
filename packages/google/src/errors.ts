/**
 * Errore unico del client Google, e la distinzione che regge tutto il resto:
 * FATALE contro TRANSITORIO.
 *
 * Il poller delle caselle (fase 6) ha esattamente due reazioni possibili a un
 * errore di Google, e sceglierne una sbagliata costa caro in entrambe le
 * direzioni: disabilitare una casella per un 503 la spegne finché un umano non
 * se ne accorge; ritentare in eterno un `invalid_grant` brucia tentativi su un
 * esito che non può cambiare da solo. La stessa forma di
 * {@link isFatalSlackError} in `@stubwise/notifications`, per lo stesso motivo.
 *
 * `code` è il codice NORMALIZZATO su cui si decide (`invalid_grant`,
 * `rate_limited`, `history_expired`, …); `reason` è quello GREZZO che Google ha
 * mandato (`insufficientPermissions`, `fullSyncRequired`, …), tenuto perché nei
 * log è l'unica cosa che permette di capire cosa è successo davvero quando la
 * normalizzazione non basta.
 */

/**
 * Errori che disabilitano la casella: il consenso non c'è più, o non è mai
 * stato quello giusto. Sono i quattro valori che il design mappa 1:1 su
 * `google_accounts.disabled_reason` (con `access_denied`/`unauthorized_client`
 * che ricadono su `revoked`).
 *
 * ⚠️ `history_expired` e `sync_token_expired` NON sono qui, e non è una
 * dimenticanza: significano "il tuo punto di ripartenza è vecchio", si
 * risolvono con un resync completo e disabilitare la casella sarebbe la
 * reazione opposta a quella giusta.
 */
export const FATAL_GOOGLE_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "insufficient_scope",
  "unauthorized_client",
  "access_denied",
]);

/** Campi di un {@link GoogleApiError}. */
export interface GoogleApiErrorInit {
  /** Endpoint logico che ha fallito, per il messaggio: `gmail.history.list`, `oauth.token`, … */
  api: string;
  /** Codice HTTP, oppure 0 per gli errori che non hanno mai visto una risposta (rete, timeout). */
  status: number;
  /** Codice normalizzato su cui si decide fatale/transitorio. */
  code: string;
  /** Codice grezzo di Google, per i log. */
  reason: string;
  /** Attesa suggerita dall'header `Retry-After`, se c'era. */
  retryAfterMs?: number;
}

/** Errore di una chiamata a Google: HTTP non ok, risposta illeggibile, rete o timeout. */
export class GoogleApiError extends Error {
  readonly api: string;
  readonly status: number;
  readonly code: string;
  readonly reason: string;
  readonly retryAfterMs?: number;

  constructor(init: GoogleApiErrorInit) {
    super(`Google ${init.api} ha risposto ${init.status} (code=${init.code}, reason=${init.reason})`);
    this.name = "GoogleApiError";
    this.api = init.api;
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
  }
}

/**
 * True se l'errore è definitivo: la casella va disabilitata con un motivo,
 * senza ritentare. Tutto il resto — rete, timeout, 429, 5xx, sincronismi
 * scaduti — passa dal backoff.
 */
export function isFatalGoogleError(error: unknown): boolean {
  return error instanceof GoogleApiError && FATAL_GOOGLE_CODES.has(error.code);
}
