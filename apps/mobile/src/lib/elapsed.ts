import { TURN_BASED_SESSION_KINDS, type AgentSessionKind } from "@stubwise/shared";
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

/**
 * Il tempo da mostrare per una sessione NON conclusa conta dall'ultimo evento
 * invece che da `startedAt`? Sì per una sessione A TURNI (`backlog_refine`)
 * ferma fra un turno e l'altro (`idle`) o col turno in coda (`queued`): la
 * riga in `agent_sessions` è una per voce e `startedAt` è il PRIMO avvio di
 * sempre, quindi «da 6 h» direbbe che l'agente lavora da sei ore. Lì si mostra
 * quando è successo l'ultimo evento, come per una conclusa. Gemella di
 * `apps/web/src/components/agent-session/session-clock.ts`.
 */
export function countsSinceLastEvent(session: { kind: string; state: string }): boolean {
  return (
    (session.state === "idle" || session.state === "queued") &&
    TURN_BASED_SESSION_KINDS.has(session.kind as AgentSessionKind)
  );
}
