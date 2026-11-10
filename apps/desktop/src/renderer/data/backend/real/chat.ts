import { ApiError } from "@stubwise/api-client";
import type { ChatChannelView, ChatMessageView as ServerMessage, Reader } from "@stubwise/shared";
import type * as Fake from "../../api";
import type {
  ChannelMember,
  ChannelRow,
  ChannelView,
  ChatMessageHit,
  ChatMessageView,
  ThreadView,
  ThreadWithNews,
} from "../../types";
import { appClient, session } from "./client";
import { partialNamespace } from "./notIntegrated";

// La Chat fra persone nella build app (integrazione area 4, fetta 1): canali
// di progetto e il «general», messaggi, thread a un livello, reazioni, letti,
// preferenze, menzioni (`/api/chat`, schemi della F1.1). Chi vede, chi scrive e
// chi gestisce lo dice il SERVER (le viste sono di chi guarda): qui si legge,
// non si deduce. Restano «non integrati» i DM, i privati e i generali, la
// ricerca e le domande (fetta 2), @Claude (fetta 3), gli eventi dei progetti e
// gli allegati (fetta 4).

type Chat = typeof Fake.chat;
type ServerChannel = Reader<ChatChannelView>;
type ServerMsg = Reader<ServerMessage>;

/** I rifiuti del server negli errori del prototipo (`forbidden`, `not_found`, `invalid: …`). */
const INVALID_OF: Record<string, string> = {
  channel_archived: "archived",
  general_channel: "general",
  name_taken: "name_taken",
  deleted: "deleted",
  invalid_thread: "threadOf",
};

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) throw new Error("not_found");
      if (error.status === 403) throw new Error("forbidden");
      const what = error.code ? INVALID_OF[error.code] : undefined;
      if (what) throw new Error(`invalid: ${what}`);
      if (error.status === 400) throw new Error("invalid: input");
    }
    throw error;
  }
}

/** Una lettura: un 404 (non si vede, o non esiste) è `null`. */
async function read<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

// --- memorie della sessione ----------------------------------------------------------

/** Il canale di ogni messaggio letto: `markThreadRead` lo vuole, e il server lo chiede per canale. */
const channelOfMessage = new Map<string, string>();
/**
 * Il cursore del server per «altri messaggi»: il prototipo chiede la pagina
 * prima di un messaggio (`before` = il suo id), il server dà un cursore opaco
 * con la pagina. Si ricorda per il messaggio più vecchio della pagina letta.
 */
const cursorBefore = new Map<string, string>();

/** Cambio di persona o test: via le memorie della Chat. */
export function forgetPeopleChatCaches(): void {
  channelOfMessage.clear();
  cursorBefore.clear();
}

// --- le forme -------------------------------------------------------------------------

function toChannelView(v: ServerChannel): ChannelView {
  return {
    id: v.id,
    // Un tipo ignoto (un server più nuovo) si legge come canale di progetto.
    kind: v.kind === "general" || v.kind === "dm" ? v.kind : "project",
    projectId: v.projectId,
    name: v.name,
    description: v.description,
    topic: v.topic,
    visibility: v.visibility === "private" ? "private" : "open",
    createdById: v.createdBy ?? "",
    archived: v.archived,
    archivedById: v.archivedBy,
    archivedAt: v.archivedAt,
    isGeneral: v.isGeneral,
    memberIds: [...v.memberIds],
    // Gli eventi dei progetti nei canali sono della fetta 4.
    publishedEvents: [],
    createdAt: v.createdAt,
    // Il server non manda un canale che chi guarda non legge.
    canRead: true,
    isMember: v.isMember,
    canWrite: v.canWrite,
    canJoin: v.canJoin,
    canLeave: v.canLeave,
    canEditInfo: v.canManage,
    canEditTopic: v.canManage,
    canArchive: v.canManage,
    canDelete: v.canManage,
    // Fuori dalla fetta 1: inviti e rimozioni (i privati), gli eventi (fetta 4).
    canEditEvents: false,
    canInvite: false,
    canRemove: false,
    notifyLevel: v.level === "mentions" || v.level === "muted" ? v.level : "all",
  };
}

function toRow(v: ServerChannel): ChannelRow {
  return { ...toChannelView(v), unread: v.unread, mentions: v.mentions, lastActivityAt: v.lastMessageAt };
}

