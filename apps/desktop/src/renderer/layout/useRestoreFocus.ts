import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Il fuoco torna dov'era alla chiusura di un pannello o dialog. `remember`
 * va chiamato PRIMA di aprire (salva l'elemento a fuoco); alla chiusura,
 * dopo lo smontaggio, il fuoco torna a quell'elemento se c'è ancora.
 */
export function useRestoreFocus(open: boolean): () => void {
  const target = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  const remember = useCallback(() => {
    const active = document.activeElement;
    target.current = active instanceof HTMLElement ? active : null;
  }, []);

  useLayoutEffect(() => {
    if (wasOpen.current && !open) {
      const el = target.current;
      target.current = null;
      if (el?.isConnected) el.focus();
    }
    wasOpen.current = open;
  }, [open]);

  return remember;
}
