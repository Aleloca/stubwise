import { useCallback, useEffect, useState, type RefObject } from "react";

export interface ScrollCues {
  above: boolean;
  below: boolean;
}

/**
 * Dice se in una zona scorrevole c'è altro contenuto sopra o sotto la parte
 * visibile. Si ricalcola allo scroll, al ridimensionamento e quando cambia
 * `contentKey` (es. il numero di elementi).
 */
export function useScrollCues(ref: RefObject<HTMLElement | null>, contentKey: unknown): ScrollCues {
  const [cues, setCues] = useState<ScrollCues>({ above: false, below: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const above = el.scrollTop > 0;
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setCues((prev) => (prev.above === above && prev.below === below ? prev : { above, below }));
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => update()) : undefined;
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [ref, update]);

  useEffect(update, [update, contentKey]);

  return cues;
}
