import {
  chatChannelMembers,
  chatChannelPrefs,
  chatChannels,
  chatMessages,
  chatReactions,
  chatReads,
  chatThreadFollows,
  users,
  type Db,
} from "@stubwise/db";
import { publishNotification } from "@stubwise/notifications";
import type {
  ChatChannelView,
  ChatMessageView,
  ChatNotifyLevel,
  CreateChatChannelInput,
  PatchChatChannelInput,
} from "@stubwise/shared";
import { CHAT_EVENT_KINDS, chatChannelNameSchema } from "@stubwise/shared";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import { isUniqueViolation } from "../routes/shared.js";
import { personName } from "../services/people.js";
import {
  channelAccess,
  channelMemberIds,
  channelReaderIds,
  channelVisibleSql,
  visibleChannel,
  type ChannelRow,
  type ChatViewer,
} from "./access.js";

/**
 * La Chat fra persone, fetta 1 (area 4): canali di progetto, messaggi, thread
 * a un livello, reazioni, letti, preferenze, thread seguiti, menzioni. Chi
 * vede e chi scrive lo decide `access.ts`; qui le scritture e le viste di chi
 * guarda. Regole del prototipo (`data/chat/*`): si modificano ed eliminano
 * solo i propri messaggi (D6); un eliminato non ha testo (CHECK); le menzioni
 * le ricava il server dal testo, sui nomi di chi legge il canale (R-G6:
 * `@channel` e `@reparto` non avvisano).
 */

export const CHAT_CHANNEL_NOTIFY = "chat_channel";
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type MessageRow = typeof chatMessages.$inferSelect;

export class ChatError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const notFound = () => new ChatError(404, "not_found", "Not found");

/** Avvisa lo stream del canale (al commit). */
async function notifyChannel(db: Db | Tx, channelId: string): Promise<void> {
  await db.execute(sql`select pg_notify(${CHAT_CHANNEL_NOTIFY}, ${JSON.stringify({ channelId })})`);
}

// --- Persone e menzioni -------------------------------------------------------

/** Le persone (non Claude) fra `ids`, coi nomi come li mostra l'app. */
async function peopleOf(db: Db | Tx, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(inArray(users.id, [...new Set(ids)]), eq(users.isAgent, false)));
  return rows.map((r) => ({ id: r.id, name: personName(r) }));
}

/** `@Nome` finisce dove finisce il nome (come `mentions.ts` del prototipo). */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "u").test(text);
}

/** Le persone nominate direttamente fra chi legge il canale; mai chi scrive. */
async function mentionedIn(db: Db | Tx, channel: ChannelRow, text: string, authorId: string): Promise<string[]> {
  if (!text.includes("@")) return [];
  const readers = await peopleOf(db, await channelReaderIds(db as Db, channel));
  // I nomi più lunghi prima: «@Marta Rinaldi» non conta anche «@Marta».
  return readers
    .sort((a, b) => b.name.length - a.name.length)
    .filter((p) => p.id !== authorId && mentions(text, p.name))
    .map((p) => p.id);
}

// --- Viste ----------------------------------------------------------------

async function lastReadOf(db: Db, viewerId: string, channelId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: chatReads.lastReadAt })
    .from(chatReads)
    .where(and(eq(chatReads.userId, viewerId), eq(chatReads.channelId, channelId), isNull(chatReads.threadRootId)));
  return row?.at ?? null;
}

async function levelOf(db: Db, viewerId: string, channelId: string): Promise<ChatNotifyLevel> {
  const [row] = await db
    .select({ level: chatChannelPrefs.level })
    .from(chatChannelPrefs)
    .where(and(eq(chatChannelPrefs.userId, viewerId), eq(chatChannelPrefs.channelId, channelId)));
  return row?.level ?? "all";
}

