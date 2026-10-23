import { useSyncExternalStore } from "react";
import { onBeforePersonaChange } from "../../data/session";

// Le risposte date da «Decide» partono dopo una finestra in cui si possono
// annullare (shape home.md §6: «Answered · Undo» per 5 s). Una risposta
// mandata non si ritira — avvisa già chi ha chiesto — quindi l'«Undo» vero è
// non mandarla ancora. Archivio di modulo, non stato del blocco: se la Home
// si smonta (si apre un'altra pagina) la risposta parte lo stesso allo
// scadere, e intanto la voce resta nascosta anche tornando sulla Home.
// Se si cambia persona dentro la finestra, le risposte partono SUBITO, con
// la sessione ancora di chi le ha date, e un eventuale errore non si dice
// alla persona nuova (non è suo).

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
/** Le risposte ancora nella finestra: il timer e come mandarle subito. */
const waiting = new Map<number, (quiet: boolean) => void>();

/** Lascia cadere le risposte in attesa senza mandarle (test). */
export function clearPendingAnswers(): void {
  for (const t of waiting.keys()) window.clearTimeout(t);
  waiting.clear();
  set(new Set());
}

/** Manda subito tutte le risposte ancora nella finestra, senza dire gli errori. */
export function flushPendingAnswers(): void {
  for (const [timer, fire] of [...waiting]) {
    window.clearTimeout(timer);
    fire(true);
  }
}

onBeforePersonaChange(flushPendingAnswers);

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
 * `send` deve far partire la chiamata in modo sincrono (legge la sessione).
 */
export function deferAnswer(
  id: string,
  send: () => Promise<unknown>,
  onFail: () => void,
): () => void {
  set(new Set([...pending, id]));
  const release = () => set(new Set([...pending].filter((x) => x !== id)));
  let sent = false;
  const fire = (quiet: boolean) => {
    waiting.delete(timer);
    sent = true;
    send().then(release, () => {
      release();
      if (!quiet) onFail();
    });
  };
  const timer = window.setTimeout(() => fire(false), windowMs);
  waiting.set(timer, fire);
  return () => {
    if (sent) return;
    waiting.delete(timer);
    window.clearTimeout(timer);
    release();
  };
}