function toMessage(v: ServerMsg): ChatMessageView {
  channelOfMessage.set(v.id, v.channelId);
  const me = session.personId ?? "";
  // Il momento dell'eliminazione: dal server se lo dice (`deletedAt`), se no
  // basta che ci sia (il testo non c'è più comunque).
  const deletedAt = v.deleted
    ? ((v as { deletedAt?: string | null }).deletedAt ?? v.editedAt ?? v.createdAt)
    : null;
  return {
    id: v.id,
    channelId: v.channelId,
    threadOf: v.threadRootId,
    authorId: v.authorId,
    kind: v.kind === "system" || v.kind === "claude" ? v.kind : "person",
    ...(v.calledById ? { calledById: v.calledById } : {}),
    text: v.deleted ? "" : v.text,
    // Allegati, citazioni registrate, domande, codici legati: fette dopo.
    attachments: [],
    citations: [],
    reactions: v.reactions.map((r) => ({ emoji: r.emoji, personIds: [...r.personIds] })),
    asksReplyOf: [],
    linkedCodes: [],
    createdAt: v.createdAt,
    editedAt: v.editedAt,
    deletedAt,
    deletedById: v.deletedBy,
    thread:
      v.threadRootId === null && v.replyCount > 0
        ? {
            replyCount: v.replyCount,
            lastReplyAt: v.lastReplyAt ?? v.createdAt,
            // In arrivo con la F1.2 (additivi): chi ha risposto e chi per ultimo.
            lastReplyById: (v as { lastReplyById?: string | null }).lastReplyById ?? null,
            participantIds: [...((v as { replyParticipantIds?: string[] }).replyParticipantIds ?? [])],
            hasNews: false,
            following: v.following,
            claudeReplying: false,
          }
        : null,
    answeredIds: [],
    mentionsViewer: v.mentionedIds.includes(me),
    linkedRefs: [],
  };
}

const hitOf = (v: ServerMsg): ChatMessageHit => ({ channelId: v.channelId, message: toMessage(v), context: null });

// --- letture ----------------------------------------------------------------------------

const listChannels: Chat["listChannels"] = async (options = { scope: "all" }) => {
  const list = await appClient().chat.channels.list(options.scope === "project" ? { projectId: options.projectId } : {});
  return list.items.map(toRow);
};

const getChannel: Chat["getChannel"] = async (id) => {
  const v = await read(() => appClient().chat.channels.get(id));
  return v ? toChannelView(v) : null;
};

/** Nessuna rotta a sé: i `memberIds` del canale (nel «general», quelli del progetto). */
const listChannelMembers: Chat["listChannelMembers"] = async (id) => {
  const v = await read(() => appClient().chat.channels.get(id));
  if (!v) return null;
  return v.memberIds.map((personId): ChannelMember => ({ personId, isCreator: personId === v.createdBy }));
};

const listMessages: Chat["listMessages"] = async (channelId, { before, limit } = {}) => {
  const cursor = before ? cursorBefore.get(before) : undefined;
  // Una pagina prima di un messaggio senza cursore ricordato: niente di più vecchio da chiedere.
  if (before && !cursor) return { messages: [], hasMore: false, lastReadAt: null };
  const [page, channel] = await Promise.all([
    read(() =>
      appClient().chat.messages.page(channelId, {
        ...(cursor ? { before: cursor } : {}),
        ...(limit ? { limit } : {}),
      }),
    ),
    before ? Promise.resolve(null) : read(() => appClient().chat.channels.get(channelId)),
  ]);
  if (!page) return null;
  const messages = page.items.map(toMessage);
  if (page.before && messages[0]) cursorBefore.set(messages[0].id, page.before);
  return {
    messages,
    hasMore: page.before !== null,
    // Il divisore dei nuovi: dal canale se il server lo dice (vedi il registro).
    lastReadAt: (channel as { lastReadAt?: string | null } | null)?.lastReadAt ?? null,
  };
};

const getMessage: Chat["getMessage"] = async (id) => {
  const v = await read(() => appClient().chat.messages.get(id));
  return v ? hitOf(v) : null;
};

const listThread: Chat["listThread"] = async (messageId) => {
  const t = await read(() => appClient().chat.messages.thread(messageId));
  if (!t) return null;
  const view: ThreadView = {
    channelId: t.root.channelId,
    root: toMessage(t.root),
    replies: t.replies.map(toMessage),
    lastReadAt: (t as { lastReadAt?: string | null }).lastReadAt ?? null,
  };
  return view;
};

