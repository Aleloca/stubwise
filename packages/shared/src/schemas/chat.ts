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
  /**
   * Almeno un'azione di gestione (`canEditInfo`, `canArchive` o `canDelete`).
   * C'è dalla fetta 1; dalla fetta 2 i permessi sono quelli singoli qui sotto.
   */
  canManage: z.boolean().default(false),
  /**
   * Legge i messaggi. Di un privato di cui non è membro, chi gestisce l'ambito
   * vede nome e membri ma non legge (D2). Default `true`: un server della
   * fetta 1 manda solo canali aperti, che chi li vede legge.
   */
  canRead: z.boolean().default(true),
  /** Nome e descrizione: il creatore o chi gestisce l'ambito; mai il «general» né un DM. */
  canEditInfo: z.boolean().default(false),
  /** L'argomento: qualunque membro, in un canale non archiviato (non un DM). */
  canEditTopic: z.boolean().default(false),
  /** Gli eventi pubblicati: solo i canali di progetto, il creatore o chi gestisce. */
  canEditEvents: z.boolean().default(false),
  /** Aggiungere persone: in un privato il creatore o chi gestisce; in un aperto un membro. */
  canInvite: z.boolean().default(false),
  /** Togliere persone: il creatore o chi gestisce (mai nel «general» né in un DM). */
  canRemove: z.boolean().default(false),
  /** Archiviare o riaprire: il creatore o chi gestisce; mai il «general» né un DM. */
  canArchive: z.boolean().default(false),
  /** Eliminare: solo chi gestisce i canali dell'ambito (R-G3), non il creatore. */
  canDelete: z.boolean().default(false),
  /** I non letti di chi guarda, e quanti lo nominano direttamente. */
  unread: z.number().int().default(0),
  mentions: z.number().int().default(0),
  level: chatNotifyLevelSchema.default("all"),
  /** Fin dove chi guarda ha letto il canale (il divisore «nuovi messaggi»); null = mai. */
  lastReadAt: z.iso.datetime().nullable().default(null),
  lastMessageAt: z.iso.datetime().nullable().default(null),
  publishedEvents: z.array(chatEventKindSchema).default([]),
});
export type ChatChannelView = z.infer<typeof chatChannelSchema>;

/**
 * Gli oggetti che un messaggio può citare nella fetta 2 (decisione del
 * maintainer, 10 nov 2026). Traguardi, Release, brief, file del repo e Drive
 * arrivano con le fette 4 e 5.
 */
export const CHAT_CITATION_KINDS = ["task", "request", "project", "person", "doc"] as const;
export const chatCitationKindSchema = z.enum(CHAT_CITATION_KINDS);
export type ChatCitationKind = z.infer<typeof chatCitationKindSchema>;

/** Una citazione scelta nella casella («#»/«@»): il client manda solo tipo e id. */
export const chatCitationRefSchema = z.object({ kind: chatCitationKindSchema, id: z.uuid() });
export type ChatCitationRef = z.infer<typeof chatCitationRefSchema>;

/**
 * Una citazione come la legge chi guarda: solo ciò che vede. `label` è il
 * codice (task, richiesta, progetto), il titolo (pagina) o il nome (persona).
 */
export const chatCitationSchema = z.object({
  kind: chatCitationKindSchema,
  id: z.uuid(),
  label: z.string(),
  /** Il progetto dell'oggetto, quando ne ha uno (per aprirlo nel posto giusto). */
  projectId: z.uuid().nullable().default(null),
});
export type ChatCitationView = z.infer<typeof chatCitationSchema>;

/** Lo stato di una risposta di @Claude (fetta 3). */
export const chatClaudeStateSchema = z.enum(["working", "waiting", "done", "failed", "stopped"]);
export const chatClaudeErrorSchema = z.enum(["forbidden", "not_found", "budget", "other"]);

/** Una proposta di una risposta di @Claude, come la legge chi guarda (gli argomenti solo a chi ha chiamato). */
export const chatClaudeProposalSchema = z.object({
  id: z.uuid(),
  summary: z.string(),
  status: z.enum(["open", "confirmed", "cancelled", "failed", "expired"]),
  /** Sempre B nella Chat: niente esecuzione immediata, niente «Annulla». */
  cls: z.enum(["A", "B", "C"]).default("B"),
  actions: z.array(z.object({ fn: z.string(), args: z.record(z.string(), z.unknown()) })).default([]),
  /** I codici nati dalla conferma, solo quelli che chi guarda vede. */
  resultCodes: z.array(z.string()).default([]),
  canConfirm: z.boolean().default(false),
  canCancel: z.boolean().default(false),
});

/** La domanda che Claude fa a chi l'ha chiamato (R-G4): la vedono tutti, risponde solo lui. */
export const chatClaudeQuestionSchema = z.object({
  id: z.uuid(),
  text: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().default("") })),
  answer: z
    .object({ optionIndex: z.number().int().nullable(), text: z.string().nullable(), byId: z.uuid().nullable(), at: z.iso.datetime() })
    .nullable()
    .default(null),
  canAnswer: z.boolean().default(false),
});