/** Il canale come lo vede chi guarda (lo vede: il chiamante l'ha controllato). */
export async function channelView(db: Db, viewer: ChatViewer, channel: ChannelRow): Promise<ChatChannelView> {
  const access = await channelAccess(db, viewer, channel);
  const lastRead = await lastReadOf(db, viewer.id, channel.id);
  const since = lastRead ?? new Date(0);
  const [counts] = await db
    .select({
      unread: sql<number>`count(*) filter (where ${chatMessages.threadRootId} is null)::int`,
      mentions: sql<number>`count(*) filter (where ${viewer.id}::uuid = any(${chatMessages.mentionedIds}))::int`,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.channelId, channel.id),
        gt(chatMessages.createdAt, since),
        isNull(chatMessages.deletedAt),
        or(isNull(chatMessages.authorId), ne(chatMessages.authorId, viewer.id)),
        ne(chatMessages.kind, "system"),
      ),
    );
  const [last] = await db
    .select({ at: chatMessages.createdAt })
    .from(chatMessages)
    .where(eq(chatMessages.channelId, channel.id))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);
  const members = (await peopleOf(db, await channelMemberIds(db, channel))).map((p) => p.id);
  return {
    id: channel.id,
    kind: channel.kind,
    projectId: channel.projectId,
    name: channel.name,
    description: channel.description,
    topic: channel.topic,
    visibility: channel.visibility,
    isGeneral: channel.isGeneral,
    archived: channel.archivedAt !== null,
    archivedAt: channel.archivedAt?.toISOString() ?? null,
    archivedBy: channel.archivedBy,
    createdBy: channel.createdBy,
    createdAt: channel.createdAt.toISOString(),
    memberIds: members,
    isMember: access.isMember,
    canWrite: access.canWrite,
    canJoin: access.canJoin,
    canLeave: access.canLeave,
    canManage: access.canManage,
    unread: access.isMember ? (counts?.unread ?? 0) : 0,
    mentions: counts?.mentions ?? 0,
    level: await levelOf(db, viewer.id, channel.id),
    lastReadAt: lastRead?.toISOString() ?? null,
    lastMessageAt: last?.at.toISOString() ?? null,
    publishedEvents: channel.publishedEvents.filter((e): e is (typeof CHAT_EVENT_KINDS)[number] =>
      (CHAT_EVENT_KINDS as readonly string[]).includes(e),
    ),
  };
}

/** I messaggi come li vede chi guarda: reazioni, risposte, seguito, permessi. */
async function messageViews(db: Db, viewer: ChatViewer, rows: readonly MessageRow[]): Promise<ChatMessageView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const reactions = await db
    .select({ messageId: chatReactions.messageId, emoji: chatReactions.emoji, userId: chatReactions.userId })
    .from(chatReactions)
    .where(inArray(chatReactions.messageId, ids))
    .orderBy(asc(chatReactions.createdAt));
  const replyRows = await db
    .select({ root: chatMessages.threadRootId, authorId: chatMessages.authorId, at: chatMessages.createdAt, deletedAt: chatMessages.deletedAt })
    .from(chatMessages)
    .where(inArray(chatMessages.threadRootId, ids))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  const replies = new Map<string, { n: number; last: Date | null; lastBy: string | null; participants: string[] }>();
  for (const r of replyRows) {
    const agg = replies.get(r.root!) ?? { n: 0, last: null, lastBy: null, participants: [] };
    if (r.deletedAt === null) agg.n += 1;
    agg.last = r.at;
    agg.lastBy = r.authorId;
    if (r.authorId && !agg.participants.includes(r.authorId)) agg.participants.push(r.authorId);
    replies.set(r.root!, agg);
  }
  const follows = await db
    .select({ root: chatThreadFollows.rootMessageId, following: chatThreadFollows.following })
    .from(chatThreadFollows)
    .where(and(eq(chatThreadFollows.userId, viewer.id), inArray(chatThreadFollows.rootMessageId, ids)));
  const byMessage = new Map<string, Map<string, string[]>>();
  for (const r of reactions) {
    const forMessage = byMessage.get(r.messageId) ?? new Map<string, string[]>();
    forMessage.set(r.emoji, [...(forMessage.get(r.emoji) ?? []), r.userId]);
    byMessage.set(r.messageId, forMessage);
  }
  const replyOf = replies;
  const followOf = new Map(follows.map((f) => [f.root, f.following]));
  return rows.map((m) => {
    const own = m.authorId === viewer.id && m.kind === "person";
    const deleted = m.deletedAt !== null;
    const reply = replyOf.get(m.id);
    return {
      id: m.id,
      channelId: m.channelId,
      threadRootId: m.threadRootId,
      authorId: m.authorId,
      kind: m.kind,
      calledById: m.calledById,
      text: deleted ? "" : m.body,
      createdAt: m.createdAt.toISOString(),
      editedAt: m.editedAt?.toISOString() ?? null,
      deleted,
      deletedAt: m.deletedAt?.toISOString() ?? null,
      deletedBy: m.deletedBy,
      reactions: [...(byMessage.get(m.id) ?? new Map()).entries()].map(([emoji, personIds]) => ({ emoji, personIds })),
      replyCount: reply?.n ?? 0,
      lastReplyAt: reply?.last?.toISOString() ?? null,
      lastReplyById: reply?.lastBy ?? null,
      replyParticipantIds: reply?.participants ?? [],
      following: followOf.get(m.id) === true,
      mentionedIds: deleted ? [] : m.mentionedIds,
      canEdit: own && !deleted,
      canDelete: own && !deleted,
      viaClaude: m.viaClaudeActionId !== null,
    } satisfies ChatMessageView;
  });
}

