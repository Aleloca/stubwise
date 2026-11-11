import { randomUUID } from "node:crypto";
import { attachments, chatChannels, chatMessageAttachments, tickets, type Db } from "@stubwise/db";
import { CHAT_ATTACHMENTS_PER_MESSAGE, chatAttachmentAllowed, type ChatAttachmentView } from "@stubwise/shared";
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { ObjectStorage } from "../storage/index.js";
import { channelAccess, visibleChannel, type ChannelAccess, type ChannelRow, type ChatViewer } from "./access.js";

/**
 * Gli allegati dei messaggi della Chat (area 4, fetta 4). Il binario sta nello
 * storage (`chat/<canale>/<id>/<nome ripulito>`), mai nel DB né nell'API: si
 * carica con multipart e si scarica con un URL firmato (`Content-Disposition:
 * attachment`). Il ciclo:
 * - CARICATO nel canale da chi ci scrive: «in sospeso» (`message_id` null),
 *   lo vede e lo toglie solo lui;
 * - LEGATO da un suo messaggio dello stesso canale, entro 24 ore;
 * - tolto da una modifica (che toglie, non aggiunge) o con il messaggio;
 * - in sospeso da più di 24 ore: potato ([DECIDE] 3 = a). La pota il SERVER,
 *   perché lo storage lo ha solo lui (il worker non ne ha le credenziali).
 * Limiti e tipi: [DECIDE] 2 = b (`CHAT_ATTACHMENT_*` in `@stubwise/shared`).
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof chatMessageAttachments.$inferSelect;

/** Il canale, se chi guarda lo LEGGE (le regole di `access.ts`); altrimenti null. */
async function readable(db: Db, viewer: ChatViewer, id: string): Promise<{ channel: ChannelRow; access: ChannelAccess } | null> {
  const channel = await visibleChannel(db, viewer, id);
  if (!channel) return null;
  const access = await channelAccess(db, viewer, channel);
  return access.canRead ? { channel, access } : null;
}

/** Quanto resta in sospeso un allegato caricato e mai mandato. */
export const CHAT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** Scadenza degli URL firmati: breve, come i ticket. */
const DOWNLOAD_URL_TTL_SECONDS = 300;

export class ChatAttachmentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const view = (r: Row): ChatAttachmentView => ({
  id: r.id,
  filename: r.filename,
  mimeType: r.mimeType,
  sizeBytes: r.sizeBytes,
  createdAt: r.createdAt.toISOString(),
});

/** L'ultimo segmento del nome, solo caratteri sicuri: per la chiave, non per il nome mostrato. */
function sanitizeForKey(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "file";
}

/** Il nome mostrato: l'ultimo segmento, senza percorsi. */
const displayName = (filename: string): string => (filename.split(/[/\\]/).pop() ?? "").trim() || "file";

/**
 * Carica un file nel canale: chi ci scrive, in un canale non archiviato, un
 * tipo dell'elenco con un'estensione di quel tipo. Nasce in sospeso.
 */
export async function uploadChatAttachment(
  db: Db,
  storage: ObjectStorage,
  viewer: ChatViewer,
  channelId: string,
  file: { filename: string; mimeType: string; body: Buffer },
): Promise<ChatAttachmentView> {
  const found = await readable(db, viewer, channelId);
  if (!found) throw new ChatAttachmentError(404, "not_found", "Not found");
  const { channel, access } = found;
  if (channel.archivedAt !== null) throw new ChatAttachmentError(409, "channel_archived", "The channel is archived");
  if (!access.canWrite) throw new ChatAttachmentError(403, "not_member", "Join the channel to attach files");
  const filename = displayName(file.filename);
  if (!chatAttachmentAllowed(filename, file.mimeType)) throw new ChatAttachmentError(400, "unsupported_type", "Unsupported file type");
  const id = randomUUID();
  const storageKey = `chat/${channelId}/${id}/${sanitizeForKey(filename)}`;
  await storage.putObject(storageKey, file.body, file.mimeType);
  try {
    const [row] = await db
      .insert(chatMessageAttachments)
      .values({ id, channelId, uploaderId: viewer.id, filename, mimeType: file.mimeType, sizeBytes: file.body.length, storageKey })
      .returning();
    return view(row!);
  } catch (error) {
    // L'oggetto c'è ma la riga no: si toglie, per non lasciare orfani.
    await storage.deleteObject(storageKey).catch(() => undefined);
    throw error;
  }
}

