/**
 * Lo stream dal vivo di una sessione dell'agente (`GET
 * /api/agent-sessions/:id/stream`, SSE), per l'app.
 *
 * Gemello di `apps/web/src/lib/agent-session-stream.ts`, con le STESSE regole
 * (formato dei frame, validazione, cursore, backoff, fatali, errori del
 * consumatore) e un trasporto diverso: React Native non ha né `EventSource` né
 * un `fetch` col corpo in streaming, ma il suo `XMLHttpRequest` consegna il
 * corpo a pezzi (`progress`) facendo CRESCERE `responseText`. Nessuna
 * dipendenza in più.
 *
 * **Le condizioni dell'XHR di RN 0.87** (`Libraries/Network/XMLHttpRequest.js`,
 * letto per il preflight del piano C, §4), tutte rispettate qui:
 * - gli handler (`onprogress` in testa) si assegnano PRIMA di `send()`: è lì
 *   che RN decide se chiedere al nativo i dati incrementali — dopo, tutto
 *   arriverebbe alla fine, cioè mai per uno stream che non finisce;
 * - anche il corpo di un errore (il JSON di un 401/404) passa da `progress`:
 *   i frame si leggono SOLO con `status === 200`;
 * - `abort()` emette `abort`, mai `load`/`error`/`timeout`: la riconnessione
 *   si aggancia a questi tre, così `close()` e la rotazione non ne programmano
 *   una seconda. In più ogni handler controlla di appartenere ancora alla
 *   connessione corrente: un evento tardivo di una connessione chiusa non fa
 *   niente;
 * - un XHR NUOVO per ogni connessione (dopo `abort` RN lo azzera);
 * - `responseText` è già testo decodificato — il nativo tiene da parte i byte
 *   di un carattere multibyte spezzato (carry data su iOS,
 *   `ProgressiveStringDecoder` su Android) — e si legge dall'ultimo indice
 *   consumato, senza ricopiarlo: un frame spezzato fra due `progress` resta
 *   nella coda non consumata finché non arriva il suo `\n\n`.
 *
 * **La rotazione.** `responseText` cresce senza fine su una sessione lunga:
 * oltre `rotateAfterBytes` (misurati sulla lunghezza del testo, non in byte
 * esatti) la connessione si chiude e si riapre SUBITO dal cursore, senza
 * backoff — ma solo quando la coda non consumata è vuota, mai a metà di un
 * frame (preflight M6): nessun evento perso, nessun doppione.
 *
 * **I parziali sono DELTA** (preflight P5/M6): quelli arrivati mentre non c'è
 * una connessione aperta — riconnessione, rotazione, pausa — non vengono
 * rimandati. Per questo ogni connessione nuova passa da `onStatus("open")`
 * (la rotazione compresa, via `reconnecting`): chi mostra il testo dal vivo
 * azzera lì i parziali, invece di accodare al vecchio testo un pezzo che ha un
 * buco in mezzo.
 *
 * **Quando si ferma.** 401/403/404 chiamano `onFatal` con l'`ApiError` della
 * risposta (col suo `code`: il 404 senza `code` di un server senza le rotte si
 * riconosce con `isAgentSessionsUnavailable`, quello della sessione è
 * `not_found`) e non riconnettono. Il 401 fa in più la stessa cosa del client
 * REST (`handleUnauthorized`: sessione pulita, «sessione scaduta»). Tutto il
 * resto — rete caduta, timeout, 5xx, server che chiude — riconnette col
 * backoff, che si azzera solo quando arriva un frame vero. `close()` abortisce
 * e cancella il timer, e non riconnette più.
 *
 * **Nei test** l'XHR si inietta con `createXhr` (vedi `test-utils/fake-xhr`).
 * Il default legge `XMLHttpRequest` globale al momento della connessione, non
 * all'import: un test di schermata può anche sostituire quello globale.
 */

