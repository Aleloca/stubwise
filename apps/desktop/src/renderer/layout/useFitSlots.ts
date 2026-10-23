import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * Quanti elementi interi, di passo `pitch` (altezza + spazio fra due), entrano
 * nell'altezza della zona `ref`, tolto `inset` (il padding verticale totale).
 * `null` finché la zona non ha un'altezza misurabile (prima del layout, o in
 * un ambiente senza layout come i test): chi la usa allora mostra tutto.
 * Si ricalcola al ridimensionamento della zona e della finestra.
 */
export function useFitSlots(
  ref: RefObject<HTMLElement | null>,
  { pitch, gap, inset }: { pitch: number; gap: number; inset: number },
): number | null {
  const [slots, setSlots] = useState<number | null>(null);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const height = el.clientHeight;
    const next = height > 0 ? Math.max(0, Math.floor((height - inset + gap) / pitch)) : null;
    setSlots((prev) => (prev === next ? prev : next));
  }, [ref, pitch, gap, inset]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    window.addEventListener("resize", update);
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => update()) : undefined;
    observer?.observe(el);
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [ref, update]);

  return slots;
}
