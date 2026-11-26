import { CHAT_CHANNEL_NOTIFY } from "./service.js";

/**
 * Il fan-out delle NOTIFY della Chat agli stream SSE dei canali (area 4,
 * fetta 1), come `agent-session-bus.ts`: UNA LISTEN per processo, i
 * sottoscrittori per canale. Il payload porta solo l'id del canale: chi
 * riceve rilegge con la sua visibilità. Senza bus (i test), gli stream
 * restano serviti dal solo poll.
 */
export interface ChatBus {
  subscribe(channelId: string, cb: () => void): () => void;
}

export const NOOP_CHAT_BUS: ChatBus = { subscribe: () => () => undefined };

export async function createChatBus(
  listen: (channel: string, cb: (payload: string) => void) => Promise<unknown>,
): Promise<ChatBus> {
  const subs = new Map<string, Set<() => void>>();
  await listen(CHAT_CHANNEL_NOTIFY, (payload) => {
    let channelId: unknown;
    try {
      channelId = (JSON.parse(payload) as { channelId?: unknown }).channelId;
    } catch {
      return;
    }
    if (typeof channelId !== "string") return;
    for (const cb of subs.get(channelId) ?? []) {
      try {
        cb();
      } catch {
        // Un sottoscrittore che lancia non ferma gli altri.
      }
    }
  });
  return {
    subscribe(channelId, cb) {
      const set = subs.get(channelId) ?? new Set();
      set.add(cb);
      subs.set(channelId, set);
      return () => {
        set.delete(cb);
        if (set.size === 0) subs.delete(channelId);
      };
    },
  };
}