// --- Canali -----------------------------------------------------------------

export async function listChannels(
  db: Db,
  viewer: ChatViewer,
  opts: { projectId?: string; archived: boolean },
): Promise<ChatChannelView[]> {
  const rows = await db
    .select()
    .from(chatChannels)
    .where(
      and(
        await channelVisibleSql(db, viewer),
        opts.projectId ? eq(chatChannels.projectId, opts.projectId) : undefined,
        opts.archived ? sql`${chatChannels.archivedAt} is not null` : isNull(chatChannels.archivedAt),
      ),
    )
    .orderBy(desc(chatChannels.isGeneral), asc(chatChannels.name));
  const out: ChatChannelView[] = [];
  for (const row of rows) out.push(await channelView(db, viewer, row));
  return out;
}

export async function getChannel(db: Db, viewer: ChatViewer, id: string): Promise<ChatChannelView> {
  const channel = await visibleChannel(db, viewer, id);
  if (!channel) throw notFound();
  return channelView(db, viewer, channel);
}


export async function createChannel(db: Db, viewer: ChatViewer, input: CreateChatChannelInput): Promise<ChatChannelView> {
  const name = chatChannelNameSchema.parse(input.name);
  const permissions = await projectPermissionsFor(db, viewer, input.projectId);
  if (!permissions) throw notFound();
  if (!permissions.has("chat.channels.create")) throw new ChatError(403, "forbidden", "Can't create channels here");
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(chatChannels)
        .values({
          projectId: input.projectId,
          kind: "project",
          name,
          description: input.description ?? "",
          topic: input.topic ?? "",
          createdBy: viewer.id,
        })
        .returning({ id: chatChannels.id });
      // Chi crea il canale ne è membro.
      await tx.insert(chatChannelMembers).values({ channelId: row!.id, userId: viewer.id });
      return row!.id;
    });
    return getChannel(db, viewer, id);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ChatError(409, "name_taken", "A channel with this name already exists");
    throw error;
  }
}

async function managedChannel(db: Db, viewer: ChatViewer, id: string): Promise<ChannelRow> {
  const channel = await visibleChannel(db, viewer, id);
  if (!channel) throw notFound();
  if (channel.isGeneral) throw new ChatError(409, "general_channel", "The general channel can't be changed");
  if (!(await channelAccess(db, viewer, channel)).canManage) throw new ChatError(403, "forbidden", "Can't manage this channel");
  return channel;
}

