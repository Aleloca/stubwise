import { z } from "zod";

/**
 * La Chat fra persone (integrazione area 4; design
 * `docs/plans/2026-11-10-integrazione-area4-chat-design.md`, piano della
 * fetta 1 `docs/plans/2026-11-10-integrazione-area4-fetta1-plan.md`). Le
 * viste sono quelle di CHI GUARDA, calcolate dal server: chi vede, chi scrive
 * e chi gestisce lo decide lui (`canWrite`, `canManage`…), il client lo legge.
 * Tutti i campi che un client vecchio potrebbe non ricevere nascono con un
 * default; gli enum passano da `readerSchema` nei client.
 */

export const CHAT_CHANNEL_KINDS = ["project", "general", "dm"] as const;
export const chatChannelKindSchema = z.enum(CHAT_CHANNEL_KINDS);
export type ChatChannelKind = z.infer<typeof chatChannelKindSchema>;

export const chatChannelVisibilitySchema = z.enum(["open", "private"]);
export const chatNotifyLevelSchema = z.enum(["all", "mentions", "muted"]);
export type ChatNotifyLevel = z.infer<typeof chatNotifyLevelSchema>;

/** Gli eventi di progetto che un canale può pubblicare (fetta 4). */
export const CHAT_EVENT_KINDS = [
  "release_page",
  "pr_opened",
  "pr_merged",
  "milestone_reached",
  "brief_ready",
  "request_new",
  "task_closed",
] as const;
export const chatEventKindSchema = z.enum(CHAT_EVENT_KINDS);
/** Quelli del «general» alla sua nascita (D8, come il prototipo). */
export const CHAT_GENERAL_DEFAULT_EVENTS = ["release_page", "milestone_reached", "brief_ready"] as const;

/** Il nome di un canale: minuscole, cifre e trattini, come il prototipo (`writes.ts`). */
export const CHAT_CHANNEL_NAME_MAX = 40;
export const CHAT_CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const chatChannelNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/\s+/g, "-"))
  .pipe(z.string().min(1).max(CHAT_CHANNEL_NAME_MAX).regex(CHAT_CHANNEL_NAME_RE));
export const CHAT_MESSAGE_MAX = 20_000;

/** Un canale come lo vede chi guarda. */
export const chatChannelSchema = z.object({
  id: z.uuid(),
  kind: chatChannelKindSchema,
  projectId: z.uuid().nullable(),
  name: z.string(),
  description: z.string().default(""),
  topic: z.string().default(""),
  visibility: chatChannelVisibilitySchema.default("open"),
  isGeneral: z.boolean().default(false),
  archived: z.boolean().default(false),
  archivedAt: z.iso.datetime().nullable().default(null),
  archivedBy: z.uuid().nullable().default(null),
  createdBy: z.uuid().nullable().default(null),
  createdAt: z.iso.datetime(),
  /** I membri (nel «general»: quelli del progetto, derivati). */
  memberIds: z.array(z.uuid()).default([]),
  isMember: z.boolean().default(false),
  /** Scrivere: membro, e canale non archiviato. */
  canWrite: z.boolean().default(false),
  /** Entrare / uscire (un canale aperto; mai il «general»). */
  canJoin: z.boolean().default(false),
  canLeave: z.boolean().default(false),
  /** Rinominare, archiviare, eliminare (`chat.channels.manage`; mai il «general»). */
  canManage: z.boolean().default(false),
  /** I non letti di chi guarda, e quanti lo nominano direttamente. */
  unread: z.number().int().default(0),
  mentions: z.number().int().default(0),
  level: chatNotifyLevelSchema.default("all"),
  lastMessageAt: z.iso.datetime().nullable().default(null),
  publishedEvents: z.array(chatEventKindSchema).default([]),
});
export type ChatChannelView = z.infer<typeof chatChannelSchema>;

export const chatReactionSchema = z.object({
  emoji: z.string(),
  personIds: z.array(z.uuid()),
});

