import { createStubwiseClient } from "@stubwise/api-client";
import type { StubwiseClient } from "@stubwise/api-client";
import { clearSession, loadSession } from "./storage";

/**
 * Ascoltatori dell'evento "sessione scaduta" (401). Un piccolo pub/sub scritto
 * a mano invece di `DeviceEventEmitter`/`NativeEventEmitter` di React Native:
 * questo evento è puramente JS (nessun modulo nativo coinvolto), e un
 * emitter minimale è più facile da testare — non serve inizializzare un
 * ambiente RN per verificarlo.
 */
type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

/** Si iscrive all'evento "sessione scaduta". Ritorna la funzione per disiscriversi. */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

function emitSessionExpired(): void {
  sessionExpiredListeners.forEach((listener) => listener());
}

/**
 * `fetch` che osserva ogni risposta e, su 401, pulisce la sessione ed emette
 * l'evento — PRIMA di restituire la risposta al chiamante. L'ordine conta:
 * chi ascolta `onSessionExpired` (il provider di autenticazione, che
 * riporta l'app alla schermata di login) deve poter contare sul fatto che
 * il Keychain sia già vuoto quando l'evento arriva, così un `loadSession()`
 * eseguito dentro il listener non rivede il token appena invalidato.
 *
 * Passa attraverso invariata qualunque altra risposta (compreso ogni altro
 * status non-2xx): la costruzione dell'`ApiError` resta compito del
 * pacchetto `@stubwise/api-client`, non di questo wrapper.
 */
function createSessionAwareFetch(): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 401) {
      await clearSession();
      emitSessionExpired();
    }
    return response;
  };
}

/**
 * Costruisce un client Stubwise per una `baseUrl` data, con l'header di
 * autorizzazione letto dal Keychain a OGNI richiesta (non catturato una
 * volta sola): è la stessa ragione per cui `getAuthHeader` è una funzione e
 * non una stringa in `@stubwise/api-client` — il token può cambiare (login
 * su un'altra istanza, logout) fra due chiamate.
 *
 * Usabile SIA prima del login (durante il login stesso non c'è ancora una
 * sessione salvata, quindi `getAuthHeader` risolve a `undefined` e la
 * richiesta parte senza header — corretto per `POST /api/auth/mobile-login`,
 * che non vuole un Bearer) SIA dopo, quando la sessione salvata da
 * `saveSession` fornisce il token.
 */
export function createClient(baseUrl: string): StubwiseClient {
  return createStubwiseClient({
    baseUrl,
    fetch: createSessionAwareFetch(),
    getAuthHeader: async () => {
      const session = await loadSession();
      return session ? `Bearer ${session.token}` : null;
    },
  });
}

/**
 * Costruisce il client dalla sessione salvata, o `null` se non ce n'è una —
 * il caso dell'app appena installata o dopo un logout. `baseUrl` la
 * scriveva {@link import("./storage").saveSession} al login: è così che il
 * client "conosce" l'istanza senza doverla chiedere di nuovo a ogni avvio.
 */
export async function createClientFromSession(): Promise<StubwiseClient | null> {
  const session = await loadSession();
  return session ? createClient(session.baseUrl) : null;
}
