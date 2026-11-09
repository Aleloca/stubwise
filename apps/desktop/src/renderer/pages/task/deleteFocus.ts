import { TASK_ITEMS } from "../tasks/useTaskKeys";

// Dove va il fuoco dopo «Elimina task» (area 10a, shape task-delete.md
// [TD 4]): sulla riga che prende il posto della task nel corpo della pagina
// (la successiva; se era l'ultima, la precedente); senza righe, sull'h1.
// La riga si sceglie PRIMA di eliminare, quando c'è ancora; il fuoco ci va
// quando la lista riletta non mostra più la task.

/** Gli elementi di una task fuori dal pannello: righe, carte, barre della timeline. */
function items(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(TASK_ITEMS)].filter(
    (el) => !el.closest("[data-detail-panel]"),
  );
}

const codeOf = (el: Element) =>
  el.getAttribute("data-task-row") ??
  el.getAttribute("data-card") ??
  el.getAttribute("data-timeline-item");

/** Il codice della riga che prenderà il posto di `code`; `null` se non ce n'è. */
export function rowAfter(code: string): string | null {
  const codes = items().map(codeOf);
  const at = codes.indexOf(code);
  if (at === -1) return null;
  return codes[at + 1] ?? codes[at - 1] ?? null;
}

/** Ciò che prende il fuoco in una riga: il bottone che la apre, o la carta stessa. */
function focusable(code: string): HTMLElement | null {
  const el = items().find((x) => codeOf(x) === code);
  return el ? (el.querySelector<HTMLElement>("[data-row-open]") ?? el) : null;
}

/** L'h1 della pagina (fuori dal pannello), raggiungibile dal fuoco. */
function heading(): HTMLElement | null {
  const h1 = [...document.querySelectorAll<HTMLElement>("h1")].find(
    (h) => !h.closest("[data-detail-panel], [role='dialog']"),
  );
  if (h1 && !h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
  return h1 ?? null;
}

/** Quanti giri aspettare che la lista riletta tolga la riga (circa un secondo). */
const TRIES = 40;

/**
 * Porta il fuoco su `next` (o sull'h1) appena la riga di `code` non c'è più.
 * Se la lista non la toglie in tempo, il fuoco va comunque: mai sul body.
 */
export function focusAfterDelete(code: string, next: string | null): void {
  let tries = 0;
  const step = () => {
    // Aspetta anche che il pannello (col suo dialogo) sia smontato: il loro
    // ritorno del fuoco al «⋯» non deve venire dopo il nostro.
    const gone =
      !items().some((x) => codeOf(x) === code) &&
      !document.querySelector(`[data-task-detail="${code}"]`);
    if (!gone && tries++ < TRIES) {
      setTimeout(step, 25);
      return;
    }
    // Una riga scelta ma sparita anch'essa: l'h1.
    ((next ? focusable(next) : null) ?? heading())?.focus();
  };
  step();
}
