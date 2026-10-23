/**
 * Riconferma prima delle azioni sensibili (secondo fattore, 23 ott 2026).
 *
 * Il server risponde 403 `reauth_required` a un'azione sensibile quando il
 * secondo fattore di questa sessione è più vecchio di 10 minuti, e 403
 * `second_factor_setup_required` quando la sessione è di prima del rilascio e
 * l'utente un'app non l'ha ancora. In entrambi i casi la web apre UN dialogo
 * globale (`components/security/reauth-dialog.tsx`, montato nel layout
 * autenticato) e, se va a buon fine, ripete la richiesta originale UNA volta.
 *
 * Qui vivono le due metà senza React: lo stato del dialogo (un solo dialogo
 * alla volta: chi arriva mentre è aperto aspetta lo stesso esito) e il
 * `fetch` del client API che intercetta quei 403. Si intercetta nel `fetch`
 * e non attorno a `request` perché è l'unico punto da cui passano TUTTE le
 * chiamate del client, anche i gruppi tipizzati (`client.tickets.*`, …), e
 * perché lì il corpo è già la stringa JSON, che si rimanda così com'è.
 */

export type ReauthReason = "reauth_required" | "second_factor_setup_required";

export interface ReauthRequest {
  /** Progressivo: il dialogo lo usa come `key`, così ogni richiesta parte pulita. */
  id: number;
  reason: ReauthReason;
}

interface Pending extends ReauthRequest {
  promise: Promise<boolean>;
  resolve: (ok: boolean) => void;
}

let pending: Pending | null = null;
let lastId = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/**
 * Chiede la riconferma al dialogo. Risolve `true` se l'utente l'ha completata,
 * `false` se l'ha annullata. Un solo dialogo alla volta: una seconda richiesta
 * mentre il primo è aperto riceve LA STESSA promessa. Senza un dialogo montato
 * (fuori dal layout autenticato) risolve subito `false`: l'errore originale
 * arriva al chiamante come prima.
 */
export function requestReauth(reason: ReauthReason): Promise<boolean> {
  if (pending) return pending.promise;
  if (listeners.size === 0) return Promise.resolve(false);
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  lastId += 1;
  pending = { id: lastId, reason, promise, resolve };
  notify();
  return promise;
}

/** Chiude il dialogo con l'esito: lo ricevono tutte le richieste in attesa. */
export function settleReauth(ok: boolean): void {
  const current = pending;
  if (!current) return;
  pending = null;
  notify();
  current.resolve(ok);
}

/** La richiesta aperta, o null. Identità stabile finché resta aperta. */
export function currentReauthRequest(): ReauthRequest | null {
  return pending;
}

/** Per `useSyncExternalStore`: il dialogo si iscrive al montaggio. */
export function subscribeReauth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Le rotte della riconferma stessa non si intercettano MAI: `POST /reauth`
 * risponde 403 `second_factor_setup_required` a chi non ha un'app, e aprire
 * il dialogo dal dialogo lo farebbe aspettare sé stesso.
 */
const REAUTH_PATH = "/api/me/security/reauth";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function isReauthPath(url: string): boolean {
  // La SPA chiama path relativi (stessa origine); un URL assoluto vale lo stesso.
  const path = url.startsWith("/") ? url : new URL(url).pathname;
  return path === REAUTH_PATH || path.startsWith(`${REAUTH_PATH}/`);
}

/** Il `code` di un 403 di riconferma, letto da una COPIA del corpo. */
async function reauthReason(response: Response): Promise<ReauthReason | null> {
  if (response.status !== 403) return null;
  const code = await response
    .clone()
    .json()
    .then((body: unknown) =>
      typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined,
    )
    .catch(() => undefined);
  return code === "reauth_required" || code === "second_factor_setup_required" ? code : null;
}

/**
 * Il `fetch` del client API della SPA. Su un 403 di riconferma apre il
 * dialogo e, confermato, rimanda la STESSA richiesta una volta sola (se anche
 * la ripetizione risponde 403, quello arriva al chiamante: niente secondo
 * dialogo). Annullato, la risposta originale torna intatta — il corpo è stato
 * letto da una copia — e il client ne fa l'`ApiError` di sempre.
 *
 * Il `fetch` globale si risolve a ogni chiamata, come nel client: i test lo
 * sostituiscono dopo l'import del modulo.
 */
export async function reauthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await globalThis.fetch(input, init);
  if (isReauthPath(urlOf(input))) return response;
  const reason = await reauthReason(response);
  if (!reason) return response;
  if (!(await requestReauth(reason))) return response;
  return globalThis.fetch(input, init);
}
