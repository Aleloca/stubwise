import {
  AGENT_STREAM_MAX_BYTES,
  endsSession,
  isAllowedAgentStreamPath,
  isAllowedChatStreamPath,
  isAllowedDocsChatStreamPath,
  isAllowedProductLiveStreamPath,
  parseDocsChatFrame,
  parseAgentStreamFrame,
  parseChatStreamFrame,
  splitSseFrames,
  type AgentStreamMessage,
  type ChatStreamFrameMessage,
  type DocsChatStreamEvent,
} from "@stubwise/shared";

// Lo stream dal vivo delle sessioni dell'agente nell'app desktop (integrazione
// area 3, fetta 3a). `api:request` bufferizza la risposta intera, quindi non
// regge uno stream: qui c'è un canale apposta. Il renderer chiede
// `api:stream-open` col percorso; il main lo controlla con l'ALLOWLIST stretta
// di `@stubwise/shared` (solo `/api/agent-sessions/:uuid/stream?after=n`), apre
// la connessione col Bearer (il token non lascia mai il main), legge i frame
// col modulo condiviso e li manda su una `MessagePortMain` (`MessageChannelMain`)
// passata al preload.
//
// Il main NON riconnette: quando la connessione finisce manda `end` e chiude
// la porta. La ripresa la governa il renderer, dal cursore `?after=` dell'ultimo
// evento ricevuto (il suo `mergeEvents` toglie i doppioni), così il cursore
// vive in UN posto. `fatal` dice se ripartire ha senso: 401/403/404, percorso
// rifiutato o tetto raggiunto no; rete caduta, timeout dei ping, rotazione a
// 1 MB e 5xx sì (col backoff di `streamBackoffMs`).

/** Il frame più grande che si inoltra (una revisione con molte operazioni): 1 MB. */
const PRODUCT_LIVE_FRAME_MAX = 1_000_000;

/** Quanti stream aperti per finestra, al più. */
export const MAX_STREAMS_PER_WINDOW = 8;
/** Il server manda `: ping` ogni 25 s: senza un byte per questo tempo la connessione è morta. */
export const PING_TIMEOUT_MS = 60_000;

export type StreamEndReason =
  | "closed"
  | "network"
  | "timeout"
  | "rotate"
  | "http"
  | "redirect"
  | "unauthorized"
  | "rejected"
  | "limit";

/** Ciò che il main manda sulla porta. `frame` è il risultato di `parseAgentStreamFrame`, solo per i frame veri. */
export type StreamPortMessage =
  | { type: "open" }
  | { type: "frame"; messages: AgentStreamMessage[]; lastId: string | null; real: boolean; invalidSession: boolean }
  /** Area 4: un frame dello stream di un canale della Chat (`parseChatStreamFrame`). */
  | { type: "chatFrame"; messages: ChatStreamFrameMessage[]; cursor: string | null }
  /** Area 11, F4: un frame dello stream dal vivo di una pagina di prodotto, com'è (testo SSE senza i ping). */
  | { type: "productFrame"; raw: string }
  /** Area 11, F4: un frame troppo grande, scartato: il renderer rilegge la pagina. */
  | { type: "productFrameDropped" }
  /** Area 6, F3: un pezzo della bozza di Claude per la Posta (`parseMailDraftFrame`). */
  | { type: "mailDraft"; event: MailDraftStreamEvent }
  /** Lotto 7, §2: i frame della chat dei Docs (`parseDocsChatFrame` di shared). */
  | { type: "docsChat"; events: DocsChatStreamEvent[] }
  | { type: "end"; reason: StreamEndReason; fatal: boolean; status?: number; code?: string };

/** Il minimo di `MessagePortMain` che serve (finto nei test). */
export interface StreamPort {
  postMessage(message: unknown): void;
  on(event: "close", listener: () => void): void;
  start(): void;
  close(): void;
}

export interface StreamDeps {
  instanceUrl: () => string | null;
  token: () => string | null;
  /** Come `api:request`: riceve il token con cui è partita la richiesta. */
  onUnauthorized: (usedToken: string) => void;
  fetch?: typeof fetch;
}

const FATAL_STATUSES = new Set([401, 403, 404]);

// --- La bozza di Claude per la Posta (area 6, F3) --------------------------------
//
// Uno dei due stream in POST (l'altro è la chat dei Docs): il percorso esatto,
// e il corpo ricostruito qui dai soli campi previsti (il renderer non sceglie
// né il metodo né altro).

const MAIL_DRAFT_PATH = "/api/me/mail/drafts/claude";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAIL_DRAFT_MODES = new Set(["new", "reply", "replyAll", "forward"]);
/** L'indicazione a Claude, al più: lo stesso tetto del server (`mailClaudeDraftRequestSchema`) e del campo. */
const MAIL_DRAFT_HINT_MAX = 2000;

