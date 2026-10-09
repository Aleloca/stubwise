/**
 * Lo stream dal vivo di una sessione dell'agente (`GET
 * /api/agent-sessions/:id/stream`, SSE).
 *
 * Si legge con un `fetch` in streaming e non con `EventSource`: serve
 * `credentials: "include"` col cookie di sessione, il controllo dello status
 * PRIMA di leggere il corpo (il server risponde 404 in JSON, `{ code, message }`,
 * prima del hijack) e una riconnessione che decide da sé da quale cursore
 * ripartire — `EventSource` riproverebbe col suo URL originale.
 *
 * Formato dei frame (lo stesso di `postDocChatStream`/`backlog-chat-api.ts`):
 * righe `data: {json}` separate da `\n\n`. I keep-alive `: ping` non sono righe
 * `data:` e si scartano da soli. Ogni messaggio viene PARSATO con gli stessi
 * schemi del client REST (`readerSchema`), così chi consuma lo stream riceve
 * la stessa forma (`Reader<…>`) di `getAgentSession`/`getAgentSessionEvents`:
 * - `events`: ogni evento validato da solo, quelli malformati scartati (come un
 *   JSON rotto); il cursore avanza comunque all'ultimo `id` del frame;
 * - `partial`: `segmentId`/`text` devono essere stringhe;
 * - `session`: il dettaglio intero (porta `inputs`, `questions`, `canWrite`
 *   aggiornati), scartato se non si parsa.
 *
 * **Il cursore (`after`).** La prima connessione riparte da `opts.after`,
 * l'ultimo id che la pagina ha già caricato via REST; ogni riconnessione da
 * quello dell'ultimo evento ricevuto. Senza `after` il server NON rimanda
 * tutto: rimanda gli ULTIMI 200 eventi (`STREAM_PAGE`) — che per una sessione
 * enorme sono comunque un salto, e per una sessione appena caricata sono
 * doppioni. Con `after` arrivano esattamente gli eventi successivi, compresi
 * quelli nati fra la prima pagina REST e l'apertura dello stream: nessun buco.
 * La riconnessione di questo modulo non produce doppioni da sé (passa sempre
 * l'ultimo id consegnato); la sovrapposizione fra la prima pagina REST e lo
 * stream — ad esempio con `after: null` su una sessione senza eventi caricati —
 * la toglie `mergeEvents` (Task 4), che deduplica per `id`.
 *
 * **Quando si ferma.** 401/403/404 chiamano `onFatal` e non riconnettono (una
 * sessione non più visibile, un login scaduto, o un server senza la rotta —
 * 404 SENZA `code`, vedi `isAgentSessionsUnavailable`): riprovare darebbe solo
 * un loop. Tutto il resto — rete caduta, proxy che chiude, laptop sospeso, 5xx
 * — riconnette col backoff. `close()` annulla il fetch in corso e il timer del
 * backoff con un `AbortController`, e non riconnette più.
 */

import {
  agentSessionDetailSchema,
  agentSessionEventSchema,
  readerSchema,
  type AgentSessionDetail,
  type AgentSessionEvent,
  type Reader,
} from "@stubwise/shared";
// `errorFromResponse` legge `{ code, message }` da una Response: lo stesso
// ApiError di tutte le altre chiamate.
import { errorFromResponse } from "@stubwise/api-client";
import { agentSessionStreamPath, type ApiError } from "./api";

export type StreamMessage =
  | { type: "events"; events: Reader<AgentSessionEvent>[] }
  | { type: "partial"; segmentId: string; text: string }
  | { type: "session"; detail: Reader<AgentSessionDetail> };

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface AgentSessionStreamOptions {
  sessionId: string;
  /** Ultimo id già caricato: mai null se la pagina ha eventi. */
  after: string | null;
  onMessage: (m: StreamMessage) => void;
  onStatus?: (s: StreamStatus) => void;
  /** 401/403/404: niente riconnessione. */
  onFatal?: (e: ApiError) => void;
  /** Default `globalThis.fetch`, per i test. */
  fetchImpl?: typeof fetch;
  /** Attesa prima del tentativo `attempt` (0 = primo dopo una caduta). */
  backoffMs?: (attempt: number) => number;
}

const FATAL_STATUSES = new Set([401, 403, 404]);

const eventReader = readerSchema(agentSessionEventSchema);
const detailReader = readerSchema(agentSessionDetailSchema);

export function defaultBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

