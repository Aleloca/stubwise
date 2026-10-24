import { useEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { hasModKey } from "../../platform/platform";
import { useToast } from "../../tasks-ui/Toast";

/** Gli elementi di una task nel corpo della pagina: riga, carta, barra della timeline. */
const TASK_ITEMS = "[data-task-row], [data-card], [data-timeline-item]";
/** Gli stessi, più la testata del pannello: dove il fuoco «sta su una task». */
const TASK_HOLDERS = `${TASK_ITEMS}, [data-task-detail]`;

function codeOf(el: Element): string | null {
  return (
    el.getAttribute("data-task-row") ??
    el.getAttribute("data-card") ??
    el.getAttribute("data-timeline-item") ??
    el.getAttribute("data-task-detail")
  );
}

/** Si sta scrivendo: la lettera va al campo, non alla pagina. */
export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset"].includes(target.type);
  }
  return false;
}

/** Un dialogo modale o un menu aperto si tengono la tastiera. */
function somethingOnTop(): boolean {
  return document.querySelector('[aria-modal="true"], [role="menu"]') !== null;
}

/**
 * Tastiera delle pagine di task (shape brief §6):
 *
 * - **J / K**, col pannello di dettaglio aperto: la task dopo / prima
 *   nell'ordine in cui la vista la mostra (elenco coi suoi gruppi e il suo
 *   ordinamento, board colonna per colonna, timeline riga per riga). L'ordine
 *   si legge dal corpo della pagina, così è sempre quello che si vede. Alle
 *   estremità resta dov'è.
 * - **⌘C** (Ctrl+C fuori da mac): copia il codice della task col fuoco — una
 *   riga, una carta, una barra, il pannello — o, se il fuoco non è su una
 *   task, di quella aperta nel pannello. Con del testo selezionato la copia
 *   resta quella del sistema.
 *
 * Niente scatta scrivendo in un campo né con un dialogo o un menu aperti.
 */
export function useTaskKeys({
  body,
  openCode,
  onOpen,
}: {
  /** Il corpo della pagina (la vista corrente). */
  body: RefObject<HTMLElement | null>;
  /** La task aperta nel pannello (`?task=`). */
  openCode: string | undefined;
  onOpen: (code: string) => void;
}): void {
  const { t } = useTranslation();
  const toast = useToast();
  // Un solo listener: legge i valori correnti da qui.
  const current = useRef({ openCode, onOpen });
  useEffect(() => {
    current.current = { openCode, onOpen };
  }, [openCode, onOpen]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || typing(e.target) || somethingOnTop()) return;
      const { openCode: open, onOpen: go } = current.current;
      const key = e.key.toLowerCase();

      if (key === "c" && hasModKey(e) && !e.shiftKey) {
        if ((window.getSelection()?.toString() ?? "") !== "") return;
        const holder =
          document.activeElement instanceof Element
            ? document.activeElement.closest(TASK_HOLDERS)
            : null;
        const code = (holder && codeOf(holder)) ?? open;
        if (!code) return;
        e.preventDefault();
        void navigator.clipboard?.writeText(code).catch(() => {});
        toast.show(t("taskDetail.copied", { code }));
        return;
      }

      if ((key !== "j" && key !== "k") || e.metaKey || e.ctrlKey || e.shiftKey || !open) return;
      const codes = [...(body.current?.querySelectorAll(TASK_ITEMS) ?? [])]
        .map(codeOf)
        .filter((c): c is string => !!c);
      const at = codes.indexOf(open);
      // La task aperta non è nella vista (filtrata via): J parte dalla prima.
      const next = at === -1 ? codes[0] : codes[key === "j" ? at + 1 : at - 1];
      if (!next || next === open) return;
      e.preventDefault();
      go(next);
      // Resta visibile nella vista accanto.
      body.current
        ?.querySelector(
          `[data-task-row="${next}"], [data-card="${next}"], [data-timeline-item="${next}"]`,
        )
        ?.scrollIntoView?.({ block: "nearest" });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [body, t, toast]);
}