/** Il blocco di una risposta di @Claude (fetta 3); `null` sugli altri messaggi. */
export const chatClaudeReplySchema = z.object({
  state: chatClaudeStateSchema,
  error: chatClaudeErrorSchema.nullable().default(null),
  retried: z.boolean().default(false),
  /** Il messaggio che l'ha chiamata (per «Try again» e il contesto). */
  callMessageId: z.uuid().nullable().default(null),
  /** La sessione con «cosa ha letto»: SOLO per chi ha chiamato (D5), `null` per gli altri. */
  sessionId: z.uuid().nullable().default(null),
  proposals: z.array(chatClaudeProposalSchema).default([]),
  question: chatClaudeQuestionSchema.nullable().default(null),
  canStop: z.boolean().default(false),
  canRetry: z.boolean().default(false),
});
export type ChatClaudeReplyView = z.infer<typeof chatClaudeReplySchema>;

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
  deletedAt: z.iso.datetime().nullable().default(null),
  deletedBy: z.uuid().nullable().default(null),
  reactions: z.array(chatReactionSchema).default([]),
  /** Solo su una radice: le risposte e l'ultima. */
  replyCount: z.number().int().default(0),
  lastReplyAt: z.iso.datetime().nullable().default(null),
  lastReplyById: z.uuid().nullable().default(null),
  /** Solo su una radice: chi ha risposto (persone, senza ripetizioni, in ordine di prima risposta). */
  replyParticipantIds: z.array(z.uuid()).default([]),
  /** Chi guarda segue il thread di questa radice. */
  following: z.boolean().default(false),
  /** Le persone nominate direttamente (`@Nome`), le ricava il server. */
  mentionedIds: z.array(z.uuid()).default([]),
  canEdit: z.boolean().default(false),
  canDelete: z.boolean().default(false),
  viaClaude: z.boolean().default(false),
  /** Una risposta mandata «anche nel canale»: compare anche nel flusso del canale. */
  alsoInChannel: z.boolean().default(false),
  /** Le persone a cui il messaggio chiede una risposta (le ricava il server). */
  asksReplyOf: z.array(z.uuid()).default([]),
  /**
   * Le task e le richieste nate dal messaggio («→ AUD-14»): solo quelle che
   * chi guarda vede, derivate a lettura. `linkedCodes` sono i loro codici.
   */
  linked: z.array(z.object({ kind: z.enum(["task", "request"]), id: z.uuid(), code: z.string() })).default([]),
  linkedCodes: z.array(z.string()).default([]),
  /** Le citazioni (fetta 2, F2.7): solo quelle che chi guarda vede, in ordine. Un eliminato non ne ha. */
  citations: z.array(chatCitationSchema).default([]),
  /** Solo una risposta di @Claude (fetta 3): stato, proposte, domanda. */
  claude: chatClaudeReplySchema.nullable().default(null),
  /** Su una radice: una risposta di Claude nel suo thread sta lavorando. */
  claudeReplying: z.boolean().default(false),
});
export type ChatMessageView = z.infer<typeof chatMessageSchema>;

export const chatChannelListSchema = z.object({ items: z.array(chatChannelSchema) });
export const chatChannelListQuerySchema = z.object({
  projectId: z.uuid().optional(),
  /** Solo un tipo (`general`, `dm`…). */
  kind: chatChannelKindSchema.optional(),
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
  /** Fin dove chi guarda ha letto il thread; null = mai. */
  lastReadAt: z.iso.datetime().nullable().default(null),
});

/** Le radici dei thread che chi guarda segue, con risposte nuove («Threads»). */
export const chatThreadNewsSchema = z.object({
  items: z.array(
    z.object({
      root: chatMessageSchema,
      unreadReplies: z.number().int().default(0),
      /** Le ultime risposte (al più 3), dalla più vecchia. */
      latestReplies: z.array(chatMessageSchema).default([]),
    }),
  ),
});

/**
 * Un risultato della ricerca: il messaggio, il messaggio vivo prima di lui
 * nello stesso flusso (contesto) e, per una risposta, la radice del thread.
 */
