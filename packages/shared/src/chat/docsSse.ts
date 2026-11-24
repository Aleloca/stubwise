import { readerSchema, type Reader } from "../reader.js";
import { docsChatProductSourceSchema, docsChatSourceSchema, type DocsChatProductSource, type DocsChatSource } from "../schemas/docs.js";

/**
 * Lo stream della chat dei Docs (`POST /api/repositories/:id/docs/chat` e
 * `POST /api/projects/:id/docs/chat`, SSE di default; lotto 7, voce 2), nella
 * parte PURA che serve al main di Electron e al renderer: leggere un frame.
 * Lo spezzare in frame è `splitSseFrames` (stesso formato).
 *
 * Formato (`apps/server/src/routes/docs-chat-core.ts`): righe `data: {json}`
 * separate da una riga vuota; `: ping` ogni 25 s mentre il modello tace (non è
 * una riga `data:`, si scarta). Gli eventi, in ordine:
 * - `delta` `{ text }`, zero o più: il testo che cresce;
 * - poi UNO fra `done` `{ sessionId, citations, productSources }` (la stessa
 *   cosa di `sources`/`productSources` della risposta JSON) ed `error`
 *   `{ message }`. Uno stream che finisce senza nessuno dei due è una risposta
 *   interrotta (il server la salva col marcatore di troncamento).
 * Le fonti si validano una per una (`readerSchema`): una malformata si scarta,
 * non costa il `done`.
 */

export type DocsChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; sessionId: string; sources: Reader<DocsChatSource>[]; productSources: Reader<DocsChatProductSource>[] }
  | { type: "error"; message: string };

const sourceReader = readerSchema(docsChatSourceSchema);
const productReader = readerSchema(docsChatProductSourceSchema);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function each<T>(raw: unknown, reader: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const parsed = reader.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Legge un frame (il testo fra due righe vuote): gli eventi riconosciuti, in ordine. */
export function parseDocsChatFrame(raw: string): DocsChatStreamEvent[] {
  const out: DocsChatStreamEvent[] = [];
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.startsWith("data:")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice("data:".length).trim());
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const obj = value as Record<string, unknown>;
    if (obj.type === "delta" && typeof obj.text === "string") {
      out.push({ type: "delta", text: obj.text });
    } else if (obj.type === "done" && typeof obj.sessionId === "string" && UUID.test(obj.sessionId)) {
      out.push({ type: "done", sessionId: obj.sessionId, sources: each(obj.citations, sourceReader), productSources: each(obj.productSources, productReader) });
    } else if (obj.type === "error") {
      out.push({ type: "error", message: typeof obj.message === "string" ? obj.message : "" });
    }
  }
  return out;
}

const DOCS_CHAT_PATH_RE = /^\/api\/(?:repositories|projects)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/docs\/chat$/i;

/** L'allowlist dello stream della chat dei Docs: le due POST, con un uuid e senza query (lo stream è il default). */
export function isAllowedDocsChatStreamPath(path: string): boolean {
  return DOCS_CHAT_PATH_RE.test(path);
}
