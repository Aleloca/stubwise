import { useRef, useState } from "react";

/**
 * Copia negli appunti un valore, con fallback a selezione manuale quando la
 * Clipboard API è assente (contesto non sicuro, tipico self-hosted su http) o
 * rifiuta la scrittura (permessi negati): in quel caso NIENTE falso "Copiato",
 * si seleziona il testo dell'elemento agganciato (`targetRef`) e si alza
 * `manualHint` per invitare a copiare a mano. Estratto dal pannello chiave del
 * monitoraggio e dalla rivelazione dei Personal Access Token, che condividevano
 * verbatim questa logica su dati one-shot irrecuperabili.
 */
export function useCopyWithFallback<T extends HTMLElement = HTMLPreElement>(value: string) {
  const [copied, setCopied] = useState(false);
  const [manualHint, setManualHint] = useState(false);
  const targetRef = useRef<T>(null);

  /** Seleziona il contenuto dell'elemento agganciato (fallback manuale). */
  function selectTarget() {
    const node = targetRef.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function copy() {
    // Clipboard API assente: writeText su undefined non lancerebbe con
    // l'optional chaining e "Copiato" mentirebbe su un dato one-shot.
    if (!navigator.clipboard) {
      selectTarget();
      setManualHint(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // writeText rifiutata (permessi): stesso fallback manuale.
      selectTarget();
      setManualHint(true);
    }
  }

  return { copied, manualHint, copy, targetRef };
}
