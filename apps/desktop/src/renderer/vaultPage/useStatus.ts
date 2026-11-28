import { useCallback, useEffect, useState } from "react";
import { vaultStatus, type SetupStatus } from "./api";

/** Lo stato della cassaforte per la pagina, riletto a richiesta (dopo ogni scrittura). */
export function useVaultStatus() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(async () => {
    try {
      setStatus(await vaultStatus());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { status, error, reload };
}
