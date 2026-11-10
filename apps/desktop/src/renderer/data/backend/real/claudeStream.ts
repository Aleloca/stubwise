import { ApiError } from "@stubwise/api-client";
import {
  AGENT_STREAM_MAX_BYTES,
  agentStreamPath,
  applyPartial,
  clearPartialsFor,
  mergeEvents,
  isAllowedAgentStreamPath,
  parseAgentStreamFrame,
  splitSseFrames,
  streamBackoffMs,
  type AgentSessionDetail,
  type AgentSessionEvent,
  type ParsedAgentStreamFrame,
  type Reader,
  type SessionPlan,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type { ConversationEvent } from "../../types";
import { eventsOf, planOf } from "./claude";
import { appClient, session } from "./client";

// Lo stream dal vivo di una sessione di lavoro nella build app (integrazione
// area 3, fetta 3a). La parte pura (frame, backoff, percorso) è
// `@stubwise/shared/claude/sse`; qui la connessione e lo stato:
//
// - il TRASPORTO si sceglie (`setStreamTransport`): sul web `fetch` streaming
//   col cookie; sul desktop `window.stubwise.openStream` del main (3a.2), che
//   consegna i frame già letti e non riconnette; senza, un ripiego che
//   rilegge gli eventi dal cursore ogni pochi secondi;
// - lo stato di ogni sessione (eventi grezzi, parziali, dettaglio, cursore)
//   resta fra una connessione e l'altra: la ripresa riparte da `?after=` e
//   nessun evento arriva due volte né si perde (Review Focus 1);
// - al più `MAX_STREAMS` stream aperti per finestra (Review Focus 3): gli
//   altri aspettano un posto, e chiudere una vista libera il suo;
// - un 401, 403 o 404 chiude (`closed`): la sessione non si vede più
//   (Review Focus 2); ogni altra caduta è `reconnecting`, e l'hook riprova
//   dopo `reconnectDelay()`, che cresce finché non arriva un frame vero.

/** Come è finita una connessione (`null`: l'ha chiusa chi ascolta). */
export interface StreamEnd {
  /** Riaprire subito dal cursore (il tetto di byte): non è una caduta. */
  rotate?: boolean;
  /** Non riaprire: la sessione non si vede più, o la sessione dell'utente è finita. */
  fatal?: boolean;
  status?: number;
}

export interface StreamHandlers {
  onFrame(frame: ParsedAgentStreamFrame): void;
  onClose(end: StreamEnd | null): void;
}
/** Apre lo stream di `path` e restituisce come chiuderlo. */
export type StreamTransport = (path: string, handlers: StreamHandlers) => () => void;

/** Le risposte che chiudono per sempre: fuori, vietata, non visibile. */
const FATAL_STATUS = new Set([401, 403, 404]);

/** Il web: `fetch` streaming sulla stessa origine, col cookie di sessione. */
export const fetchTransport: StreamTransport = (path, handlers) => {
  const abort = new AbortController();
  let done = false;
  const finish = (end: StreamEnd | null) => {
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
      let bytes = 0;
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        bytes += value.byteLength;
        const { frames, rest } = splitSseFrames(buffer + decoder.decode(value, { stream: true }));
        buffer = rest;
        for (const raw of frames) handlers.onFrame(parseAgentStreamFrame(raw));
        // Oltre il tetto la connessione si riapre dal cursore (come l'app mobile).
        if (bytes > AGENT_STREAM_MAX_BYTES) {
          abort.abort();
          return finish({ rotate: true });
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

/**
 * Il desktop (3a.2): la connessione la apre il main col Bearer
 * (`window.stubwise.openStream`), che consegna i frame già letti e non
 * riconnette: la ripresa la governa chi ascolta.
 */
export const ipcTransport: StreamTransport = (path, handlers) => {
  const openStream = window.stubwise?.openStream;
  if (!openStream) {
    queueMicrotask(() => handlers.onClose({}));
    return () => undefined;
  }
  let done = false;
  const close = openStream(path, (message) => {
    if (done) return;
    if (message.type === "frame") {
      handlers.onFrame({
        messages: message.messages,
        lastId: message.lastId,
        invalidSession: message.invalidSession,
        real: message.messages.length > 0 || message.lastId !== null,
      });
    } else if (message.type === "end") {
      done = true;
      handlers.onClose({
        rotate: message.reason === "rotate",
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

/** Ogni quanto il ripiego senza stream rilegge gli eventi. */
const POLL_MS = 2_000;

/**
 * Il ripiego senza stream (un desktop senza `openStream`): rilegge dal
 * cursore gli eventi e il dettaglio, e li passa come frame.
 */
export const pollingTransport: StreamTransport = (path, handlers) => {
  const match = /^\/api\/agent-sessions\/([^/?]+)\/stream(?:\?after=(\d+))?$/.exec(path);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!match) {
    queueMicrotask(() => handlers.onClose({ fatal: true }));
    return () => undefined;
  }
  const id = decodeURIComponent(match[1]!);
  let after = match[2];
  const tick = async () => {
    try {
      const page = await appClient().agentSessions.events(id, { ...(after ? { after } : {}), limit: 500 });
      if (stopped) return;
      const detail = await appClient().agentSessions.get(id);
      if (stopped) return;
      const lastId = page.events.at(-1)?.id ?? null;
      if (lastId) after = lastId;
      handlers.onFrame({
        messages: [
          ...(page.events.length > 0 ? [{ type: "events" as const, events: page.events }] : []),
          { type: "session" as const, detail },
        ],
        lastId,
        real: true,
        invalidSession: false,
      });
      timer = setTimeout(() => void tick(), POLL_MS);
    } catch (error) {
      if (stopped) return;
      stopped = true;
      const status = error instanceof ApiError && error.status > 0 ? error.status : undefined;
      handlers.onClose({ ...(status ? { status } : {}), fatal: status !== undefined && FATAL_STATUS.has(status) });
    }
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};

let transport: StreamTransport | null = null;

/** Il trasporto degli stream: il desktop lo sostituisce con la porta IPC (3a.2). */
export function setStreamTransport(next: StreamTransport | null): void {
  transport = next;
}

function currentTransport(): StreamTransport {
  if (transport) return transport;
  // Sul desktop la rete passa dal main: lo stream lo apre lui; senza, il ripiego.
  if (!window.stubwise?.api) return fetchTransport;
  return window.stubwise.openStream ? ipcTransport : pollingTransport;
}

// --- stato delle sessioni ------------------------------------------------------------

interface SessionState {
  raw: Reader<AgentSessionEvent>[];
  partials: Record<string, string>;
  detail: Reader<AgentSessionDetail> | null;
  plan: SessionPlan | null;
  planRead: boolean;
  /** L'ultimo id ricevuto: il cursore della ripresa. */
  lastId: string | null;
}

/** Per persona e sessione: lo stato di una non passa a chi entra dopo. */
const sessions = new Map<string, SessionState>();
const keyOf = (id: string) => `${session.personId ?? ""}\u0000${id}`;

function stateFor(id: string): SessionState {
  const key = keyOf(id);
  let state = sessions.get(key);
  if (!state) {
    state = { raw: [], partials: {}, detail: null, plan: null, planRead: false, lastId: null };
    sessions.set(key, state);
  }
  return state;
}

// --- cambi di una conversazione -----------------------------------------------------

const changeListeners = new Set<(conversationId: string) => void>();

/** Una sessione ha cambiato stato (non a ogni pezzo dello stream): le letture si rinfrescano. */
export const onConversationChange: typeof Fake.onConversationChange = (fn) => {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
};

function notifyChange(id: string): void {
  for (const fn of [...changeListeners]) fn(id);
}

/** Ciò che di un dettaglio fa cambiare le letture: stato, pausa, attesa, domande aperte. */
const signatureOf = (d: Reader<AgentSessionDetail>) =>
  JSON.stringify([d.state, d.outcome, d.paused, d.waitsOnViewer, d.questions.map((q) => q.answered)]);

// --- tetto degli stream ---------------------------------------------------------------

/** Quanti stream si tengono aperti insieme (come il main del desktop). */
export const MAX_STREAMS = 8;
let open = 0;
const waiting: (() => void)[] = [];

function acquire(start: () => void): () => void {
  let state: "waiting" | "open" | "released" = "waiting";
  const go = () => {
    if (state !== "waiting") return;
    state = "open";
    open += 1;
    start();
  };
  if (open < MAX_STREAMS) go();
  else waiting.push(go);
  return () => {
    if (state === "open") {
      open -= 1;
      state = "released";
      waiting.shift()?.();
    } else if (state === "waiting") {
      state = "released";
      const i = waiting.indexOf(go);
      if (i !== -1) waiting.splice(i, 1);
    }
  };
}

// --- ripresa --------------------------------------------------------------------------

/** Le cadute di fila senza un frame vero: il backoff cresce con loro. */
let failures = 0;

export const reconnectDelay: typeof Fake.reconnectDelay = () => streamBackoffMs(Math.max(0, failures - 1));

/**
 * Al cambio di persona: lo stato delle sessioni lette non passa a chi entra.
 * Gli stream aperti li chiudono le viste che li hanno aperti (la chiave è per persona).
 */
export function forgetStreams(): void {
  sessions.clear();
  failures = 0;
}

/** Solo nei test: anche il conteggio degli stream aperti e la coda. */
export function resetStreamsForTests(): void {
  forgetStreams();
  open = 0;
  waiting.length = 0;
}

/** Un evento nuovo entra al suo istante (il piano ha la data di quando è arrivato); uno noto si sostituisce. */
export const mergeStreamEvent: typeof Fake.mergeStreamEvent = (events, event) => {
  const index = events.findIndex((e) => e.id === event.id);
  if (index !== -1) {
    const next = events.slice();
    next[index] = event;
    return next;
  }
  let at = events.length;
  while (at > 0 && events[at - 1]!.at > event.at) at -= 1;
  return [...events.slice(0, at), event, ...events.slice(at)];
};

// --- subscribe ------------------------------------------------------------------------

/**
 * Ascolta una sessione: prima tutto il flusso già noto, poi quello dal vivo.
 * `afterEventId` (la ripresa dell'hook) non serve qui: il cursore vero è
 * quello degli eventi grezzi, tenuto nello stato della sessione.
 */
export const subscribe: typeof Fake.subscribe = (conversationId, onEvent, options = {}) => {
  const state = stateFor(conversationId);
  const emitted = new Map<string, string>();
  let stopped = false;
  let closeStream: (() => void) | null = null;

  const emit = () => {
    if (!state.detail || stopped) return;
    for (const e of eventsOf(state.detail, state.raw, state.partials, state.plan)) {
      const json = JSON.stringify(e);
      const before = emitted.get(e.id);
      if (before === json) continue;
      emitted.set(e.id, json);
      onEvent(e as ConversationEvent, before === undefined ? "append" : "update");
    }
  };

  const readPlan = () => {
    if (state.planRead || !state.detail) return;
    state.planRead = true;
    void planOf(state.detail).then((plan) => {
      state.plan = plan;
      emit();
    });
  };

  const onFrame = (parsed: ParsedAgentStreamFrame) => {
    if (stopped) return;
    if (parsed.real) failures = 0;
    if (parsed.lastId) state.lastId = parsed.lastId;
    for (const m of parsed.messages) {
      if (m.type === "events") {
        state.raw = mergeEvents(state.raw, m.events);
        state.partials = clearPartialsFor(state.partials, m.events);
      } else if (m.type === "partial") {
        state.partials = applyPartial(state.partials, m.segmentId, m.text);
      } else {
        const changed = state.detail !== null && signatureOf(state.detail) !== signatureOf(m.detail);
        state.detail = m.detail;
        readPlan();
        if (changed) notifyChange(conversationId);
      }
    }
    emit();
  };

  const connect = () => {
    const path = agentStreamPath(conversationId, state.lastId);
    // Il main del desktop lo rifiuterebbe comunque: un percorso fuori allowlist non parte.
    if (!isAllowedAgentStreamPath(path)) {
      queueMicrotask(() => {
        if (stopped) return;
        stopped = true;
        release();
        options.onConnection?.("closed");
      });
      return;
    }
    closeStream = currentTransport()(path, {
      onFrame,
      onClose: (end) => {
        if (stopped || end === null) return;
        if (end.rotate) return connect();
        stopped = true;
        release();
        if (end.fatal) {
          options.onConnection?.("closed");
          return;
        }
        failures += 1;
        options.onConnection?.("reconnecting");
      },
    });
  };

  // Quello che si sa già arriva subito (una ripresa, un'altra vista sulla stessa sessione).
  emit();
  const release = acquire(() => {
    if (!stopped) connect();
  });

  return () => {
    if (stopped) return;
    stopped = true;
    closeStream?.();
    release();
  };
};
