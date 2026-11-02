// «Per conto di» (area 10a, Task 3): il segno delle scritture che Claude fa
// per una persona. È una foglia: non importa niente del livello dati, così
// ogni writer (registro, attività, notifiche, eliminazione) lo legge senza
// portarsi dietro lo store.
//
// Il segno vive SOLO qui, in modulo: nessuna funzione pubblica lo accetta
// come argomento (test in `via.test.ts`). Lo accende `runAsClaude` attorno
// a un gruppo di scritture SINCRONE, e le scritture lo leggono con
// `currentVia()`: chi agisce resta la persona (`actorId`, `authorId`), il
// segno dice solo che l'ha fatto Claude per lei.

export interface ViaClaude {
  /** L'azione di Claude che sta girando (`state.claudeActions`). */
  actionId: string;
  /** Solo dentro un «Annulla»: l'azione che si sta annullando. */
  undoOfActionId: string | null;
}

let current: ViaClaude | null = null;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

/**
 * Esegue `fn` col segno; `fn` è sincrona (lancia se restituisce una
 * Promise): dopo un'attesa le scritture uscirebbero dal segno, o ci
 * entrerebbero quelle di un altro. Il segno di prima torna sempre, anche
 * dopo un errore (annidare è lecito: vale il più interno).
 */
export function runAsClaude<R>(mark: ViaClaude, fn: () => R): R {
  const previous = current;
  current = Object.freeze({ actionId: mark.actionId, undoOfActionId: mark.undoOfActionId });
  try {
    const result = fn();
    if (isThenable(result)) {
      // La parte dopo la prima attesa non c'è più per nessuno: niente rifiuti in giro.
      Promise.resolve(result).catch(() => undefined);
      throw new Error("runAsClaude: fn must be synchronous");
    }
    return result;
  } finally {
    current = previous;
  }
}

/** Il segno dell'azione in corso, `null` fuori da `runAsClaude`. */
export function currentVia(): ViaClaude | null {
  return current;
}
