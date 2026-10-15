import { TURN_BASED_SESSION_KINDS, type AgentSessionKind } from "@stubwise/shared";

/**
 * Il tempo da mostrare per una sessione NON conclusa conta dall'ultimo evento
 * invece che da `startedAt`? Sì per una sessione A TURNI (`backlog_refine`)
 * ferma fra un turno e l'altro (`idle`) o col turno in coda (`queued`): la
 * riga in `agent_sessions` è una per voce e `startedAt` è il PRIMO avvio di
 * sempre, quindi «da 6 h» direbbe che l'agente lavora da sei ore. Lì si mostra
 * quando è successo l'ultimo evento, come per una conclusa. Gemella di
 * `countsSinceLastEvent` in `apps/mobile/src/lib/elapsed.ts`.
 */
export function countsSinceLastEvent(session: { kind: string; state: string }): boolean {
  return (
    (session.state === "idle" || session.state === "queued") &&
    TURN_BASED_SESSION_KINDS.has(session.kind as AgentSessionKind)
  );
}