import { createStubwiseClient, errorFromResponse, type ApiError } from "@stubwise/api-client";
import {
  agentSessionDetailSchema,
  agentSessionEventSchema,
  readerSchema,
  type AgentSessionDetail,
  type AgentSessionEvent,
  type Reader,
} from "@stubwise/shared";
import { handleUnauthorized } from "./client";
import { loadSession as loadStoredSession } from "./storage";

export type StreamMessage =
  | { type: "events"; events: Reader<AgentSessionEvent>[] }
  | { type: "partial"; segmentId: string; text: string }
  | { type: "session"; detail: Reader<AgentSessionDetail> };

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface AgentSessionStreamOptions {
  sessionId: string;
  /** Ultimo id già caricato via REST: mai null se la schermata ha eventi. */
  after: string | null;
  onMessage: (m: StreamMessage) => void;
  /** Ogni `open` è una connessione NUOVA: i parziali di prima vanno azzerati. */
  onStatus?: (s: StreamStatus) => void;
  /** 401/403/404: niente riconnessione. */
  onFatal?: (error: ApiError) => void;
  /** Default: la sessione salvata (`lib/storage`), riletta a ogni connessione. */
  loadSession?: () => Promise<{ baseUrl: string; token: string } | null>;
  /** Default `new XMLHttpRequest()`, per i test. */
  createXhr?: () => XMLHttpRequest;
  /** Attesa prima del tentativo `attempt` (0 = primo dopo una caduta). */
  backoffMs?: (attempt: number) => number;
  /** Oltre questa lunghezza di `responseText` la connessione si riapre. Default 1_000_000. */
  rotateAfterBytes?: number;
}

const FATAL_STATUSES = new Set([401, 403, 404]);
const DEFAULT_ROTATE_AFTER = 1_000_000;

const eventReader = readerSchema(agentSessionEventSchema);
const detailReader = readerSchema(agentSessionDetailSchema);

export function defaultBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

/** Solo per costruire il path: il client non fa nessuna richiesta. */
function streamUrl(baseUrl: string, sessionId: string, after: string | null): string {
  const client = createStubwiseClient({ baseUrl, getAuthHeader: () => null });
  return `${baseUrl}${client.agentSessions.streamPath(sessionId, after ?? undefined)}`;
}