/** Il corpo della bozza di Claude, coi soli campi previsti; `null` se non va. */
export function mailDraftBody(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.accountId !== "string" || !UUID.test(b.accountId)) return null;
  if (b.threadId !== null && (typeof b.threadId !== "string" || b.threadId.length === 0 || b.threadId.length > 200)) return null;
  if (typeof b.mode !== "string" || !MAIL_DRAFT_MODES.has(b.mode)) return null;
  const hint = b.hint ?? "";
  if (typeof hint !== "string" || hint.length > MAIL_DRAFT_HINT_MAX) return null;
  const projectId = b.projectId ?? null;
  if (projectId !== null && (typeof projectId !== "string" || !UUID.test(projectId))) return null;
  return JSON.stringify({ accountId: b.accountId, threadId: b.threadId, mode: b.mode, hint, projectId });
}

// --- La chat dei Docs (lotto 7, §2) ------------------------------------------------
//
// La seconda POST: i due percorsi di `isAllowedDocsChatStreamPath` (shared),
// col corpo ricostruito qui dai soli campi previsti, coi tetti del server.

/** Il tetto della domanda: quello del server (`routes/docs-chat.ts`). */
const DOCS_CHAT_MESSAGE_MAX = 8000;

/** Il corpo della chat dei Docs, coi soli campi previsti; `null` se non va. */
export function docsChatBody(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.message !== "string" || b.message.length < 1 || b.message.length > DOCS_CHAT_MESSAGE_MAX)
    return null;
  if (b.sessionId !== undefined && (typeof b.sessionId !== "string" || !UUID.test(b.sessionId))) return null;
  return JSON.stringify({ message: b.message, ...(b.sessionId ? { sessionId: b.sessionId } : {}) });
}

export type MailDraftStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; text: string; projectId: string | null; used: unknown[] }
  | { type: "error"; code: string };

/** Un frame SSE della bozza (`data: {json}`), se è uno dei tre previsti. */
export function parseMailDraftFrame(raw: string): MailDraftStreamEvent | null {
  const data = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const e = parsed as Record<string, unknown> | null;
  if (!e || typeof e !== "object") return null;
  if (e.type === "delta" && typeof e.text === "string") return { type: "delta", text: e.text };
  if (e.type === "done" && typeof e.text === "string") {
    return {
      type: "done",
      text: e.text,
      projectId: typeof e.projectId === "string" ? e.projectId : null,
      used: Array.isArray(e.used) ? e.used : [],
    };
  }
  if (e.type === "error" && typeof e.code === "string") return { type: "error", code: e.code };
  return null;
}

