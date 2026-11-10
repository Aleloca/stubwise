import { readerSchema, type Reader } from "../reader.js";
import {
  agentSessionDetailSchema,
  agentSessionEventSchema,
  type AgentSessionDetail,
  type AgentSessionEvent,
} from "../schemas/agent-session.js";

/**
 * Lo stream dal vivo di una sessione dell'agente (`GET
 * /api/agent-sessions/:id/stream`, SSE), nella parte PURA che serve a ogni
 * client (integrazione area 3, fetta 3a): spezzare il flusso in frame, leggere
 * un frame, il backoff della riconnessione, il percorso e la sua allowlist.
 * La connessione (fetch col cookie sul web, `XMLHttpRequest` sull'app, il main
 * di Electron col Bearer) resta di ogni client; l'unione degli eventi per id è
 * `mergeEvents` di `agent-transcript.ts`.
 *
 * Formato dei frame: righe `data: {json}` separate da una riga vuota. I
 * keep-alive `: ping` non sono righe `data:` e si scartano da soli. Ogni
 * messaggio si PARSA con gli stessi schemi del client REST (`readerSchema`):
 * - `events`: ogni evento validato da solo, i malformati scartati; il cursore
 *   avanza comunque all'ultimo `id` del frame (il server non lo rimanderebbe
 *   diverso);
 * - `partial`: `segmentId` e `text` stringhe;
 * - `session`: il dettaglio intero, scartato (e segnalato) se non si parsa.
 *
 * Un frame è «vero» (`real`) solo se contiene un messaggio riconosciuto: un
 * ping, un blocco vuoto, l'HTML di un proxy o un JSON rotto no — e il backoff
 * si azzera SOLO su un frame vero, così un 200 che chiude subito continua a
 * rallentare.
 */

export type AgentStreamMessage =
  | { type: "events"; events: Reader<AgentSessionEvent>[] }
  | { type: "partial"; segmentId: string; text: string }
  | { type: "session"; detail: Reader<AgentSessionDetail> };

export interface ParsedAgentStreamFrame {
  messages: AgentStreamMessage[];
  /** L'id dell'ultimo evento del frame (anche se malformato), o null. */
  lastId: string | null;
  /** Il frame conteneva un messaggio riconosciuto: azzera il backoff. */
  real: boolean;
  /** Un dettaglio `session` che non si parsa (lo si avvisa una volta per stream). */
  invalidSession: boolean;
}

/** Oltre questi byte ricevuti la connessione si riapre dal cursore (come l'app mobile). */
export const AGENT_STREAM_MAX_BYTES = 1024 * 1024;

const eventReader = readerSchema(agentSessionEventSchema);
const detailReader = readerSchema(agentSessionDetailSchema);

/** Spezza il buffer in frame completi; `rest` è il pezzo incompleto da tenere per il giro dopo. */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  return { frames: parts, rest };
}

/** Legge un frame (il testo fra due righe vuote). */
export function parseAgentStreamFrame(raw: string): ParsedAgentStreamFrame {
  const out: ParsedAgentStreamFrame = { messages: [], lastId: null, real: false, invalidSession: false };
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice("data:".length).trim());
    } catch {
      continue; // frame rotto: scartato, lo stream continua
    }
    if (typeof value !== "object" || value === null) continue;
    const obj = value as Record<string, unknown>;
    switch (obj.type) {
      case "events": {
        if (!Array.isArray(obj.events)) break;
        out.real = true;
        const events: Reader<AgentSessionEvent>[] = [];
        for (const rawEvent of obj.events) {
          const id = (rawEvent as { id?: unknown } | null)?.id;
          if (typeof id === "string") out.lastId = id;
          const parsed = eventReader.safeParse(rawEvent);
          if (parsed.success) events.push(parsed.data);
        }
        if (events.length > 0) out.messages.push({ type: "events", events });
        break;
      }
      case "partial": {
        if (typeof obj.segmentId !== "string" || typeof obj.text !== "string") break;
        out.real = true;
        out.messages.push({ type: "partial", segmentId: obj.segmentId, text: obj.text });
        break;
      }
      case "session": {
        out.real = true;
        const parsed = detailReader.safeParse(obj.detail);
        if (parsed.success) out.messages.push({ type: "session", detail: parsed.data });
        else out.invalidSession = true;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Attesa prima del tentativo `attempt` (0 = il primo dopo una caduta): raddoppia da 1 s, al più 15 s. */
export function streamBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

/** Il percorso dello stream di una sessione, dal cursore `after` (l'ultimo id già ricevuto). */
export function agentStreamPath(sessionId: string, after?: string | null): string {
  const base = `/api/agent-sessions/${encodeURIComponent(sessionId)}/stream`;
  return after ? `${base}?after=${encodeURIComponent(after)}` : base;
}

const STREAM_PATH_RE = /^\/api\/agent-sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/stream(?:\?after=\d{1,20})?$/;

/**
 * L'allowlist dello stream: SOLO lo stream di una sessione (uuid), col solo
 * cursore numerico. La usa il main di Electron prima di aprire una
 * connessione col token dell'utente: un percorso diverso — un'altra rotta,
 * un `..`, un host — non parte.
 */
export function isAllowedAgentStreamPath(path: string): boolean {
  return STREAM_PATH_RE.test(path);
}