/** Un messaggio come lo vede chi guarda. Eliminato: niente testo (`text` vuoto, `deleted`). */
export const chatMessageSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  /** La radice del thread; null per un messaggio del canale. */
  threadRootId: z.uuid().nullable().default(null),
  authorId: z.uuid().nullable(),
  kind: z.enum(["person", "system", "claude"]).default("person"),
  calledById: z.uuid().nullable().default(null),
  text: z.string(),
  createdAt: z.iso.datetime(),
  editedAt: z.iso.datetime().nullable().default(null),
  deleted: z.boolean().default(false),
  deletedBy: z.uuid().nullable().default(null),
  reactions: z.array(chatReactionSchema).default([]),
  /** Solo su una radice: le risposte e l'ultima. */
  replyCount: z.number().int().default(0),
  lastReplyAt: z.iso.datetime().nullable().default(null),
  /** Chi guarda segue il thread di questa radice. */
  following: z.boolean().default(false),
  /** Le persone nominate direttamente (`@Nome`), le ricava il server. */
  mentionedIds: z.array(z.uuid()).default([]),
  canEdit: z.boolean().default(false),
  canDelete: z.boolean().default(false),
  viaClaude: z.boolean().default(false),
});
export type ChatMessageView = z.infer<typeof chatMessageSchema>;

export const chatChannelListSchema = z.object({ items: z.array(chatChannelSchema) });
export const chatChannelListQuerySchema = z.object({
  projectId: z.uuid().optional(),
  archived: z.enum(["true", "false"]).default("false"),
});

/** Una pagina di messaggi: dal più vecchio al più nuovo; `before` = il cursore della pagina prima. */
export const chatMessagePageSchema = z.object({
  items: z.array(chatMessageSchema),
  before: z.string().nullable().default(null),
});
export const chatMessagePageQuerySchema = z.object({
  before: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Un thread: la radice e le risposte. */
export const chatThreadSchema = z.object({
  root: chatMessageSchema,
  replies: z.array(chatMessageSchema),
});

/** Le radici dei thread che chi guarda segue, con risposte nuove («Threads»). */
export const chatThreadNewsSchema = z.object({
  items: z.array(
    z.object({
      root: chatMessageSchema,
      unreadReplies: z.number().int().default(0),
    }),
  ),
});

/** I messaggi che nominano chi guarda, nei canali che legge («Mentions»). */
export const chatMentionListSchema = z.object({ items: z.array(chatMessageSchema) });

/** Il punto del binario: c'è qualcosa di nuovo (menzioni o non letti dei canali seguiti). */
export const chatSignalSchema = z.object({
  hasNews: z.boolean().default(false),
  mentions: z.number().int().default(0),
});

// --- Corpi ------------------------------------------------------------------

export const createChatChannelSchema = z.object({
  projectId: z.uuid(),
  name: chatChannelNameSchema,
  description: z.string().trim().max(500).optional(),
  topic: z.string().trim().max(250).optional(),
});
export type CreateChatChannelInput = z.input<typeof createChatChannelSchema>;

/** Patch: gli assenti restano. `archived` archivia o riapre. */
export const patchChatChannelSchema = z
  .object({
    name: chatChannelNameSchema,
    description: z.string().trim().max(500),
    topic: z.string().trim().max(250),
    archived: z.boolean(),
  })
  .partial();
export type PatchChatChannelInput = z.input<typeof patchChatChannelSchema>;

export const postChatMessageSchema = z.object({
  text: z.string().trim().min(1).max(CHAT_MESSAGE_MAX),
  /** Una risposta: la radice del thread (un livello solo). */
  threadRootId: z.uuid().optional(),
});
export type PostChatMessageInput = z.input<typeof postChatMessageSchema>;

export const editChatMessageSchema = z.object({ text: z.string().trim().min(1).max(CHAT_MESSAGE_MAX) });
export const chatReactionBodySchema = z.object({ emoji: z.string().trim().min(1).max(32) });
/** Letto fino a ora (o fino a `at`); con `threadRootId`, il thread. */
export const markChatReadSchema = z.object({
  threadRootId: z.uuid().optional(),
  at: z.iso.datetime().optional(),
});
export const chatChannelPrefSchema = z.object({ level: chatNotifyLevelSchema });
export const chatThreadFollowSchema = z.object({ following: z.boolean() });

// --- Stream -----------------------------------------------------------------

/** Ciò che lo stream SSE di un canale manda: messaggi nuovi o cambiati, e la vista del canale. */
export const chatStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("messages"), messages: z.array(chatMessageSchema) }),
  z.object({ type: z.literal("channel"), channel: chatChannelSchema }),
]);
export type ChatStreamMessage = z.infer<typeof chatStreamMessageSchema>;