/**
 * Lega gli allegati `ids` (nell'ordine) al messaggio nuovo: solo i propri, in
 * sospeso, di QUESTO canale, caricati da meno di 24 ore. Uno solo che non va
 * e niente si lega (400 `invalid_attachments`). Restituisce i nomi, per la
 * ricerca.
 */
export async function bindChatAttachments(
  tx: Tx,
  viewer: ChatViewer,
  channelId: string,
  messageId: string,
  ids: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (unique.length > CHAT_ATTACHMENTS_PER_MESSAGE) {
    throw new ChatAttachmentError(400, "invalid_attachments", `At most ${CHAT_ATTACHMENTS_PER_MESSAGE} attachments`);
  }
  const rows = await tx
    .select()
    .from(chatMessageAttachments)
    .where(
      and(
        inArray(chatMessageAttachments.id, unique),
        eq(chatMessageAttachments.channelId, channelId),
        eq(chatMessageAttachments.uploaderId, viewer.id),
        isNull(chatMessageAttachments.messageId),
        gt(chatMessageAttachments.createdAt, sql`now() - make_interval(secs => ${CHAT_PENDING_TTL_MS / 1000})`),
      ),
    )
    .for("update");
  if (rows.length !== unique.length) throw new ChatAttachmentError(400, "invalid_attachments", "Attach only your own files, uploaded to this channel");
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [position, id] of unique.entries()) {
    await tx.update(chatMessageAttachments).set({ messageId, position }).where(eq(chatMessageAttachments.id, id));
  }
  return unique.map((id) => byId.get(id)!.filename);
}