export const chatMessageHitSchema = z.object({
  channelId: z.uuid(),
  message: chatMessageSchema,
  context: chatMessageSchema.nullable().default(null),
  root: chatMessageSchema.nullable().default(null),
});
export const chatSearchResultSchema = z.object({ items: z.array(chatMessageHitSchema) });
export const CHAT_SEARCH_MIN = 2;
export const chatSearchQuerySchema = z.object({
  q: z.string().trim().max(200),
  channelId: z.uuid().optional(),
  authorId: z.uuid().optional(),
  peopleOnly: z.enum(["true", "false"]).optional(),
  /** Solo i messaggi con almeno una citazione. */
  withCitations: z.enum(["true", "false"]).optional(),
  /** Giorni ISO (`YYYY-MM-DD`), inclusi, in UTC. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Una domanda rivolta a chi guarda, in «Da decidere»: finché non risponde
 * (nel thread o, per un messaggio del canale, nel canale) o non la ignora.
 */
export const chatQuestionSchema = z.object({
  /** `chat:<messageId>`, come il prototipo. */
  id: z.string(),
  channelId: z.uuid(),
  messageId: z.uuid(),
  /** Dove rispondere: la radice del thread (il messaggio stesso se è nel canale). */
  rootId: z.uuid(),
  askedById: z.uuid().nullable(),
  text: z.string(),
  createdAt: z.iso.datetime(),
});
export const chatQuestionListSchema = z.object({ items: z.array(chatQuestionSchema) });

/** Le domande di @Claude a chi guarda, ancora aperte («Da decidere», `chatClaudeQuestionsOf` del prototipo). */
export const chatClaudeQuestionItemSchema = z.object({
  /** `chat-claude:<risposta>:<domanda>`, come il prototipo. */
  id: z.string(),
  channelId: z.uuid(),
  messageId: z.uuid(),
  rootId: z.uuid(),
  questionId: z.uuid(),
  text: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().default("") })),
  createdAt: z.iso.datetime(),
});
export const chatClaudeQuestionListSchema = z.object({ items: z.array(chatClaudeQuestionItemSchema) });
export const answerChatClaudeQuestionSchema = z
  .object({
    questionId: z.uuid(),
    optionIndex: z.number().int().min(0).nullable().default(null),
    text: z.string().trim().max(2000).nullable().default(null),
  })
  .refine((b) => b.optionIndex !== null || (b.text !== null && b.text !== ""), { message: "answer" });

/** I messaggi che nominano chi guarda, nei canali che legge («Mentions»). */
export const chatMentionListSchema = z.object({ items: z.array(chatMessageSchema) });

/** Il punto del binario: c'è qualcosa di nuovo (menzioni o non letti dei canali seguiti). */
export const chatSignalSchema = z.object({
  hasNews: z.boolean().default(false),
  mentions: z.number().int().default(0),
});

// --- Corpi ------------------------------------------------------------------

/** Un DM può avere al più 8 persone, compresa chi lo apre. */
export const CHAT_DM_MAX_PEOPLE = 8;

/** Senza `projectId` (o con `null`): un canale generale d'istanza. */
export const createChatChannelSchema = z.object({
  projectId: z.uuid().nullable().optional(),
  name: chatChannelNameSchema,
  description: z.string().trim().max(500).optional(),
  topic: z.string().trim().max(250).optional(),
  visibility: chatChannelVisibilitySchema.default("open"),
  /** Solo un privato: chi invitare subito (chi crea c'è sempre). */
  memberIds: z.array(z.uuid()).max(200).optional(),
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
  /** Solo una risposta: «Rispondi anche nel canale». */
  alsoInChannel: z.boolean().optional(),
  /** «Ask for a reply»: chiede risposta alle persone nominate anche senza «?». */
  asksReply: z.boolean().optional(),
  /** Gli oggetti scelti con «#»/«@»: il server tiene quelli che chi scrive vede e che il testo nomina. */
  citations: z.array(chatCitationRefSchema).max(50).optional(),
});
export type PostChatMessageInput = z.input<typeof postChatMessageSchema>;

/** Le citazioni si ricalcolano dal testo nuovo; `citations` aggiunge scelte nuove. */
export const editChatMessageSchema = z.object({
  text: z.string().trim().min(1).max(CHAT_MESSAGE_MAX),
  citations: z.array(chatCitationRefSchema).max(50).optional(),
});
export const chatReactionBodySchema = z.object({ emoji: z.string().trim().min(1).max(32) });
/** Letto fino a ora (o fino a `at`); con `threadRootId`, il thread. */
export const markChatReadSchema = z.object({
  threadRootId: z.uuid().optional(),
  at: z.iso.datetime().optional(),
});
export const chatChannelPrefSchema = z.object({ level: chatNotifyLevelSchema });
export const chatThreadFollowSchema = z.object({ following: z.boolean() });
/** Aggiungere persone a un canale. */
export const inviteChatMembersSchema = z.object({ personIds: z.array(z.uuid()).min(1).max(200) });
/** Aprire (o ritrovare) un DM con queste persone, oltre a chi lo apre. */
export const openChatDmSchema = z.object({
  personIds: z.array(z.uuid()).min(1).max(CHAT_DM_MAX_PEOPLE),
});

// --- Stream -----------------------------------------------------------------

/** Ciò che lo stream SSE di un canale manda: messaggi nuovi o cambiati, e la vista del canale. */
/**
 * Il cursore dello stream: i microsecondi dall'epoca dell'ultimo cambio visto,
 * solo cifre (un URL e l'allowlist del main desktop lo accettano così com'è).
 * Va ripassato come `?after=` alla riconnessione.
 */
export const CHAT_STREAM_CURSOR_RE = /^\d{1,20}$/;
export const chatStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("messages"),
    messages: z.array(chatMessageSchema),
    /** Da ripassare come `after`; null se non ci sono ancora messaggi. */
    cursor: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal("channel"), channel: chatChannelSchema }),
]);
export type ChatStreamMessage = z.infer<typeof chatStreamMessageSchema>;
