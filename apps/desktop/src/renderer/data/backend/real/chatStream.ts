import { ApiError } from "@stubwise/api-client";
import {
  chatStreamPath,
  isAllowedChatStreamPath,
  parseChatStreamFrame,
  splitSseFrames,
  streamBackoffMs,
  type ChatStreamFrameMessage,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type { ChatMessageView } from "../../types";
import { appClient } from "./client";
import { knownChannelOf, toMessage } from "./chat";

// Lo stream dal vivo della Chat nella build app (integrazione area 4, fetta
// 1): UN SSE per canale (`GET /api/chat/channels/:id/stream`), che porta
// anche le risposte dei thread (col loro `threadRootId`) e la radice
// aggiornata. Il flusso di un thread ascolta quello del suo canale e tiene la
// radice e le sue risposte. Sul web `fetch` col cookie; sul desktop
// `window.stubwise.openStream` del main (allowlist stretta, Bearer nel main).
// Il main non riconnette: la ripresa la governa chi ascolta, dal cursore
// dell'ultimo frame (`?after=`), col backoff delle sessioni. Un 401/403/404
// chiude: il canale non si vede più.

type Chat = typeof Fake.chat;
type StreamId = ReturnType<Chat["channelStream"]>;

export interface ChatStreamEnd {
  fatal?: boolean;
  status?: number;
}
export interface ChatStreamHandlers {
  onFrame(frame: { messages: ChatStreamFrameMessage[]; cursor: string | null }): void;
  onClose(end: ChatStreamEnd | null): void;
}
/** Apre lo stream di `path` e restituisce come chiuderlo. */
export type ChatStreamTransport = (path: string, handlers: ChatStreamHandlers) => () => void;

const FATAL_STATUS = new Set([401, 403, 404]);

/** Il web: `fetch` streaming sulla stessa origine, col cookie di sessione. */
const fetchTransport: ChatStreamTransport = (path, handlers) => {
  const abort = new AbortController();
  let done = false;
  const finish = (end: ChatStreamEnd | null) => {
    if (done) return;
    done = true;
    handlers.onClose(end);
  };
  void (async () => {
    try {
      const res = await globalThis.fetch(path, {
        credentials: "include",
        headers: { accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) return finish({ status: res.status, fatal: FATAL_STATUS.has(res.status) });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        const { frames, rest } = splitSseFrames(buffer + decoder.decode(value, { stream: true }));
        buffer = rest;
        for (const raw of frames) {
          const parsed = parseChatStreamFrame(raw);
          if (parsed.real) handlers.onFrame(parsed);
        }
      }
      finish({});
    } catch {
      finish(abort.signal.aborted ? null : {});
    }
  })();
  return () => {
    abort.abort();
    finish(null);
  };
};

/** Il desktop: la connessione la apre il main, che consegna i frame già letti (`chatFrame`). */
const ipcTransport: ChatStreamTransport = (path, handlers) => {
  const openStream = window.stubwise?.openStream;
  if (!openStream) {
    queueMicrotask(() => handlers.onClose({}));
    return () => undefined;
  }
  let done = false;
  const close = openStream(path, (message) => {
    if (done) return;
    if (message.type === "chatFrame") handlers.onFrame({ messages: message.messages, cursor: message.cursor });
    else if (message.type === "end") {
      done = true;
      handlers.onClose({
        fatal: message.fatal || (message.status !== undefined && FATAL_STATUS.has(message.status)),
        ...(message.status !== undefined ? { status: message.status } : {}),
      });
    }
  });
  return () => {
    done = true;
    close();
  };
};

let transport: ChatStreamTransport | null = null;

/** Solo nei test: un trasporto finto (`null` torna a quello vero). */
export function setChatStreamTransport(next: ChatStreamTransport | null): void {
  transport = next;
}

function currentTransport(): ChatStreamTransport {
  if (transport) return transport;
  return window.stubwise?.api ? ipcTransport : fetchTransport;
}

// --- i cambi, per le letture ------------------------------------------------------

const changeListeners = new Set<(channelId: string) => void>();

/** Qualcosa è cambiato in un canale (un messaggio, la vista): le letture si rinfrescano. */
export const onChatChange: Chat["onChatChange"] = (fn) => {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
};

function notifyChange(channelId: string): void {
  for (const fn of [...changeListeners]) fn(channelId);
}

// --- i flussi -------------------------------------------------------------------------

export const channelStream: Chat["channelStream"] = (channelId) => `chat:${channelId}` as StreamId;
export const threadStream: Chat["threadStream"] = (rootId) => `chat:thread:${rootId}` as StreamId;

/** Le iscrizioni aperte, per chiuderle tutte (cambio di persona, test). */
const live = new Set<() => void>();

/** Cambio di persona o test: si chiudono tutte le iscrizioni. */
export function resetChatStreams(): void {
  for (const stop of [...live]) stop();
  live.clear();
  changeListeners.clear();
}

/**
 * Si iscrive a un flusso della Chat. Il flusso di un thread trova il canale
 * della radice (già letto, o lo chiede) e ascolta quello.
 */
export const subscribeChat: Chat["subscribeChat"] = (streamId, onMessage, options = {}) => {
  const threadOf = streamId.startsWith("chat:thread:") ? streamId.slice("chat:thread:".length) : null;
  const known = threadOf ? knownChannelOf(threadOf) : streamId.slice("chat:".length);
  let stopped = false;
  let close: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor: string | null = null;
  let failures = 0;
  const seen = new Set<string>();

  const keep = (m: { id: string; threadRootId: string | null }) =>
    threadOf ? m.id === threadOf || m.threadRootId === threadOf : m.threadRootId === null;

  const closed = () => {
    stop();
    options.onConnection?.("closed");
  };

  const connect = (channelId: string) => {
    if (stopped) return;
    const path = chatStreamPath(channelId, cursor);
    if (!isAllowedChatStreamPath(path)) return closed();
    close = currentTransport()(path, {
      onFrame: (frame) => {
        if (stopped) return;
        failures = 0;
        if (frame.cursor) cursor = frame.cursor;
        for (const message of frame.messages) {
          if (message.type === "channel") {
            notifyChange(channelId);
            continue;
          }
          for (const m of message.messages) {
            if (!keep(m)) continue;
            const view: ChatMessageView = toMessage(m);
            onMessage(view, seen.has(m.id) ? "update" : "append");
            seen.add(m.id);
          }
          notifyChange(channelId);
        }
      },
      onClose: (end) => {
        close = null;
        if (stopped || end === null) return;
        if (end.fatal) return closed();
        const delay = streamBackoffMs(failures);
        failures += 1;
        timer = setTimeout(() => connect(channelId), delay);
      },
    });
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    close?.();
    close = null;
    live.delete(stop);
  };
  live.add(stop);

  if (known) connect(known);
  else if (threadOf) {
    void appClient()
      .chat.messages.get(threadOf)
      .then(
        (root) => connect(root.channelId),
        (error: unknown) => {
          if (error instanceof ApiError && FATAL_STATUS.has(error.status)) closed();
          else closed();
        },
      );
  }
  return stop;
};