export async function updateChannel(
  db: Db,
  viewer: ChatViewer,
  id: string,
  patch: PatchChatChannelInput,
): Promise<ChatChannelView> {
  const channel = await managedChannel(db, viewer, id);
  try {
    await db
      .update(chatChannels)
      .set({
        ...(patch.name !== undefined ? { name: chatChannelNameSchema.parse(patch.name) } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
        ...(patch.archived !== undefined
          ? patch.archived
            ? { archivedAt: channel.archivedAt ?? new Date(), archivedBy: channel.archivedBy ?? viewer.id }
            : { archivedAt: null, archivedBy: null }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(chatChannels.id, id));
  } catch (error) {
    if (isUniqueViolation(error)) throw new ChatError(409, "name_taken", "A channel with this name already exists");
    throw error;
  }
  await notifyChannel(db, id);
  return getChannel(db, viewer, id);
}

export async function deleteChannel(db: Db, viewer: ChatViewer, id: string): Promise<void> {
  await managedChannel(db, viewer, id);
  await db.delete(chatChannels).where(eq(chatChannels.id, id));
  await notifyChannel(db, id);
}

export async function joinChannel(db: Db, viewer: ChatViewer, id: string, join: boolean): Promise<ChatChannelView> {
  const channel = await visibleChannel(db, viewer, id);
  if (!channel) throw notFound();
  if (channel.isGeneral) throw new ChatError(409, "general_channel", "Everyone in the project is in the general channel");
  if (join) {
    if (channel.archivedAt !== null) throw new ChatError(409, "channel_archived", "The channel is archived");
    await db.insert(chatChannelMembers).values({ channelId: id, userId: viewer.id }).onConflictDoNothing();
  } else {
    await db
      .delete(chatChannelMembers)
      .where(and(eq(chatChannelMembers.channelId, id), eq(chatChannelMembers.userId, viewer.id)));
  }
  await notifyChannel(db, id);
  return getChannel(db, viewer, id);
}

// --- Messaggi ----------------------------------------------------------------

/** Il messaggio, se chi guarda ne vede il canale. */
async function visibleMessage(db: Db, viewer: ChatViewer, id: string): Promise<{ message: MessageRow; channel: ChannelRow }> {
  const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, id));
  if (!message) throw notFound();
  const channel = await visibleChannel(db, viewer, message.channelId);
  if (!channel) throw notFound();
  return { message, channel };
}

const PAGE_DEFAULT = 50;

/** Una pagina delle RADICI del canale, dalla più vecchia alla più nuova; `before` = `iso|id`. */
export async function listMessages(
  db: Db,
  viewer: ChatViewer,
  channelId: string,
  opts: { before?: string; limit?: number },
): Promise<{ items: ChatMessageView[]; before: string | null }> {
  const channel = await visibleChannel(db, viewer, channelId);
  if (!channel) throw notFound();
  const limit = Math.min(Math.max(opts.limit ?? PAGE_DEFAULT, 1), 200);
  const cursor = parseCursor(opts.before);
  const rows = await db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.channelId, channelId),
        isNull(chatMessages.threadRootId),
        cursor
          ? or(lt(chatMessages.createdAt, cursor.at), and(eq(chatMessages.createdAt, cursor.at), lt(chatMessages.id, cursor.id)))
          : undefined,
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).reverse();
  const first = page[0];
  return {
    items: await messageViews(db, viewer, page),
    before: rows.length > limit && first ? `${first.createdAt.toISOString()}|${first.id}` : null,
  };
}

function parseCursor(raw: string | undefined): { at: Date; id: string } | null {
  if (!raw) return null;
  const [at, id] = raw.split("|");
  const date = at ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime()) && id ? { at: date, id } : null;
}

export async function getMessage(db: Db, viewer: ChatViewer, id: string): Promise<ChatMessageView> {
  const { message } = await visibleMessage(db, viewer, id);
  return (await messageViews(db, viewer, [message]))[0]!;
}