export function openAgentSessionStream(opts: AgentSessionStreamOptions): { close(): void } {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const backoffMs = opts.backoffMs ?? defaultBackoffMs;
  let cursor = opts.after;
  let attempt = 0;
  let closed = false;
  let status: StreamStatus | null = null;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let warnedSession = false;

  const setStatus = (next: StreamStatus) => {
    if (status === next) return;
    status = next;
    opts.onStatus?.(next);
  };

  const stop = () => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
    setStatus("closed");
  };

  const scheduleReconnect = () => {
    if (closed) return;
    setStatus("reconnecting");
    const delay = backoffMs(attempt);
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, delay);
  };

  /**
   * Un errore del CONSUMATORE non è una caduta di rete: se finisse nel catch
   * della lettura, lo stream si riconnetterebbe da un cursore già oltre gli
   * eventi che il consumatore non ha elaborato — un buco silenzioso. Si
   * riporta in console e lo stream prosegue.
   */
  const deliver = (message: StreamMessage) => {
    try {
      opts.onMessage(message);
    } catch (error) {
      console.error("agent session stream: onMessage ha lanciato", error);
    }
  };

  const handleFrame = (raw: string) => {
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let message: unknown;
      try {
        message = JSON.parse(line.slice("data:".length).trim());
      } catch {
        continue; // frame rotto: scartato, lo stream continua
      }
      const parsed = parseMessage(message);
      if (parsed === "invalid_session") {
        if (!warnedSession) {
          warnedSession = true;
          console.warn("agent session stream: dettaglio `session` non valido, scartato");
        }
        continue;
      }
      if (!parsed) continue;
      if (parsed.lastId !== null) cursor = parsed.lastId;
      if (parsed.message) deliver(parsed.message);
      if (closed) return; // `close()` chiamato da onMessage
    }
  };

  const connect = async () => {
    if (closed) return;
    const abort = new AbortController();
    controller = abort;
    let response: Response;
    try {
      response = await fetchImpl(agentSessionStreamPath(opts.sessionId, cursor ?? undefined), {
        method: "GET",
        credentials: "include",
        headers: { accept: "text/event-stream" },
        signal: abort.signal,
      });
    } catch {
      if (!closed) scheduleReconnect();
      return;
    }
    if (closed) return;
    if (!response.ok) {
      if (FATAL_STATUSES.has(response.status)) {
        const error = await errorFromResponse(response);
        if (closed) return;
        stop();
        opts.onFatal?.(error);
        return;
      }
      scheduleReconnect();
      return;
    }
    if (!response.body) {
      scheduleReconnect();
      return;
    }

    setStatus("open");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break; // connessione caduta a metà (o annullata da `close()`)
      }
      if (closed) return;
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        // Il backoff si azzera solo quando arriva un frame vero: un 200 che
        // chiude subito (proxy, server che si riavvia) deve continuare a
        // rallentare, non ripartire ogni volta da 1 s.
        attempt = 0;
        handleFrame(raw);
        if (closed) return;
      }
    }
    if (!closed) scheduleReconnect();
  };

  setStatus("connecting");
  void connect();
  return { close: stop };
}

/**
 * Valida un messaggio dello stream. `lastId` è l'id dell'ultimo evento del
 * frame, anche se malformato (il server non lo rimanderebbe comunque diverso);
 * `message` è null quando non resta niente da consegnare; `"invalid_session"`
 * segnala un dettaglio che non si parsa (lo si avvisa una volta per stream).
 */
function parseMessage(
  value: unknown,
): { message: StreamMessage | null; lastId: string | null } | "invalid_session" | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  switch (obj.type) {
    case "events": {
      if (!Array.isArray(obj.events)) return null;
      const events: Reader<AgentSessionEvent>[] = [];
      let lastId: string | null = null;
      for (const raw of obj.events) {
        const id = (raw as { id?: unknown } | null)?.id;
        if (typeof id === "string") lastId = id;
        const parsed = eventReader.safeParse(raw);
        if (parsed.success) events.push(parsed.data);
      }
      return { message: events.length > 0 ? { type: "events", events } : null, lastId };
    }
    case "partial": {
      // Il server manda `{ type, segmentId, text }` (la sessione è quella dello stream).
      if (typeof obj.segmentId !== "string" || typeof obj.text !== "string") return null;
      return { message: { type: "partial", segmentId: obj.segmentId, text: obj.text }, lastId: null };
    }
    case "session": {
      const parsed = detailReader.safeParse(obj.detail);
      if (!parsed.success) return "invalid_session";
      return { message: { type: "session", detail: parsed.data }, lastId: null };
    }
    default:
      return null;
  }
}