function codeOf(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

/** Un registro degli stream aperti, per finestra (`webContents.id`). */
export function createStreamRegistry(deps: StreamDeps) {
  const open = new Map<number, Set<() => void>>();

  const count = (windowId: number) => open.get(windowId)?.size ?? 0;

  function start(windowId: number, path: unknown, port: StreamPort, options: { body?: unknown } = {}): void {
    port.start();
    let ended = false;
    const end = (message: Extract<StreamPortMessage, { type: "end" }>) => {
      if (ended) return;
      ended = true;
      try {
        port.postMessage(message);
      } catch {
        // la porta è già chiusa dall'altra parte
      }
      port.close();
    };
    // Cinque allowlist strette: le sessioni dell'agente, dall'area 4 i canali
    // della Chat, dall'area 6 la bozza di Claude per la Posta (un POST, col suo
    // corpo), dall'area 11 lo stream dal vivo di una pagina di prodotto, dal
    // lotto 7 la chat dei Docs (un POST, col suo corpo).
    const chat = typeof path === "string" && isAllowedChatStreamPath(path);
    const productLive = typeof path === "string" && isAllowedProductLiveStreamPath(path);
    const mailDraft = path === MAIL_DRAFT_PATH;
    const docsChat = typeof path === "string" && isAllowedDocsChatStreamPath(path);
    const postBody = mailDraft
      ? mailDraftBody(options.body)
      : docsChat
        ? docsChatBody(options.body)
        : null;
    const post = mailDraft || docsChat;
    if (
      typeof path !== "string" ||
      (!chat && !post && !productLive && !isAllowedAgentStreamPath(path)) ||
      (post && postBody === null)
    ) {
      end({ type: "end", reason: "rejected", fatal: true });
      return;
    }
    if (count(windowId) >= MAX_STREAMS_PER_WINDOW) {
      end({ type: "end", reason: "limit", fatal: true });
      return;
    }
    const base = deps.instanceUrl();
    const token = deps.token();
    if (!base || !token) {
      end({ type: "end", reason: "unauthorized", fatal: true, status: 401, code: "unauthenticated" });
      return;
    }

    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const armTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
        void reader?.cancel().catch(() => {});
      }, PING_TIMEOUT_MS);
    };
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      abort.abort();
      // Oltre all'abort: un corpo che non lo ascolta si chiude comunque.
      void reader?.cancel().catch(() => {});
      open.get(windowId)?.delete(stop);
    };
    let streams = open.get(windowId);
    if (!streams) open.set(windowId, (streams = new Set()));
    streams.add(stop);
    // Il renderer chiude la sua estremità (riquadro chiuso, pagina lasciata).
    port.on("close", () => {
      ended = true;
      stop();
    });

    const finish = (message: Extract<StreamPortMessage, { type: "end" }>) => {
      stop();
      end(message);
    };

    void (async () => {
      armTimer();
      let response: Response;
      try {
        response = await (deps.fetch ?? fetch)(`${base}${path}`, {
          method: post ? "POST" : "GET",
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${token}`,
            ...(post ? { "content-type": "application/json" } : {}),
          },
          ...(post ? { body: postBody! } : {}),
          redirect: "manual",
          signal: abort.signal,
        });
      } catch {
        finish({ type: "end", reason: timedOut ? "timeout" : "network", fatal: false });
        return;
      }
      // Un reindirizzamento (`redirect: "manual"`) non si segue né si riprova:
      // il Bearer andrebbe altrove, e riprovando tornerebbe uguale.
      if (response.status >= 300 && response.status < 400) {
        finish({ type: "end", reason: "redirect", fatal: true, status: response.status });
        return;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const code = codeOf(text);
        if (response.status === 401 && endsSession(path, 401, code)) deps.onUnauthorized(token);
        const fatal = FATAL_STATUSES.has(response.status);
        finish({
          type: "end",
          reason: response.status === 401 ? "unauthorized" : "http",
          fatal,
          status: response.status,
          ...(code ? { code } : {}),
        });
        return;
      }
      if (!response.body) {
        finish({ type: "end", reason: "network", fatal: false });
        return;
      }
      if (ended) return;
      port.postMessage({ type: "open" } satisfies StreamPortMessage);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let bytes = 0;
      for (;;) {
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await reader!.read();
        } catch {
          break; // caduta, timeout o chiusura dal renderer
        }
        if (chunk.done || ended) break;
        armTimer();
        if (!chunk.value) continue;
        bytes += chunk.value.byteLength;
        buffer += decoder.decode(chunk.value, { stream: true });
        const { frames, rest } = splitSseFrames(buffer);
        buffer = rest;
        for (const raw of frames) {
          if (docsChat) {
            // I frame letti con il modulo di shared; i ping e i malformati non danno niente.
            const events = parseDocsChatFrame(raw);
            if (events.length > 0) port.postMessage({ type: "docsChat", events } satisfies StreamPortMessage);
            continue;
          }
          if (mailDraft) {
            const event = parseMailDraftFrame(raw);
            if (event) port.postMessage({ type: "mailDraft", event } satisfies StreamPortMessage);
            continue;
          }
          if (productLive) {
            // Il frame com'è: lo legge il renderer con `parseProductLiveFrame`
            // di shared (frame per frame, i malformati si scartano). Un frame
            // troppo grande non passa.
            const onlyComments = raw.split("\n").every((line) => line === "" || line.startsWith(":"));
            if (onlyComments) continue;
            // Un frame troppo grande non passa, ma lo si dice: il renderer rilegge (revisione di R11-4, 13).
            if (raw.length > PRODUCT_LIVE_FRAME_MAX)
              port.postMessage({ type: "productFrameDropped" } satisfies StreamPortMessage);
            else port.postMessage({ type: "productFrame", raw } satisfies StreamPortMessage);
            continue;
          }
          if (chat) {
            const parsed = parseChatStreamFrame(raw);
            if (!parsed.real) continue;
            port.postMessage({ type: "chatFrame", messages: parsed.messages, cursor: parsed.cursor } satisfies StreamPortMessage);
            continue;
          }
          const parsed = parseAgentStreamFrame(raw);
          if (!parsed.real) continue;
          port.postMessage({
            type: "frame",
            messages: parsed.messages,
            lastId: parsed.lastId,
            real: parsed.real,
            invalidSession: parsed.invalidSession,
          } satisfies StreamPortMessage);
        }
        if (bytes >= AGENT_STREAM_MAX_BYTES) {
          finish({ type: "end", reason: "rotate", fatal: false });
          return;
        }
      }
      finish({ type: "end", reason: timedOut ? "timeout" : "network", fatal: false });
    })();
  }

  return {
    open: start,
    count,
    /** La finestra si chiude: ogni suo stream si ferma. */
    closeWindow(windowId: number): void {
      for (const stop of [...(open.get(windowId) ?? [])]) stop();
      open.delete(windowId);
    },
  };
}