/** Il thread di un messaggio: la radice e le risposte (con l'id di una risposta, la sua radice). */
export async function getThread(
  db: Db,
  viewer: ChatViewer,
  id: string,
): Promise<{ root: ChatMessageView; replies: ChatMessageView[]; lastReadAt: string | null }> {
  const { message } = await visibleMessage(db, viewer, id);
  const rootId = message.threadRootId ?? message.id;
  const [root] = await db.select().from(chatMessages).where(eq(chatMessages.id, rootId));
  const replies = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadRootId, rootId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  const views = await messageViews(db, viewer, [root!, ...replies]);
  const [read] = await db
    .select({ at: chatReads.lastReadAt })
    .from(chatReads)
    .where(and(eq(chatReads.userId, viewer.id), eq(chatReads.threadRootId, rootId)));
  return { root: views[0]!, replies: views.slice(1), lastReadAt: read?.at.toISOString() ?? null };
}

/** Segue un thread (se non ha già deciso di smettere). */
async function follow(tx: Tx, userIds: readonly string[], rootId: string): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  await tx
    .insert(chatThreadFollows)
    .values(ids.map((userId) => ({ userId, rootMessageId: rootId, following: true })))
    .onConflictDoNothing();
}

export async function postMessage(
  db: Db,
  viewer: ChatViewer,
  channelId: string,
  input: { text: string; threadRootId?: string },
): Promise<ChatMessageView> {
  const channel = await visibleChannel(db, viewer, channelId);
  if (!channel) throw notFound();
  const access = await channelAccess(db, viewer, channel);
  if (channel.archivedAt !== null) throw new ChatError(409, "channel_archived", "The channel is archived");
  if (!access.canWrite) throw new ChatError(403, "not_member", "Join the channel to write");
  let root: MessageRow | undefined;
  if (input.threadRootId) {
    [root] = await db.select().from(chatMessages).where(eq(chatMessages.id, input.threadRootId));
    if (!root || root.channelId !== channelId || root.threadRootId !== null || root.deletedAt !== null) {
      throw new ChatError(400, "invalid_thread", "Reply to a message of this channel");
    }
  }
  const mentioned = await mentionedIn(db, channel, input.text, viewer.id);
  const [author] = await peopleOf(db, [viewer.id]);
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(chatMessages)
      .values({
        channelId,
        authorId: viewer.id,
        kind: "person",
        threadRootId: root?.id ?? null,
        body: input.text,
        mentionedIds: mentioned,
      })
      .returning({ id: chatMessages.id });
    if (root) {
      // La radice cambia (risposte, ultima risposta): lo stream la rimanda.
      await tx.update(chatMessages).set({ updatedAt: sql`now()` }).where(eq(chatMessages.id, root.id));
      // Seguono il thread: l'autore della radice, chi risponde, chi è nominato.
      await follow(tx, [...(root.authorId ? [root.authorId] : []), viewer.id, ...mentioned], root.id);
    } else if (mentioned.length > 0) {
      await follow(tx, [viewer.id, ...mentioned], row!.id);
    }
    // Le menzioni dirette: una card per persona (D4), con push. Il canale lo
    // legge, l'ha controllato `mentionedIn` (chi legge il canale).
    for (const userId of mentioned) {
      await publishNotification(
        tx,
        {
          kind: "chat.mention",
          chatMessageId: row!.id,
          channelId,
          channelName: channel.name,
          projectId: channel.projectId,
          authorUserId: viewer.id,
          authorName: author?.name ?? "",
        },
        { accountUserId: userId, ...(channel.projectId ? { projectId: channel.projectId } : {}) },
      );
    }
    await notifyChannel(tx, channelId);
    return row!.id;
  });
  return getMessage(db, viewer, id);
}

async function ownMessage(db: Db, viewer: ChatViewer, id: string): Promise<{ message: MessageRow; channel: ChannelRow }> {
  const found = await visibleMessage(db, viewer, id);
  if (found.message.authorId !== viewer.id || found.message.kind !== "person") {
    throw new ChatError(403, "not_yours", "Only your own messages");
  }
  if (found.message.deletedAt !== null) throw new ChatError(409, "deleted", "The message was deleted");
  return found;
}

