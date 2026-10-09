import { useEffect, useState } from "react";

/** `Date.now()` che si rinnova ogni `intervalMs`, per far avanzare le durate a schermo. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
