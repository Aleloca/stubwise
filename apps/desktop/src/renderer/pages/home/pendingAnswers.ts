import { useSyncExternalStore } from "react";

// Le risposte date da «Decide» partono dopo una finestra in cui si possono
// annullare (shape home.md §6: «Answered · Undo» per 5 s). Una risposta
// mandata non si ritira — avvisa già chi ha chiesto — quindi l'«Undo» vero è
// non mandarla ancora. Archivio di modulo, non stato del blocco: se la Home
// si smonta (si apre un'altra pagina) la risposta parte lo stesso allo
// scadere, e intanto la voce resta nascosta anche tornando sulla Home.

let windowMs = 5000;

/** La finestra dell'«Undo» in ms (i test la accorciano); `null` torna ai 5 s. */
export function setUndoWindow(ms: number | null): void {
  windowMs = ms ?? 5000;
}

export function undoWindow(): number {
  return windowMs;
}

let pending: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const timers = new Set<number>();

/** Lascia cadere le risposte in attesa senza mandarle (test). */
export function clearPendingAnswers(): void {
  for (const t of timers) window.clearTimeout(t);
  timers.clear();
  set(new Set());
}

function set(next: ReadonlySet<string>) {
  pending = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Le decisioni con una risposta in attesa di partire o in volo: la Home le nasconde. */
export function usePendingAnswers(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => pending);
}

/**
 * Nasconde subito la decisione e manda la risposta allo scadere della
 * finestra. Restituisce l'annullamento (che vale finché non è partita).
 * La voce resta nascosta finché il «server» non ha risposto: se ce la fa,
 * le letture ricaricate non la contengono più; se no torna e `onFail` lo dice.
 */
export function deferAnswer(
  id: string,
  send: () => Promise<unknown>,
  onFail: () => void,
): () => void {
  set(new Set([...pending, id]));
  const release = () => set(new Set([...pending].filter((x) => x !== id)));
  let sent = false;
  const timer = window.setTimeout(() => {
    timers.delete(timer);
    sent = true;
    send().then(release, () => {
      release();
      onFail();
    });
  }, windowMs);
  timers.add(timer);
  return () => {
    if (sent) return;
    timers.delete(timer);
    window.clearTimeout(timer);
    release();
  };
}