/** Modifica: solo i propri (D6). Le menzioni si ricalcolano; avvisa solo chi è nominato ADESSO per la prima volta. */
export async function editMessage(db: Db, viewer: ChatViewer, id: string, text: string): Promise<ChatMessageView> {
  const { message, channel } = await ownMessage(db, viewer, id);
  const mentioned = await mentionedIn(db, channel, text, viewer.id);
  const added = mentioned.filter((m) => !message.mentionedIds.includes(m));
  const [author] = await peopleOf(db, [viewer.id]);
  await db.transaction(async (tx) => {
    await tx
      .update(chatMessages)
      .set({ body: text, mentionedIds: mentioned, editedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(chatMessages.id, id));
    for (const userId of added) {
      await publishNotification(
        tx,
        {
          kind: "chat.mention",
          chatMessageId: id,
          channelId: channel.id,
          channelName: channel.name,
          projectId: channel.projectId,
          authorUserId: viewer.id,
          authorName: author?.name ?? "",
        },
        { accountUserId: userId, ...(channel.projectId ? { projectId: channel.projectId } : {}) },
      );
    }
    await notifyChannel(tx, channel.id);
  });
  return getMessage(db, viewer, id);
}

/** Eliminazione: solo i propri (D6); il testo sparisce (CHECK `deleted_at` ⇒ `body = ''`). */
export async function deleteMessage(db: Db, viewer: ChatViewer, id: string): Promise<void> {
  const { channel } = await ownMessage(db, viewer, id);
  await db
    .update(chatMessages)
    .set({ body: "", mentionedIds: [], deletedAt: sql`now()`, deletedBy: viewer.id, updatedAt: sql`now()` })
    .where(eq(chatMessages.id, id));
  await notifyChannel(db, channel.id);
}

/** Reazione: un toggle (`toggleReaction` del prototipo), da chi legge il canale ed è membro. */
export async function toggleReaction(db: Db, viewer: ChatViewer, id: string, emoji: string): Promise<ChatMessageView> {
  const { message, channel } = await visibleMessage(db, viewer, id);
  if (message.deletedAt !== null) throw new ChatError(409, "deleted", "The message was deleted");
  if (!(await channelAccess(db, viewer, channel)).canWrite) throw new ChatError(403, "not_member", "Join the channel to react");
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(chatReactions)
      .where(and(eq(chatReactions.messageId, id), eq(chatReactions.userId, viewer.id), eq(chatReactions.emoji, emoji)))
      .returning({ id: chatReactions.messageId });
    if (removed.length === 0) await tx.insert(chatReactions).values({ messageId: id, userId: viewer.id, emoji });
    await tx.update(chatMessages).set({ updatedAt: sql`now()` }).where(eq(chatMessages.id, id));
    await notifyChannel(tx, channel.id);
  });
  return getMessage(db, viewer, id);
}

/** Letto fino a `at` (o adesso): il canale, o con `threadRootId` il thread. */
export async function markRead(
  db: Db,
  viewer: ChatViewer,
  channelId: string,
  input: { threadRootId?: string; at?: string },
): Promise<void> {
  const channel = await visibleChannel(db, viewer, channelId);
  if (!channel) throw notFound();
  const at = input.at ? new Date(input.at) : new Date();
  if (input.threadRootId) {
    const [root] = await db.select({ channelId: chatMessages.channelId }).from(chatMessages).where(eq(chatMessages.id, input.threadRootId));
    if (!root || root.channelId !== channelId) throw notFound();
    await db
      .insert(chatReads)
      .values({ userId: viewer.id, channelId, threadRootId: input.threadRootId, lastReadAt: at })
      .onConflictDoUpdate({
        target: [chatReads.userId, chatReads.threadRootId],
        targetWhere: sql`${chatReads.threadRootId} is not null`,
        set: { lastReadAt: sql`greatest(${chatReads.lastReadAt}, excluded.last_read_at)` },
      });
    return;
  }
  await db
    .insert(chatReads)
    .values({ userId: viewer.id, channelId, lastReadAt: at })
    .onConflictDoUpdate({
      target: [chatReads.userId, chatReads.channelId],
      targetWhere: sql`${chatReads.threadRootId} is null`,
      set: { lastReadAt: sql`greatest(${chatReads.lastReadAt}, excluded.last_read_at)` },
    });
}

