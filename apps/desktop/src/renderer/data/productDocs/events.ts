import { onStoreReset } from "../store";
import type { ProductPageEvent } from "../types";

// Gli avvisi di una pagina di prodotto (area 11a, Task 5): chi è iscritto a
// una pagina sa che è cambiata (corpo, presenza, commenti) o che non c'è più,
// e ricarica. L'avviso dice solo COSA è cambiato, mai il contenuto: chi
// ricarica rilegge con i suoi permessi (R-G5).
//
// Sta in un modulo a sé, senza import dalle scritture, perché lo usano sia
// `writes.ts` e `comments.ts` (che avvisano) sia `presence.ts` (che scrive
// col copione attraverso `writes.ts`): con l'emettitore dentro
// `presence.ts` il giro di import scatterebbe al caricamento.

const pageListeners = new Map<string, Set<(event: ProductPageEvent) => void>>();
const presenceListeners = new Set<(pageId: string) => void>();

// Le iscrizioni di prima di un ripristino non ricevono avvisi dello stato
// nuovo (come gli stream delle conversazioni). Chi aspetta le presenze
// (`onProductPresence`, il 11b) resta: si registra una volta.
onStoreReset(() => pageListeners.clear());

/** Chiama un ascoltatore senza che un suo errore fermi gli altri o chi scrive. */
function call(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error("productDocs: a listener failed", error);
  }
}

/** Avvisa gli iscritti della pagina; `presence` sveglia anche `onProductPresence`. */
export function emitProductPage(pageId: string, event: ProductPageEvent): void {
  for (const fn of [...(pageListeners.get(pageId) ?? [])]) call(() => fn(event));
  if (event === "presence") emitPresenceChanged(pageId);
}

/** Una presenza della pagina è cambiata (anche quando la pagina se ne va). */
export function emitPresenceChanged(pageId: string): void {
  for (const fn of [...presenceListeners]) call(() => fn(pageId));
}

export function subscribeProductPage(
  pageId: string,
  cb: (event: ProductPageEvent) => void,
): () => void {
  const set = pageListeners.get(pageId) ?? new Set();
  set.add(cb);
  pageListeners.set(pageId, set);
  return () => {
    set.delete(cb);
    if (set.size === 0 && pageListeners.get(pageId) === set) pageListeners.delete(pageId);
  };
}

// --- le domande di Claude (11b) -------------------------------------------------

const questionListeners = new Set<() => void>();

/**
 * Una domanda di Claude è nata o ha avuto risposta, in qualunque pagina:
 * «Decide» della Home ricarica (`useClaudeDecisions`). Non dice quale: chi
 * ricarica rilegge con i suoi permessi (R-G5). Come `onProductPresence`, gli
 * ascoltatori restano a un ripristino (sono gli hook montati).
 */
export function emitProductQuestionsChanged(): void {
  for (const fn of [...questionListeners]) call(fn);
}

export function onProductQuestionsChanged(fn: () => void): () => void {
  questionListeners.add(fn);
  return () => questionListeners.delete(fn);
}

// --- la prima versione di Claude (11b, Task 6) -----------------------------------

const firstVersionListeners = new Set<(projectId: string) => void>();

/**
 * La prima versione di uno spazio è cambiata: una pagina scritta, la fine,
 * una pagina accettata, l'annullamento. Dice solo il progetto: chi ricarica
 * rilegge con i suoi permessi (R-G5). Gli ascoltatori restano a un
 * ripristino, come `onProductQuestionsChanged`.
 */
export function emitProductFirstVersion(projectId: string): void {
  for (const fn of [...firstVersionListeners]) call(() => fn(projectId));
}

export function onProductFirstVersion(fn: (projectId: string) => void): () => void {
  firstVersionListeners.add(fn);
  return () => firstVersionListeners.delete(fn);
}

/** Si sveglia quando una presenza cambia (il 11b ci riprova quando la sezione si libera). */
export function onProductPresence(fn: (pageId: string) => void): () => void {
  presenceListeners.add(fn);
  return () => presenceListeners.delete(fn);
}
