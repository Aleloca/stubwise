/**
 * Chiusura per inattività della cassaforte (design «Il modello delle
 * chiavi»: aperta per 15 minuti di inattività, poi si richiude). Senza
 * React: il `VaultProvider` lo avvia quando la cassaforte si apre e lo ferma
 * quando si chiude.
 */

/** 15 minuti senza interazione: poi la chiave privata si butta. */
export const VAULT_IDLE_MS = 15 * 60 * 1000;

/**
 * Cosa conta come interazione: tasti, click/tocchi, rotella e scorrimento.
 * Il solo movimento del mouse no — passarci sopra con la scheda in vista non
 * è usarla.
 */
export const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

/**
 * Chiama `onIdle` dopo `timeoutMs` senza interazioni su `target`; ogni
 * interazione fa ripartire il conto. Restituisce la funzione che lo ferma
 * (toglie i listener e il timer). `onIdle` scatta una volta sola.
 */
export function startIdleTimer(
  onIdle: () => void,
  timeoutMs: number = VAULT_IDLE_MS,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const event of ACTIVITY_EVENTS) target.removeEventListener(event, reset, listenerOptions);
  };

  function reset() {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      stop();
      onIdle();
    }, timeoutMs);
  }

  // `capture`: lo scorrimento di un pannello interno non risale fino a window.
  const listenerOptions = { capture: true, passive: true } as const;
  for (const event of ACTIVITY_EVENTS) target.addEventListener(event, reset, listenerOptions);
  reset();
  return stop;
}
