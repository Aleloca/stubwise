import { AGENT_SESSION_EVENTS_CHANNEL, AGENT_SESSION_PARTIAL_CHANNEL } from "@stubwise/shared";

/**
 * Fan-out delle notifiche Postgres del worker ai flussi SSE aperti (design
 * §5.3). Una sola LISTEN per canale per processo server, condivisa da tutte le
 * sessioni: ogni messaggio va SOLO ai sottoscrittori della sessione che nomina.
 *
 * Il canale degli eventi porta soltanto l'id della sessione: il contenuto si
 * rilegge dalla tabella (col filtro di visibilità di chi guarda), mai dal
 * payload della NOTIFY, che ha un tetto di 8000 byte e non passa da nessun
 * controllo. I parziali sono l'unico contenuto che viaggia nel payload: non si
 * salvano, e il worker li tronca già a monte.
 */
export type BusMessage =
  | { kind: "events"; sessionId: string }
  | { kind: "partial"; sessionId: string; segmentId: string; text: string };

export interface AgentSessionBus {
  subscribe(sessionId: string, cb: (m: BusMessage) => void): () => void;
}

/** Bus inerte (test e app senza LISTEN): lo stream resta servito dal poll. */
export const NOOP_BUS: AgentSessionBus = { subscribe: () => () => undefined };

function parse(payload: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(payload);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function createAgentSessionBus(
  listen: (channel: string, cb: (payload: string) => void) => Promise<unknown>,
): Promise<AgentSessionBus> {
  const subs = new Map<string, Set<(m: BusMessage) => void>>();
  const emit = (m: BusMessage) => {
    for (const cb of subs.get(m.sessionId) ?? []) {
      try {
        cb(m);
      } catch {
        // Un sottoscrittore che lancia non ferma gli altri né la LISTEN.
      }
    }
  };
  await listen(AGENT_SESSION_EVENTS_CHANNEL, (payload) => {
    const p = parse(payload);
    // Solo l'id: qualunque altro campo del payload è ignorato apposta.
    if (typeof p?.["sessionId"] === "string") emit({ kind: "events", sessionId: p["sessionId"] });
  });
  await listen(AGENT_SESSION_PARTIAL_CHANNEL, (payload) => {
    const p = parse(payload);
    if (typeof p?.["sessionId"] === "string" && typeof p["text"] === "string") {
      emit({
        kind: "partial",
        sessionId: p["sessionId"],
        segmentId: typeof p["segmentId"] === "string" ? p["segmentId"] : "",
        text: p["text"],
      });
    }
  });
  return {
    subscribe(sessionId, cb) {
      let set = subs.get(sessionId);
      if (!set) {
        set = new Set();
        subs.set(sessionId, set);
      }
      set.add(cb);
      return () => {
        const current = subs.get(sessionId);
        if (!current) return;
        current.delete(cb);
        if (current.size === 0) subs.delete(sessionId);
      };
    },
  };
}
