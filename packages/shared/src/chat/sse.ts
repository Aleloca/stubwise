import { readerSchema, type Reader } from "../reader.js";
import { chatChannelSchema, chatMessageSchema, type ChatChannelView, type ChatMessageView } from "../schemas/chat.js";

/**
 * Lo stream dal vivo di un canale della Chat (`GET
 * /api/chat/channels/:id/stream`, SSE; integrazione area 4, fetta 1), nella
 * parte PURA che serve al renderer web e al main di Electron: leggere un
 * frame, il percorso e la sua allowlist. Lo spezzare in frame è
 * `splitSseFrames` delle sessioni (stesso formato).
 *
 * Formato: righe `data: {json}` separate da una riga vuota; `: ping` ogni 25 s
 * (non è una riga `data:`, si scarta). Il primo frame è sempre `channel`.
 * - `messages`: i messaggi nuovi o cambiati (anche le risposte dei thread, col
 *   loro `threadRootId`, e la radice aggiornata), ognuno validato da solo coi
 *   gli schemi del client REST (`readerSchema`), i malformati scartati; e il
 *   `cursor` (microsecondi, solo cifre) da ripassare come `?after=`;
 * - `channel`: la vista del canale di chi guarda.
 * Un frame è «vero» solo con un messaggio riconosciuto.
 */

export type ChatStreamFrameMessage =
  | { type: "messages"; messages: Reader<ChatMessageView>[] }
  | { type: "channel"; channel: Reader<ChatChannelView> };

export interface ParsedChatStreamFrame {
  messages: ChatStreamFrameMessage[];
  /** Il cursore dell'ultimo cambio visto (`?after=` alla ripresa), o null. */
  cursor: string | null;
  real: boolean;
}

/**
 * Il cursore: microsecondi dall'epoca, solo cifre (al più 20). Il server
 * rifiuta ogni altra forma. TODO(F1.2): sostituire con `CHAT_STREAM_CURSOR_RE`
 * di `schemas/chat.ts` quando arriva, così la regola resta una sola.
 */
const CURSOR_RE = /^\d{1,20}$/;

const messageReader = readerSchema(chatMessageSchema);
const channelReader = readerSchema(chatChannelSchema);

export function parseChatStreamFrame(raw: string): ParsedChatStreamFrame {
  const out: ParsedChatStreamFrame = { messages: [], cursor: null, real: false };
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice("data:".length).trim());
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const obj = value as Record<string, unknown>;
    if (obj.type === "messages" && Array.isArray(obj.messages)) {
      out.real = true;
      if (typeof obj.cursor === "string" && CURSOR_RE.test(obj.cursor)) out.cursor = obj.cursor;
      const messages: Reader<ChatMessageView>[] = [];
      for (const m of obj.messages) {
        const parsed = messageReader.safeParse(m);
        if (parsed.success) messages.push(parsed.data);
      }
      if (messages.length > 0) out.messages.push({ type: "messages", messages });
    } else if (obj.type === "channel") {
      const parsed = channelReader.safeParse(obj.channel);
      if (parsed.success) {
        out.real = true;
        out.messages.push({ type: "channel", channel: parsed.data });
      }
    }
  }
  return out;
}

/** Il percorso dello stream di un canale, dal cursore `after` (l'ultimo ricevuto). */
export function chatStreamPath(channelId: string, after?: string | null): string {
  const base = `/api/chat/channels/${encodeURIComponent(channelId)}/stream`;
  return after ? `${base}?after=${encodeURIComponent(after)}` : base;
}

const CHAT_STREAM_PATH_RE =
  /^\/api\/chat\/channels\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/stream(?:\?after=(\d{1,20}))?$/;

/**
 * L'allowlist dello stream della Chat: SOLO lo stream di un canale (uuid), col
 * solo cursore di cifre. La usa il main di Electron prima di aprire una
 * connessione col token dell'utente, accanto a quella delle sessioni.
 */
export function isAllowedChatStreamPath(path: string): boolean {
  const match = CHAT_STREAM_PATH_RE.exec(path);
  return match !== null && (match[1] === undefined || CURSOR_RE.test(match[1]));
}