/** Gli allegati dei messaggi, nell'ordine di ciascuno (una query). */
export async function chatAttachmentViews(db: Db, messageIds: readonly string[]): Promise<Map<string, ChatAttachmentView[]>> {
  const out = new Map<string, ChatAttachmentView[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select()
    .from(chatMessageAttachments)
    .where(inArray(chatMessageAttachments.messageId, [...messageIds]))
    .orderBy(asc(chatMessageAttachments.position), asc(chatMessageAttachments.createdAt));
  for (const r of rows) out.set(r.messageId!, [...(out.get(r.messageId!) ?? []), view(r)]);
  return out;
}

/** Gli allegati legati a un messaggio. */
export async function attachmentsOf(db: Db | Tx, messageId: string): Promise<Row[]> {
  return db
    .select()
    .from(chatMessageAttachments)
    .where(eq(chatMessageAttachments.messageId, messageId))
    .orderBy(asc(chatMessageAttachments.position));
}

/** Toglie righe di allegati (dentro la transazione di chi scrive) e ne restituisce le chiavi dello storage. */
export async function dropChatAttachments(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .delete(chatMessageAttachments)
    .where(inArray(chatMessageAttachments.id, [...ids]))
    .returning({ storageKey: chatMessageAttachments.storageKey });
  return rows.map((r) => r.storageKey);
}

/**
 * Lo storage si pulisce DOPO il commit e senza bloccare: un oggetto rimasto
 * (storage giù) non è scaricabile, perché la riga non c'è più e l'URL lo firma
 * solo la rotta di download, che vuole la riga.
 */
export async function deleteStoredObjects(storage: ObjectStorage | null, keys: readonly string[], log: (msg: string) => void): Promise<void> {
  if (!storage) {
    if (keys.length > 0) log(`[chat] storage non configurato: ${keys.length} oggetti degli allegati restano da togliere`);
    return;
  }
  for (const key of keys) {
    await storage.deleteObject(key).catch((error: unknown) => log(`[chat] oggetto ${key} non tolto dallo storage: ${String(error)}`));
  }
}

/**
 * Le chiavi dello storage che una cancellazione in CASCATA porterebbe via
 * senza dirlo (review della fetta 4): gli allegati di un canale, o di tutti i
 * canali di un progetto più gli allegati dei suoi ticket. Si leggono PRIMA
 * della delete e si tolgono dallo storage DOPO il commit.
 */
export async function storageKeysOfChannel(db: Db | Tx, channelId: string): Promise<string[]> {
  const rows = await db.select({ key: chatMessageAttachments.storageKey }).from(chatMessageAttachments).where(eq(chatMessageAttachments.channelId, channelId));
  return rows.map((r) => r.key);
}

export async function storageKeysOfProject(db: Db | Tx, projectId: string): Promise<string[]> {
  const chat = await db
    .select({ key: chatMessageAttachments.storageKey })
    .from(chatMessageAttachments)
    .innerJoin(chatChannels, eq(chatChannels.id, chatMessageAttachments.channelId))
    .where(eq(chatChannels.projectId, projectId));
  const ticket = await db
    .select({ key: attachments.storageKey })
    .from(attachments)
    .innerJoin(tickets, eq(tickets.id, attachments.ticketId))
    .where(eq(tickets.projectId, projectId));
  return [...chat, ...ticket].map((r) => r.key);
}

/**
 * L'allegato da scaricare, se chi guarda può: di un messaggio vivo di un
 * canale che LEGGE (le regole di `access.ts`: DM e privati compresi, mai chi
 * gestisce senza esserne membro), o in sospeso e suo. Altrimenti null (404,
 * come uno che non c'è).
 */
export async function downloadableAttachment(db: Db, viewer: ChatViewer, id: string): Promise<Row | null> {
  const [row] = await db.select().from(chatMessageAttachments).where(eq(chatMessageAttachments.id, id));
  if (!row) return null;
  if (row.messageId === null) return row.uploaderId === viewer.id ? row : null;
  return (await readable(db, viewer, row.channelId)) ? row : null;
}

/** L'URL firmato per scaricare l'allegato (download, col nome come `attachment`). */
export function signedDownloadUrl(storage: ObjectStorage, row: Row): Promise<string> {
  return storage.getSignedDownloadUrl(row.storageKey, row.filename, DOWNLOAD_URL_TTL_SECONDS);
}

/** Toglie un allegato in sospeso: solo chi l'ha caricato. Restituisce la chiave dello storage, o null (404). */
export async function removePendingAttachment(db: Db, viewer: ChatViewer, id: string): Promise<string | null> {
  const [row] = await db
    .delete(chatMessageAttachments)
    .where(and(eq(chatMessageAttachments.id, id), eq(chatMessageAttachments.uploaderId, viewer.id), isNull(chatMessageAttachments.messageId)))
    .returning({ storageKey: chatMessageAttachments.storageKey });
  return row?.storageKey ?? null;
}

/**
 * La potatura ([DECIDE] 3 = a): gli allegati in sospeso da più di 24 ore se ne
 * vanno, righe e oggetti. La chiamano il timer del server e ogni caricamento.
 */
export async function pruneChatUploads(db: Db, storage: ObjectStorage | null, log: (msg: string) => void, limit = 200): Promise<number> {
  const old = await db
    .select({ id: chatMessageAttachments.id })
    .from(chatMessageAttachments)
    .where(
      and(isNull(chatMessageAttachments.messageId), lt(chatMessageAttachments.createdAt, sql`now() - make_interval(secs => ${CHAT_PENDING_TTL_MS / 1000})`)),
    )
    .limit(limit);
  if (old.length === 0) return 0;
  const keys = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(chatMessageAttachments)
      .where(and(inArray(chatMessageAttachments.id, old.map((r) => r.id)), isNull(chatMessageAttachments.messageId)))
      .returning({ storageKey: chatMessageAttachments.storageKey });
    return rows.map((r) => r.storageKey);
  });
  await deleteStoredObjects(storage, keys, log);
  return keys.length;
}