export async function setNotifyLevel(db: Db, viewer: ChatViewer, channelId: string, level: ChatNotifyLevel): Promise<ChatChannelView> {
  const channel = await visibleChannel(db, viewer, channelId);
  if (!channel) throw notFound();
  await db
    .insert(chatChannelPrefs)
    .values({ userId: viewer.id, channelId, level })
    .onConflictDoUpdate({ target: [chatChannelPrefs.userId, chatChannelPrefs.channelId], set: { level } });
  return channelView(db, viewer, channel);
}

export async function setThreadFollow(db: Db, viewer: ChatViewer, id: string, following: boolean): Promise<ChatMessageView> {
  const { message } = await visibleMessage(db, viewer, id);
  const rootId = message.threadRootId ?? message.id;
  await db
    .insert(chatThreadFollows)
    .values({ userId: viewer.id, rootMessageId: rootId, following })
    .onConflictDoUpdate({ target: [chatThreadFollows.userId, chatThreadFollows.rootMessageId], set: { following } });
  return getMessage(db, viewer, rootId);
}

// --- Viste trasversali ---------------------------------------------------------

/** Le radici dei thread che chi guarda segue, con risposte di altri dopo la sua lettura del thread. */
export async function threadsWithNews(
  db: Db,
  viewer: ChatViewer,
): Promise<{ root: ChatMessageView; unreadReplies: number; latestReplies: ChatMessageView[] }[]> {
  const visible = await channelVisibleSql(db, viewer);
  const rows = await db
    .select({
      root: chatMessages,
      unread: sql<number>`(
        select count(*)::int from ${chatMessages} r
        where r.thread_root_id = ${chatMessages.id}
          and r.deleted_at is null
          and (r.author_id is null or r.author_id <> ${viewer.id})
          and r.created_at > coalesce((
            select cr.last_read_at from ${chatReads} cr
            where cr.user_id = ${viewer.id} and cr.thread_root_id = ${chatMessages.id}
          ), to_timestamp(0))
      )`,
    })
    .from(chatMessages)
    .innerJoin(chatThreadFollows, and(eq(chatThreadFollows.rootMessageId, chatMessages.id), eq(chatThreadFollows.userId, viewer.id)))
    .innerJoin(chatChannels, eq(chatChannels.id, chatMessages.channelId))
    .where(and(eq(chatThreadFollows.following, true), visible))
    .orderBy(desc(chatMessages.updatedAt))
    .limit(100);
  const withNews = rows.filter((r) => r.unread > 0);
  const views = await messageViews(db, viewer, withNews.map((r) => r.root));
  const out: { root: ChatMessageView; unreadReplies: number; latestReplies: ChatMessageView[] }[] = [];
  for (const [i, root] of views.entries()) {
    const latest = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadRootId, root.id))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(3);
    out.push({ root, unreadReplies: withNews[i]!.unread, latestReplies: await messageViews(db, viewer, latest.reverse()) });
  }
  return out;
}

