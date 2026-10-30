import { useCallback, useSyncExternalStore } from "react";

// La riconferma (area 9a, shape `entry.md`): ogni azione delicata passa da
// `useReauth()`. Se la funzione risponde `reauth_required`, si apre il
// dialogo «Confirm it's you» (`ReauthDialog`, montato una volta
// nell'`AppLayout`); col codice giusto l'azione riparte DA SOLA con gli
// stessi argomenti (la chiusura li conserva) e il chiamante riceve il suo
// esito di sempre. Chiuso il dialogo, l'azione non è ripartita e il
// chiamante riceve `reauth_cancelled`: niente è cambiato. Nessuna pagina
// scrive un dialogo suo.

/** Cosa riceve il chiamante quando chi agisce chiude il dialogo senza riconfermarsi. */
export interface ReauthCancelled {
  ok: false;
  error: "reauth_cancelled";
}

export interface ReauthRequest {
  /**
   * L'azione in parole, da completare «To {{action}}, …» («change Marco
   * Bellini's instance role»): il dialogo la nomina [IN 3]. Senza, la frase
   * generica.
   */
  action?: string;
  /** Il controllo che aveva aperto l'azione: alla chiusura il fuoco torna lì. */
  opener: HTMLElement | null;
  resolve: (confirmed: boolean) => void;
}

let current: ReauthRequest | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** La richiesta aperta, per l'host del dialogo. */
export function useReauthRequest(): ReauthRequest | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Chiude la richiesta aperta con il suo esito (lo chiama il dialogo). */
export function settleReauth(confirmed: boolean): void {
  const request = current;
  if (!request) return;
  current = null;
  emit();
  request.resolve(confirmed);
}

/** Apre il dialogo e aspetta: `true` riconfermato, `false` chiuso. */
function requestReauth(action: string | undefined, opener: HTMLElement | null): Promise<boolean> {
  // Una richiesta già aperta (due azioni insieme) si chiude come annullata:
  // il dialogo è uno, e nomina l'azione più recente.
  if (current) settleReauth(false);
  return new Promise((resolve) => {
    current = { action, opener, resolve };
    emit();
  });
}

const isReauthRequired = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as { ok?: unknown }).ok === false &&
  (value as { error?: unknown }).error === "reauth_required";

/**
 * Esegue un'azione delicata con la riconferma: `run(() => mutation.mutateAsync(args), { action })`.
 * L'esito è quello dell'azione (anche un rifiuto, da mostrare dove è
 * partita), oppure `reauth_cancelled`.
 */
export function useReauth() {
  return useCallback(async function run<R>(
    call: () => Promise<R>,
    options: { action?: string } = {},
  ): Promise<R | ReauthCancelled> {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = await call();
    if (!isReauthRequired(first)) return first;
    const confirmed = await requestReauth(options.action, opener);
    if (!confirmed) return { ok: false, error: "reauth_cancelled" };
    // La riconferma è appena aperta: l'azione riparte una volta sola. Un
    // secondo `reauth_required` (impossibile dentro la finestra) torna così com'è.
    return call();
  }, []);
}

/** SOLO TEST: nessuna richiesta aperta fra un test e l'altro. */
export function resetReauthForTest(): void {
  current = null;
  emit();
}
