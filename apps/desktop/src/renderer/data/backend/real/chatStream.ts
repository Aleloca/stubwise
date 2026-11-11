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
import { loadClaudeExtras, sessionReadIn } from "./chatClaude";

// Lo stream dal vivo della Chat nella build app (integrazione area 4, fetta
// 1): UN SSE per canale (`GET /api/chat/channels/:id/stream`), CONDIVISO da
// chi ascolta il canale e dai suoi thread (le risposte arrivano col loro
// `threadRootId`, e la radice aggiornata). Sul web `fetch` col cookie e un
// watchdog dei ping; sul desktop `window.stubwise.openStream` del main
// (allowlist stretta, Bearer nel main, che ha il suo watchdog). Il main non
// riconnette: la ripresa la governa chi ascolta, dal cursore dell'ultimo
// frame (`?after=`), col backoff delle sessioni; alla ripresa si rilegge la
// pagina, perché ciò che è arrivato durante la caduta non va perso. Un
// 401/403/404 chiude: il canale non si vede più.
//
// Il server può ripetere messaggi già visti (una finestra di sovrapposizione
// per non perderne): «arrivato» è solo un messaggio più nuovo dell'ultimo
// visto, gli altri sono «cambiati». La vista del canale avvisa le letture solo
// quando cambia davvero.

type Chat = typeof Fake.chat;
type StreamId = ReturnType<Chat["channelStream"]>;
type Connection = "closed" | "limit";

export interface ChatStreamEnd {
  fatal?: boolean;
  status?: number;
  /** Il main ha già troppi stream per questa finestra. */
  limit?: boolean;
}
export interface ChatStreamHandlers {
  onFrame(frame: { messages: ChatStreamFrameMessage[]; cursor: string | null }): void;
  onClose(end: ChatStreamEnd | null): void;
}
/** Apre lo stream di `path` e restituisce come chiuderlo. */
export type ChatStreamTransport = (path: string, handlers: ChatStreamHandlers) => () => void;

const FATAL_STATUS = new Set([401, 403, 404]);
/** Il server manda `: ping` ogni 25 s: senza un byte per questo tempo la connessione è morta (come il main). */
export const CHAT_PING_TIMEOUT_MS = 60_000;

