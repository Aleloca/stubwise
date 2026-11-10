/**
 * A quale scheduler va il turno di una sessione a turni: il refinement
 * (`backlog_refine`) o la chat con Claude (`free`). Un kind diverso (una
 * versione nuova di `TURN_BASED_SESSION_KINDS` senza il suo scheduler) si
 * scarta con una riga nel log, invece di finire in uno scheduler che non lo
 * sa trattare. Il messaggio resta `pending`.
 */
export function turnDispatcher(targets: {
  refine: (sessionId: string) => void;
  chat: (sessionId: string) => void;
  log: (m: string) => void;
}): (sessionId: string, kind: string) => void {
  return (sessionId, kind) => {
    switch (kind) {
      case "backlog_refine":
        targets.refine(sessionId);
        return;
      case "free":
      // @Claude nella Chat (area 4, fetta 3): lo stesso scheduler della chat.
      case "chat_mention":
        targets.chat(sessionId);
        return;
      default:
        targets.log(`[stubwise-worker] turno della sessione ${sessionId} di kind «${kind}» senza scheduler: scartato`);
    }
  };
}