export function openAgentSessionStream(opts: AgentSessionStreamOptions): { close(): void } {
  const loadSession = opts.loadSession ?? loadStoredSession;
  const createXhr = opts.createXhr ?? (() => new XMLHttpRequest());
  const backoffMs = opts.backoffMs ?? defaultBackoffMs;
  const rotateAfter = opts.rotateAfterBytes ?? DEFAULT_ROTATE_AFTER;
  let cursor = opts.after;
  let attempt = 0;
  let closed = false;
  let status: StreamStatus | null = null;
  let current: XMLHttpRequest | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let warnedSession = false;

  const setStatus = (next: StreamStatus) => {
    if (status === next) return;
    status = next;
    opts.onStatus?.(next);
  };

  /** Stacca e abortisce la connessione corrente: i suoi eventi tardivi non contano più. */
  const dropCurrent = () => {
    const xhr = current;
    current = null;
    xhr?.abort();
  };

  const stop = () => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    dropCurrent();
    setStatus("closed");
  };

  const scheduleReconnect = () => {
    if (closed) return;
    current = null;
    setStatus("reconnecting");
    const delay = backoffMs(attempt);
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, delay);
  };

  /**
   * Un errore del CONSUMATORE non è una caduta di rete: se fosse trattato come
   * tale, lo stream si riconnetterebbe da un cursore già oltre gli eventi che
   * il consumatore non ha elaborato — un buco silenzioso. Si riporta in
   * console e lo stream prosegue.
   */
  const deliver = (message: StreamMessage) => {
    try {
      opts.onMessage(message);
    } catch (error) {
      console.error("agent session stream: onMessage ha lanciato", error);
    }
  };

  /**
   * Gestisce un blocco fra due `\n\n` e dice se conteneva un frame VERO: una
   * riga `data:` col JSON di un messaggio riconosciuto. Un `: ping`, un blocco
   * vuoto, l'HTML di un proxy o un `data:` illeggibile no — e il backoff non si
   * azzera su di loro.
   */
  const handleFrame = (raw: string): boolean => {
    let real = false;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let value: unknown;
      try {
        value = JSON.parse(line.slice("data:".length).trim());
      } catch {
        continue; // frame rotto: scartato, lo stream continua
      }
      const parsed = parseMessage(value);
      if (parsed !== null) real = true;
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
      if (closed) return real; // `close()` chiamato da onMessage
    }
    return real;
  };

  const failFatally = async (xhr: XMLHttpRequest) => {
    const error = await errorFromResponse(new Response(xhr.responseText, { status: xhr.status }));
    if (closed) return;
    stop();
    if (xhr.status === 401) {
      // Stessa reazione del client REST; un suo errore non deve fermare onFatal.
      await handleUnauthorized().catch((e: unknown) =>
        console.error("agent session stream: handleUnauthorized ha lanciato", e),
      );
    }
    opts.onFatal?.(error);
  };

  const connect = async () => {
    if (closed) return;
    let session: { baseUrl: string; token: string } | null;
    try {
      session = await loadSession();
    } catch {
      scheduleReconnect();
      return;
    }
    if (closed) return;
    if (!session) {
      // Nessuna sessione salvata (logout): non c'è niente a cui collegarsi.
      stop();
      return;
    }

    const xhr = createXhr();
    current = xhr;
    let offset = 0;
    const isCurrent = () => !closed && current === xhr;

    const consume = () => {
      if (!isCurrent() || xhr.status !== 200) return;
      setStatus("open");
      const text = xhr.responseText;
      let sep: number;
      while ((sep = text.indexOf("\n\n", offset)) !== -1) {
        const raw = text.slice(offset, sep);
        offset = sep + 2;
        // Il backoff si azzera solo su un frame vero (non un ping, un blocco
        // vuoto o l'HTML di un proxy): un 200 che chiude subito deve
        // continuare a rallentare.
        if (handleFrame(raw)) attempt = 0;
        if (!isCurrent()) return;
      }
      // Rotazione: solo a coda vuota, cioè fra un frame e l'altro.
      if (offset >= rotateAfter && offset === text.length) {
        dropCurrent();
        setStatus("reconnecting");
        void connect();
      }
    };

    xhr.onreadystatechange = () => {
      // Gli header: lo stream è aperto anche prima del primo frame.
      if (isCurrent() && xhr.readyState >= 2 && xhr.status === 200) setStatus("open");
    };
    xhr.onprogress = consume;
    xhr.onload = () => {
      if (!isCurrent()) return;
      if (FATAL_STATUSES.has(xhr.status)) {
        current = null;
        void failFatally(xhr);
        return;
      }
      consume(); // l'ultimo pezzo può arrivare insieme alla fine
      if (isCurrent()) scheduleReconnect();
    };
    xhr.onerror = () => {
      if (isCurrent()) scheduleReconnect();
    };
    xhr.ontimeout = () => {
      if (isCurrent()) scheduleReconnect();
    };

    xhr.open("GET", streamUrl(session.baseUrl, opts.sessionId, cursor));
    xhr.setRequestHeader("Authorization", `Bearer ${session.token}`);
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.send();
  };

  setStatus("connecting");
  void connect();
  return { close: stop };
}

/**
 * Valida un messaggio dello stream (la stessa funzione del web). `lastId` è
 * l'id dell'ultimo evento del frame, anche se malformato; `message` è null
 * quando non resta niente da consegnare; `"invalid_session"` segnala un
 * dettaglio che non si parsa (lo si avvisa una volta per stream).
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
      if (typeof obj.segmentId !== "string" || typeof obj.text !== "string") return null;
      return {
        message: { type: "partial", segmentId: obj.segmentId, text: obj.text },
        lastId: null,
      };
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