/** Il web: `fetch` streaming sulla stessa origine, col cookie di sessione, e il watchdog dei ping. */
const fetchTransport: ChatStreamTransport = (path, handlers) => {
  const abort = new AbortController();
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (end: ChatStreamEnd | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    handlers.onClose(end);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Nessun byte, neanche un ping: si chiude e chi ascolta riparte.
      abort.abort();
      finish({});
    }, CHAT_PING_TIMEOUT_MS);
  };
  void (async () => {
    arm();
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
        arm();
        const { frames, rest } = splitSseFrames(buffer + decoder.decode(value, { stream: true }));
        buffer = rest;
        for (const raw of frames) {
          const parsed = parseChatStreamFrame(raw);
          if (parsed.real) handlers.onFrame(parsed);
        }
      }
      finish({});
    } catch {
      finish(abort.signal.aborted && done ? null : {});
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
        ...(message.reason === "limit" ? { limit: true } : {}),
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

/**
 * Chi rinfresca le letture (`listenToChatChanges`, uno per app): resta
 * iscritto per tutta la vita dell'app, anche ai cambi di persona.
 */
const changeListeners = new Set<(channelId: string, change?: { messages?: boolean }) => void>();

/** Qualcosa è cambiato in un canale (un messaggio, la vista): le letture si rinfrescano. */
export const onChatChange: Chat["onChatChange"] = (fn) => {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
};

function notifyChange(channelId: string, change?: { messages?: boolean }): void {
  for (const fn of [...changeListeners]) fn(channelId, change);
}

// --- le connessioni, una per canale ------------------------------------------------

interface Listener {
  /** La radice di un thread, o `null` per il flusso del canale. */
  threadOf: string | null;
  onMessage: (m: ChatMessageView, mode: "append" | "update") => void;
  onConnection?: (connection: Connection) => void;
  /** Gli id già consegnati a questo ascoltatore. */
  seen: Set<string>;
}

interface ChannelConnection {
  channelId: string;
  listeners: Set<Listener>;
  close: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  cursor: string | null;
  failures: number;
  /** Da quando la connessione di adesso è aperta (per azzerare il backoff dopo un po'). */
  upSince: number;
  /** Il momento del messaggio più nuovo visto: «arrivato» è solo ciò che viene dopo. */
  latest: string | null;
  /** La vista del canale dell'ultimo frame `channel`, per avvisare solo se cambia. */
  channelSig: string | null;
  /**
   * Una ripresa dopo una caduta: alla prima risposta si recupera il buco.
   * `full` = caduta prima di avere un cursore: lo stream ricomincia da «ora»,
   * quindi il flusso si rilegge per intero (tutte le pagine lette).
   */
  resumed: false | "cursor" | "full";
  /** L'ordine di arrivo: ogni frame (o rilettura) di un messaggio ha un numero che cresce. */
  seq: number;
  /** L'ultimo numero consegnato per messaggio: uno più vecchio non si consegna. */
  versions: Map<string, number>;
  /** L'ultima forma arrivata per messaggio (la rilettura delle righe consegna questa). */
  rawById: Map<string, Parameters<typeof toMessage>[0]>;
  /** La lettura in coda alla finestra dei 4 s di una risposta di @Claude. */
  trailing: Map<string, ReturnType<typeof setTimeout>>;
}

const connections = new Map<string, ChannelConnection>();

/** Dopo quanto una connessione aperta conta come «su» anche senza messaggi. */
const STREAM_STABLE_MS = 30_000;

const keeps = (l: Listener, m: { id: string; threadRootId: string | null; alsoInChannel?: boolean }) =>
  l.threadOf ? m.id === l.threadOf || m.threadRootId === l.threadOf : m.threadRootId === null || m.alsoInChannel === true;

function deliver(
  conn: ChannelConnection,
  view: ChatMessageView,
  raw: { id: string; threadRootId: string | null; alsoInChannel?: boolean },
  seq: number,
) {
  // Un frame più vecchio dell'ultimo consegnato per questo messaggio non lo sovrascrive.
  if (seq < (conn.versions.get(raw.id) ?? 0)) return false;
  conn.versions.set(raw.id, seq);
  const fresh = conn.latest === null || view.createdAt > conn.latest;
  if (fresh) conn.latest = view.createdAt;
  let delivered = false;
  for (const l of [...conn.listeners]) {
    if (!keeps(l, raw)) continue;
    l.onMessage(view, fresh && !l.seen.has(view.id) ? "append" : "update");
    l.seen.add(view.id);
    delivered = true;
  }
  return delivered;
}

/**
 * Una risposta di @Claude arriva subito con ciò che si sa; le righe d'azione
 * (solo di chi ha chiamato) e i codici si leggono a parte, e quando cambiano
 * la risposta torna «cambiata» con loro.
 */
function arrive(conn: ChannelConnection, raw: Parameters<typeof toMessage>[0]): boolean {
  const seq = ++conn.seq;
  conn.rawById.set(raw.id, raw);
  return deliver(conn, toMessage(raw), raw, seq);
}

function withExtras(conn: ChannelConnection, id: string, fromFrame = true): void {
  const raw = conn.rawById.get(id);
  if (!raw) return;
  // Un frame dentro la finestra dei 4 s: una lettura alla sua fine (una sola),
  // così le righe arrivano anche se poi non arriva più niente.
  const wait = fromFrame ? sessionReadIn(raw) : null;
  if (wait !== null && !conn.trailing.has(id)) {
    conn.trailing.set(
      id,
      setTimeout(() => {
        conn.trailing.delete(id);
        if (connections.get(conn.channelId) === conn) withExtras(conn, id, false);
      }, wait),
    );
  }
  void loadClaudeExtras(raw).then(
    (changed) => {
      if (!changed || connections.get(conn.channelId) !== conn) return;
      // Si consegna l'ultima forma arrivata, non quella che ha fatto partire la lettura.
      const latest = conn.rawById.get(id) ?? raw;
      if (deliver(conn, toMessage(latest), latest, conn.versions.get(id) ?? 0)) notifyChange(conn.channelId);
    },
    () => undefined,
  );
}

/** Dopo una caduta: la pagina del canale (e i thread aperti), per ciò che si è perso. */
async function catchUp(conn: ChannelConnection, full: boolean): Promise<void> {
  try {
    // Senza cursore: tutte le pagine che chi guarda ha letto, non solo le ultime 50 radici.
    if (full) notifyChange(conn.channelId, { messages: true });
    else {
      const page = await appClient().chat.messages.page(conn.channelId, { limit: 50 });
      for (const m of page.items) arrive(conn, m);
    }
    for (const l of conn.listeners) {
      if (!l.threadOf) continue;
      const t = await appClient().chat.messages.thread(l.threadOf);
      for (const m of [t.root, ...t.replies]) {
        arrive(conn, m);
        withExtras(conn, m.id);
      }
    }
    notifyChange(conn.channelId);
  } catch {
    // La prossima lettura delle pagine lo recupera.
  }
}

function endAll(conn: ChannelConnection, connection: Connection) {
  const listeners = [...conn.listeners];
  drop(conn);
  for (const l of listeners) l.onConnection?.(connection);
}

function drop(conn: ChannelConnection) {
  clearTimeout(conn.timer);
  for (const t of conn.trailing.values()) clearTimeout(t);
  conn.trailing.clear();
  conn.close?.();
  conn.close = null;
  conn.listeners.clear();
  connections.delete(conn.channelId);
}

function connect(conn: ChannelConnection) {
  if (!connections.has(conn.channelId)) return;
  const path = chatStreamPath(conn.channelId, conn.cursor);
  if (!isAllowedChatStreamPath(path)) return endAll(conn, "closed");
  conn.upSince = Date.now();
  conn.close = currentTransport()(path, {
    onFrame: (frame) => {
      if (!connections.has(conn.channelId)) return;
      // Il backoff si azzera solo per una connessione davvero su: un frame di
      // messaggi, o 30 s di fila (un ping da solo non basta: cadere subito dopo
      // riporterebbe i tentativi a 1 s per sempre).
      if (frame.messages.some((m) => m.type === "messages") || Date.now() - conn.upSince >= STREAM_STABLE_MS) {
        conn.failures = 0;
      }
      if (frame.cursor) conn.cursor = frame.cursor;
      if (conn.resumed) {
        const full = conn.resumed === "full";
        conn.resumed = false;
        void catchUp(conn, full);
      }
      for (const message of frame.messages) {
        if (message.type === "channel") {
          const sig = JSON.stringify(message.channel);
          if (sig !== conn.channelSig) {
            if (conn.channelSig !== null) notifyChange(conn.channelId);
            conn.channelSig = sig;
          }
          continue;
        }
        let any = false;
        for (const m of message.messages) {
          any = arrive(conn, m) || any;
          withExtras(conn, m.id);
        }
        if (any) notifyChange(conn.channelId);
      }
    },
    onClose: (end) => {
      conn.close = null;
      if (!connections.has(conn.channelId) || end === null) return;
      if (end.limit) return endAll(conn, "limit");
      if (end.fatal) return endAll(conn, "closed");
      const delay = streamBackoffMs(conn.failures);
      conn.failures += 1;
      conn.resumed = conn.cursor === null ? "full" : "cursor";
      conn.timer = setTimeout(() => connect(conn), delay);
    },
  });
}

function attach(channelId: string, listener: Listener): () => void {
  let conn = connections.get(channelId);
  if (!conn) {
    conn = {
      channelId,
      listeners: new Set(),
      close: null,
      timer: undefined,
      cursor: null,
      failures: 0,
      upSince: 0,
      latest: null,
      channelSig: null,
      resumed: false,
      seq: 0,
      versions: new Map(),
      rawById: new Map(),
      trailing: new Map(),
    };
    connections.set(channelId, conn);
    conn.listeners.add(listener);
    connect(conn);
  } else conn.listeners.add(listener);
  const mine = conn;
  return () => {
    mine.listeners.delete(listener);
    if (mine.listeners.size === 0 && connections.get(channelId) === mine) drop(mine);
  };
}

// --- i flussi -------------------------------------------------------------------------

export const channelStream: Chat["channelStream"] = (channelId) => `chat:${channelId}` as StreamId;
export const threadStream: Chat["threadStream"] = (rootId) => `chat:thread:${rootId}` as StreamId;

/** Le iscrizioni aperte, per chiuderle tutte (cambio di persona, test). */
const live = new Set<() => void>();

/** Cambio di persona o test: si chiudono tutte le iscrizioni (non gli ascoltatori dei cambi, che sono dell'app). */
export function resetChatStreams(): void {
  for (const stop of [...live]) stop();
  live.clear();
  for (const conn of [...connections.values()]) drop(conn);
}

/** Quante connessioni sono aperte (una per canale). Solo nei test. */
export const openChatConnections = (): number => connections.size;

/**
 * Si iscrive a un flusso della Chat. Il flusso di un thread trova il canale
 * della radice (già letto, o lo chiede, riprovando col backoff su un errore
 * che non dice «non c'è») e si unisce alla connessione di quel canale.
 */
export const subscribeChat: Chat["subscribeChat"] = (streamId, onMessage, options = {}) => {
  const threadOf = streamId.startsWith("chat:thread:") ? streamId.slice("chat:thread:".length) : null;
  let stopped = false;
  let detach: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener: Listener = {
    threadOf,
    onMessage,
    seen: new Set(),
    onConnection: (connection) => {
      detach = null;
      stop();
      options.onConnection?.(connection);
    },
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    detach?.();
    detach = null;
    live.delete(stop);
  };
  live.add(stop);

  const start = (channelId: string) => {
    if (!stopped) detach = attach(channelId, listener);
  };
  const known = threadOf ? knownChannelOf(threadOf) : streamId.slice("chat:".length);
  if (known) start(known);
  else if (threadOf) {
    let failures = 0;
    const find = () => {
      void appClient()
        .chat.messages.get(threadOf)
        .then(
          (root) => start(root.channelId),
          (error: unknown) => {
            if (stopped) return;
            if (error instanceof ApiError && FATAL_STATUS.has(error.status)) return listener.onConnection?.("closed");
            timer = setTimeout(find, streamBackoffMs(failures++));
          },
        );
    };
    find();
  }
  return stop;
};