const listThreadsWithNews: Chat["listThreadsWithNews"] = async () => {
  const list = await appClient().chat.threads();
  return list.items.map(
    (item): ThreadWithNews => ({
      channelId: item.root.channelId,
      root: toMessage(item.root),
      latestReplies: ((item as { latestReplies?: ServerMsg[] }).latestReplies ?? []).map(toMessage),
      newCount: item.unreadReplies,
    }),
  );
};

const hasNews: Chat["hasNews"] = async () => (await appClient().chat.signal()).hasNews;

const listMentions: Chat["listMentions"] = async () => (await appClient().chat.mentions()).items.map(hitOf);

// --- scritture ------------------------------------------------------------------------------

/**
 * Un messaggio: il testo e la radice del thread. Allegati, citazioni e «anche
 * nel canale» sono delle fette dopo; la domanda (`asksReply`) è della fetta 2.
 * Le menzioni le ricava il server dal testo.
 */
const sendMessage: Chat["sendMessage"] = async (channelId, input) =>
  toMessage(
    await call(() =>
      appClient().chat.messages.send(channelId, {
        text: input.text,
        ...(input.threadOf ? { threadRootId: input.threadOf } : {}),
      }),
    ),
  );

const editMessage: Chat["editMessage"] = async (id, text) =>
  toMessage(await call(() => appClient().chat.messages.edit(id, text)));

const deleteMessage: Chat["deleteMessage"] = async (id) => {
  await call(() => appClient().chat.messages.remove(id));
};

const toggleReaction: Chat["toggleReaction"] = async (id, emoji) =>
  toMessage(await call(() => appClient().chat.messages.toggleReaction(id, emoji)));

const markRead: Chat["markRead"] = async (channelId, at) => {
  await call(() => appClient().chat.channels.markRead(channelId, at ? { at } : {}));
};

const markThreadRead: Chat["markThreadRead"] = async (rootId, at) => {
  const channelId =
    channelOfMessage.get(rootId) ?? (await call(() => appClient().chat.messages.get(rootId))).channelId;
  await call(() => appClient().chat.channels.markRead(channelId, { threadRootId: rootId, ...(at ? { at } : {}) }));
};

const setThreadFollow: Chat["setThreadFollow"] = async (rootId, following) => {
  await call(() => appClient().chat.messages.setFollow(rootId, following));
};

const setNotifyLevel: Chat["setNotifyLevel"] = async (channelId, level) => {
  await call(() => appClient().chat.channels.setPref(channelId, level));
};

const joinChannel: Chat["joinChannel"] = async (channelId) =>
  toChannelView(await call(() => appClient().chat.channels.join(channelId)));

const leaveChannel: Chat["leaveChannel"] = async (channelId) => {
  await call(() => appClient().chat.channels.leave(channelId));
};

/** Solo i canali APERTI di un progetto: privati e generali sono della fetta 2. */
const createChannel: Chat["createChannel"] = async (input) => {
  if (input.projectId === null || input.visibility !== "open") throw new Error("invalid: visibility");
  const projectId = input.projectId;
  return toChannelView(
    await call(() =>
      appClient().chat.channels.create({
        projectId,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
      }),
    ),
  );
};

const updateChannel: Chat["updateChannel"] = async (channelId, patch) =>
  toChannelView(await call(() => appClient().chat.channels.update(channelId, patch)));

const archiveChannel: Chat["archiveChannel"] = async (channelId, archived = true) =>
  toChannelView(await call(() => appClient().chat.channels.update(channelId, { archived })));

const deleteChannel: Chat["deleteChannel"] = async (channelId) => {
  await call(() => appClient().chat.channels.remove(channelId));
};

/** Il namespace `chat` della build app: la fetta 1; il resto resta «non integrato». */
export const chat: Chat = partialNamespace<Chat>("chat", {
  listChannels,
  getChannel,
  listChannelMembers,
  listMessages,
  getMessage,
  listThread,
  listThreadsWithNews,
  hasNews,
  listMentions,
  sendMessage,
  editMessage,
  deleteMessage,
  toggleReaction,
  markRead,
  markThreadRead,
  setThreadFollow,
  setNotifyLevel,
  joinChannel,
  leaveChannel,
  createChannel,
  updateChannel,
  archiveChannel,
  deleteChannel,
});
