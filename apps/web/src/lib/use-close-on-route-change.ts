import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";

/**
 * Chiama `close()` ogni volta che cambia il pathname della rotta corrente. Usato
 * dai drawer (nav app-shell, albero/chat Docs) per chiudersi automaticamente
 * quando l'utente naviga a un'altra pagina. La selezione del solo `pathname`
 * evita ri-render inutili sui cambi di search param.
 */
export function useCloseOnRouteChange(close: () => void): void {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    close();
  }, [pathname, close]);
}
