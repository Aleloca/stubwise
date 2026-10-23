import { useCallback, useSyncExternalStore } from "react";

/** Vero finché la media query corrisponde; si aggiorna ai cambi. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Letto al momento: per decisioni prese dentro un effetto, non in render. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}