/** I messaggi che nominano chi guarda, nei canali che vede, dal più recente. */
export async function mentionsOf(db: Db, viewer: ChatViewer): Promise<ChatMessageView[]> {
  const rows = await db
    .select({ message: chatMessages })
    .from(chatMessages)
    .innerJoin(chatChannels, eq(chatChannels.id, chatMessages.channelId))
    .where(
      and(
        sql`${viewer.id}::uuid = any(${chatMessages.mentionedIds})`,
        isNull(chatMessages.deletedAt),
        await channelVisibleSql(db, viewer),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(50);
  return messageViews(db, viewer, rows.map((r) => r.message));
}

/** Il punto del binario: menzioni non lette, o novità nei canali (livello `all`) e nei thread seguiti. */
export async function signalOf(db: Db, viewer: ChatViewer): Promise<{ hasNews: boolean; mentions: number }> {
  const channels = await listChannels(db, viewer, { archived: false });
  const mentions = channels.reduce((n, c) => n + c.mentions, 0);
  const unreadAll = channels.some((c) => c.level === "all" && c.unread > 0);
  const threads = unreadAll || mentions > 0 ? [] : await threadsWithNews(db, viewer);
  return { hasNews: mentions > 0 || unreadAll || threads.length > 0, mentions };
}

/** I messaggi del canale cambiati dopo `after` (lo stream): nuovi, modificati, eliminati, reazioni, risposte. */
export async function changedSince(
  db: Db,
  viewer: ChatViewer,
  channelId: string,
  after: string | undefined,
): Promise<{ messages: ChatMessageView[]; cursor: string | null } | null> {
  const channel = await visibleChannel(db, viewer, channelId);
  if (!channel) return null;
  // Il cursore: i MICROSECONDI dall'epoca, interi e solo cifre. Un `Date` del
  // JS troncherebbe ai millisecondi, e l'ultimo messaggio tornerebbe a ogni giro.
  const micros = sql<string>`(extract(epoch from ${chatMessages.updatedAt}) * 1000000)::bigint`;
  const since = after && /^\d{1,20}$/.test(after) ? after : null;
  const rows = await db
    .select({ message: chatMessages, cursor: sql<string>`${micros}::text` })
    .from(chatMessages)
    .where(and(eq(chatMessages.channelId, channelId), since ? sql`${micros} > ${since}::bigint` : undefined))
    .orderBy(asc(chatMessages.updatedAt))
    .limit(200);
  const last = rows.at(-1);
  return { messages: await messageViews(db, viewer, rows.map((r) => r.message)), cursor: last ? last.cursor : (after ?? null) };
}

export { channelView as viewChannel };
export type { ChannelRow };

/**
 * La card `chat.mention` DERIVATA a lettura (area 4, fetta 1): per ogni
 * notifica, il messaggio come lo vede chi legge — canale, thread, chi scrive,
 * un estratto — o `null` se il messaggio è stato eliminato o il canale non lo
 * vede più (la card allora è `objectGone`, senza link). Nel jsonb solo gli id.
 * UNA lettura dell'utente, e una per i messaggi della pagina.
 */
export async function chatMentionsFor(
  db: Db,
  userId: string,
  rows: readonly { id: string; event: unknown }[],
): Promise<Map<string, ChatMentionCard | null>> {
  const out = new Map<string, ChatMentionCard | null>();
  const wanted = rows.flatMap((r) => {
    const id = (r.event as { chatMessageId?: unknown }).chatMessageId;
    return typeof id === "string" ? [{ notification: r.id, messageId: id }] : [];
  });
  if (wanted.length === 0) return out;
  const { refreshViewer } = await import("../routes/agent-sessions.js");
  const viewer = await refreshViewer(db, userId);
  const messages = await db.select().from(chatMessages).where(inArray(chatMessages.id, wanted.map((w) => w.messageId)));
  const byId = new Map(messages.map((m) => [m.id, m]));
  const channels = new Map<string, ChannelRow | null>();
  const names = new Map((await peopleOf(db, messages.flatMap((m) => (m.authorId ? [m.authorId] : [])))).map((p) => [p.id, p.name]));
  for (const w of wanted) {
    const m = byId.get(w.messageId);
    if (!m || m.deletedAt !== null || !viewer) {
      out.set(w.notification, null);
      continue;
    }
    if (!channels.has(m.channelId)) channels.set(m.channelId, await visibleChannel(db, viewer, m.channelId));
    const channel = channels.get(m.channelId);
    out.set(
      w.notification,
      channel
        ? {
            channelId: channel.id,
            channelName: channel.name,
            messageId: m.id,
            threadRootId: m.threadRootId,
            authorId: m.authorId,
            authorName: m.authorId ? (names.get(m.authorId) ?? "") : "",
            excerpt: m.body.length > 200 ? `${m.body.slice(0, 199).trimEnd()}…` : m.body,
          }
        : null,
    );
  }
  return out;
}

export interface ChatMentionCard {
  channelId: string;
  channelName: string;
  messageId: string;
  threadRootId: string | null;
  authorId: string | null;
  authorName: string;
  excerpt: string;
}
