import { useEffect, useState } from "react";

/**
 * `Date.now()` che si rinnova ogni `intervalMs`, per far avanzare le durate a
 * schermo. Gemello di `apps/web/src/lib/elapsed.ts`; `elapsedParts` sta in
 * `@stubwise/shared` (una regola sola per web e app).
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
