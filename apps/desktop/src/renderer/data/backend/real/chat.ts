import { ApiError } from "@stubwise/api-client";
import type { ChatChannelView, ChatMessageView as ServerMessage, Reader } from "@stubwise/shared";
import type * as Fake from "../../api";
import type {
  CitationRef,
  CitationView,
  ChannelMember,
  ChannelRow,
  ChannelView,
  ChatMessageHit,
  ChatMessageView,
  ChatQuestion,
  ThreadView,
  ThreadWithNews,
} from "../../types";
import { channelName } from "../../../domain/chatLabel";
import { claudeFieldsOf, forgetChatClaudeCaches, loadClaudeExtras, proposalActionsOf } from "./chatClaude";
import { confirmOnServer } from "./claudeChatActions";
import { appClient, session } from "./client";
import { partialNamespace } from "./notIntegrated";
import { listPeople } from "./people";
import { listProjects } from "./projects";
import { createRequestWith } from "./requests";
import { createTaskWith } from "./tasks";

// La Chat fra persone nella build app (integrazione area 4, fetta 1): canali
// di progetto e il «general», messaggi, thread a un livello, reazioni, letti,
// preferenze, menzioni (`/api/chat`, schemi della F1.1). Chi vede, chi scrive e
// chi gestisce lo dice il SERVER (le viste sono di chi guarda): qui si legge,
// non si deduce. Dalla fetta 2 anche DM, privati e generali, la ricerca, le
// domande e task e richieste da un messaggio. Dalla fetta 3 @Claude nei thread
// (la vista in `chatClaude.ts`). Restano «non integrati» gli eventi dei
// progetti e gli allegati (fetta 4).

type Chat = typeof Fake.chat;
type ServerChannel = Reader<ChatChannelView>;
type ServerMsg = Reader<ServerMessage>;

/** I rifiuti del server negli errori del prototipo (`forbidden`, `not_found`, `invalid: …`). */
const INVALID_OF: Record<string, string> = {
  // Fetta 2.
  invalid_members: "members",
  cannot_leave: "last_member",
  last_member: "last_member",
  invalid_also_in_channel: "alsoInChannel",
  chat_message_not_found: "deleted",
  channel_archived: "archived",
  general_channel: "general",
  name_taken: "name_taken",
  deleted: "deleted",
  invalid_thread: "threadOf",
  // Fetta 3 (@Claude).
  invalid_status: "status",
};

/** `invalid400`: cosa dice un 400 di validazione (il nome di un canale, nei dialoghi del canale). */
async function call<T>(run: () => Promise<T>, invalid400 = "input"): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) throw new Error("not_found");
      if (error.status === 403) throw new Error("forbidden");
      const what = error.code ? INVALID_OF[error.code] : undefined;
      if (what) throw new Error(`invalid: ${what}`);
      if (error.status === 400) throw new Error(`invalid: ${invalid400}`);
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

/**
 * Le citazioni che il server ha confermato sui messaggi letti (F2.7): già
 * filtrate per chi guarda, con l'etichetta (codice, titolo, nome). Una
 * citazione che non è qui non si apre e non si nomina (R-G5).
 */
const citedViews = new Map<string, { kind: CitationRef["kind"]; id: string; label: string; projectId: string | null }>();
const citeKey = (kind: string, id: string) => `${kind}\u0000${id}`;

/** I tipi che il server sa citare (gli altri, scelti da «#», non partono). */
const CITABLE = new Set(["task", "request", "project", "person", "doc"]);

/**
 * La vista di una citazione della Chat confermata dal server, o `null`.
 * `codeOf` dà il codice di un progetto per l'indirizzo.
 */
export function chatCitationView(ref: CitationRef, codeOf: (projectId: string) => string | undefined): CitationView | null {
  const c = citedViews.get(citeKey(ref.kind, ref.id));
  if (!c) return null;
  const project = c.projectId ? (codeOf(c.projectId) ?? null) : null;
  const base: CitationView = {
    kind: c.kind,
    id: c.id,
    visible: true,
    code: null,
    name: null,
    projectCode: project,
    status: null,
    personId: null,
    route: null,
  };
  switch (c.kind) {
    case "task":
      return { ...base, code: c.label, route: project ? `#/p/${project}/tasks?task=${c.label}` : null };
    case "request":
      return { ...base, code: c.label, route: project ? `#/p/${project}/requests?request=${c.id}` : null };
    case "project":
      return { ...base, code: c.label, projectCode: c.label, route: `#/p/${c.label}/overview` };
    case "person":
      return { ...base, name: c.label, personId: c.id };
    default:
      // Una pagina dei Docs: il nome; l'area Docs non è ancora integrata (nessun link).
      return { ...base, name: c.label };
  }
}

/** Il canale di un messaggio già letto (lo stream di un thread ascolta quello del canale). */
export const knownChannelOf = (messageId: string): string | undefined =>
  channelOfMessage.get(messageId);

/** Cambio di persona o test: via le memorie della Chat. */
export function forgetPeopleChatCaches(): void {
  channelOfMessage.clear();
  cursorBefore.clear();
  citedViews.clear();
  forgetChatClaudeCaches();
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
    // Fetta 2: i permessi uno per uno, come `channelPermissions` del prototipo
    // (un privato visto da chi lo gestisce senza esserne membro: `canRead` falso).
    canRead: v.canRead,
    isMember: v.isMember,
    canWrite: v.canWrite,
    canJoin: v.canJoin,
    canLeave: v.canLeave,
    canEditInfo: v.canEditInfo,
    canEditTopic: v.canEditTopic,
    canArchive: v.canArchive,
    canDelete: v.canDelete,
    canEditEvents: v.canEditEvents,
    canInvite: v.canInvite,
    canRemove: v.canRemove,
    notifyLevel: v.level === "mentions" || v.level === "muted" ? v.level : "all",
  };
}

function toRow(v: ServerChannel): ChannelRow {
  return {
    ...toChannelView(v),
    unread: v.unread,
    mentions: v.mentions,
    lastActivityAt: v.lastMessageAt,
  };
}

export function toMessage(v: ServerMsg): ChatMessageView {
  channelOfMessage.set(v.id, v.channelId);
  const me = session.personId ?? "";
  // Il momento dell'eliminazione dal server (`deletedAt`); da uno più vecchio
  // basta che ci sia (il testo non c'è più comunque).
  const deletedAt = v.deleted ? (v.deletedAt ?? v.editedAt ?? v.createdAt) : null;
  return {
    id: v.id,
    channelId: v.channelId,
    threadOf: v.threadRootId,
    authorId: v.authorId,
    kind: v.kind === "system" || v.kind === "claude" ? v.kind : "person",
    ...(v.calledById ? { calledById: v.calledById } : {}),
    text: v.deleted ? "" : v.text,
    // Allegati: fetta 4. Le citazioni (F2.7): quelle confermate dal server.
    attachments: [],
    citations: v.citations.flatMap((c) => {
      if (!CITABLE.has(c.kind)) return [];
      const kind = c.kind as CitationRef["kind"];
      citedViews.set(citeKey(kind, c.id), { kind, id: c.id, label: c.label, projectId: c.projectId });
      return [{ kind, id: c.id }];
    }),
    reactions: v.reactions.map((r) => ({ emoji: r.emoji, personIds: [...r.personIds] })),
    asksReplyOf: [...v.asksReplyOf],
    ...(v.alsoInChannel ? { alsoInChannel: true } : {}),
    // Ciò che è nato dal messaggio, filtrato dal server per chi guarda.
    linkedCodes: [...v.linkedCodes],
    createdAt: v.createdAt,
    editedAt: v.editedAt,
    deletedAt,
    deletedById: v.deletedBy,
    // Chi modifica ed elimina lo dice il server.
    canEdit: v.canEdit,
    canDelete: v.canDelete,
    ...claudeFieldsOf(v),
    thread:
      v.threadRootId === null && v.replyCount > 0
        ? {
            replyCount: v.replyCount,
            lastReplyAt: v.lastReplyAt ?? v.createdAt,
            lastReplyById: v.lastReplyById,
            participantIds: [...v.replyParticipantIds],
            hasNews: false,
            following: v.following,
            claudeReplying: v.claudeReplying,
          }
        : null,
    answeredIds: [],
    mentionsViewer: v.mentionedIds.includes(me),
    linkedRefs: v.linked.flatMap((l) => (l.kind === "task" || l.kind === "request" ? [{ kind: l.kind, id: l.id }] : [])),
  };
}

const hitOf = (v: ServerMsg): ChatMessageHit => ({
  channelId: v.channelId,
  message: toMessage(v),
  context: null,
});

// --- letture ----------------------------------------------------------------------------

/** Attivi e archiviati (il prototipo li elenca tutti; «Browse» filtra gli archiviati). */
const listChannels: Chat["listChannels"] = async (options = { scope: "all" }) => {
  const scope = options.scope === "project" ? { projectId: options.projectId } : {};
  const [active, archived] = await Promise.all([
    appClient().chat.channels.list(scope),
    appClient().chat.channels.list({ ...scope, archived: true }),
  ]);
  const seen = new Set<string>();
  return [...active.items, ...archived.items]
    .filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)))
    .map(toRow);
};

const getChannel: Chat["getChannel"] = async (id) => {
  const v = await read(() => appClient().chat.channels.get(id));
  return v ? toChannelView(v) : null;
};

/** Nessuna rotta a sé: i `memberIds` del canale (nel «general», quelli del progetto). */
const listChannelMembers: Chat["listChannelMembers"] = async (id) => {
  const v = await read(() => appClient().chat.channels.get(id));
  if (!v) return null;
  return v.memberIds.map(
    (personId): ChannelMember => ({ personId, isCreator: personId === v.createdBy }),
  );
};

/** Il massimo del server per pagina: oltre si va avanti col cursore. */
const SERVER_PAGE_MAX = 200;

/**
 * La pagina del canale come la chiede il prototipo: gli ultimi `limit`
 * messaggi (il «Load earlier» alza `limit`), o quelli prima di `before`. Il
 * server dà al più 200 radici per pagina col cursore opaco della pagina
 * prima: qui si accumulano le pagine finché bastano, mai oltre i 200.
 */
const listMessages: Chat["listMessages"] = async (channelId, { before, limit = 50 } = {}) => {
  let cursor = before ? cursorBefore.get(before) : undefined;
  // Una pagina prima di un messaggio senza cursore ricordato: niente di più vecchio da chiedere.
  if (before && !cursor) return { messages: [], hasMore: false, lastReadAt: null };
  const channel = before ? null : await read(() => appClient().chat.channels.get(channelId));
  let messages: ChatMessageView[] = [];
  let more = false;
  for (;;) {
    const want = Math.min(limit - messages.length, SERVER_PAGE_MAX);
    const page = await read(() =>
      appClient().chat.messages.page(channelId, {
        ...(cursor ? { before: cursor } : {}),
        limit: want,
      }),
    );
    if (!page) return null;
    messages = [...page.items.map(toMessage), ...messages];
    more = page.before !== null;
    if (page.before && page.items[0]) cursorBefore.set(page.items[0].id, page.before);
    // Si va avanti solo se il server ha dato una pagina piena e ce n'è un'altra.
    if (!more || messages.length >= limit || page.items.length < want) break;
    cursor = page.before ?? undefined;
  }
  return {
    messages,
    hasMore: more,
    // Il divisore dei nuovi: l'ultima lettura di chi guarda, dal canale.
    lastReadAt: channel?.lastReadAt ?? null,
  };
};

/** Prima di leggere le risposte di @Claude: le righe d'azione e i codici, a parte (`chatClaude.ts`). */
const withClaudeExtras = (items: readonly ServerMsg[]) => Promise.all(items.map(loadClaudeExtras));

const getMessage: Chat["getMessage"] = async (id) => {
  const v = await read(() => appClient().chat.messages.get(id));
  if (!v) return null;
  await withClaudeExtras([v]);
  return hitOf(v);
};

const listThread: Chat["listThread"] = async (messageId) => {
  const t = await read(() => appClient().chat.messages.thread(messageId));
  if (!t) return null;
  await withClaudeExtras([t.root, ...t.replies]);
  const view: ThreadView = {
    channelId: t.root.channelId,
    root: toMessage(t.root),
    replies: t.replies.map(toMessage),
    lastReadAt: t.lastReadAt,
  };
  return view;
};

const listThreadsWithNews: Chat["listThreadsWithNews"] = async () => {
  const list = await appClient().chat.threads();
  return list.items.map(
    (item): ThreadWithNews => ({
      channelId: item.root.channelId,
      root: toMessage(item.root),
      latestReplies: item.latestReplies.map(toMessage),
      newCount: item.unreadReplies,
    }),
  );
};

const hasNews: Chat["hasNews"] = async () => (await appClient().chat.signal()).hasNews;

const listMentions: Chat["listMentions"] = async () =>
  (await appClient().chat.mentions()).items.map(hitOf);

// --- scritture ------------------------------------------------------------------------------

/**
 * Un messaggio: il testo, la radice del thread, «anche nel canale» e la
 * domanda forzata (fetta 2). Allegati e citazioni sono delle fette dopo. Le
 * menzioni e chi deve rispondere li ricava il server dal testo.
 */
/** Le citazioni scelte con «#», dei soli tipi che il server sa citare. */
const citationsOf = (refs: readonly CitationRef[] | undefined) =>
  (refs ?? []).flatMap((r) =>
    CITABLE.has(r.kind) ? [{ kind: r.kind as "task" | "request" | "project" | "person" | "doc", id: r.id }] : [],
  );

const sendMessage: Chat["sendMessage"] = async (channelId, input) =>
  toMessage(
    await call(() =>
      appClient().chat.messages.send(channelId, {
        text: input.text,
        ...(input.threadOf ? { threadRootId: input.threadOf } : {}),
        ...(input.alsoInChannel ? { alsoInChannel: true } : {}),
        ...(input.asksReply ? { asksReply: true } : {}),
        ...(citationsOf(input.citations).length ? { citations: citationsOf(input.citations) } : {}),
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
    channelOfMessage.get(rootId) ??
    (await call(() => appClient().chat.messages.get(rootId))).channelId;
  await call(() =>
    appClient().chat.channels.markRead(channelId, { threadRootId: rootId, ...(at ? { at } : {}) }),
  );
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

// --- fetta 2 -----------------------------------------------------------------------------

/** Il DM con queste persone (chi apre compreso o no): quello che c'è, o uno nuovo. */
const openDm: Chat["openDm"] = async (personIds) =>
  toChannelView(await call(() => appClient().chat.openDm(personIds)));

const inviteMembers: Chat["inviteMembers"] = async (channelId, personIds) =>
  toChannelView(await call(() => appClient().chat.channels.invite(channelId, personIds)));

/** Toglie una persona; se chi agisce non vede più il canale (204), la sua ultima vista. */
const removeMember: Chat["removeMember"] = async (channelId, personId) => {
  const view = await call(() => appClient().chat.channels.removeMember(channelId, personId));
  if (view) return toChannelView(view);
  const now = await getChannel(channelId);
  if (!now) throw new Error("not_found");
  return now;
};

/** Il canale come lo legge chi guarda (`AUD · general`, i nomi del DM), per le righe di «Da decidere». */
async function channelLabels(): Promise<(channelId: string) => string> {
  const [channels, projects, people] = await Promise.all([appClient().chat.channels.list(), listProjects(), listPeople()]);
  const me = session.personId ?? "";
  return (channelId) => {
    const ch = channels.items.find((c) => c.id === channelId);
    if (!ch) return "";
    return channelName(
      { ...toChannelView(ch) },
      me,
      (id) => projects.find((p) => p.id === id)?.code,
      (id) => people.find((p) => p.id === id)?.name,
    ).label;
  };
}

/**
 * Una fonte accessoria di un blocco della Home: un 404 (un server che non ha
 * ancora la rotta) è «niente», non un errore che spegne il blocco.
 */
async function orNone<T>(run: () => Promise<{ items: T[] }>): Promise<{ items: T[] }> {
  return (await read(run)) ?? { items: [] };
}

/** Le domande aperte rivolte a chi guarda, col canale come lo legge lui (`AUD · general`, i nomi del DM). */
const listQuestions: Chat["listQuestions"] = async () => {
  const questions = await orNone(() => appClient().chat.questions());
  if (questions.items.length === 0) return [];
  const label = await channelLabels();
  return questions.items.map(
    (q): ChatQuestion => ({
      id: q.id,
      channelId: q.channelId,
      messageId: q.messageId,
      rootId: q.rootId,
      channelLabel: label(q.channelId),
      askedById: q.askedById ?? "",
      text: q.text,
      createdAt: q.createdAt,
    }),
  );
};

const dismissQuestion: Chat["dismissQuestion"] = async (messageId) => {
  await call(() => appClient().chat.dismissQuestion(messageId));
};

/** La ricerca nei canali che chi guarda legge; «con allegati» segue la fetta 4. */
const searchChat: Chat["searchChat"] = async (q, filters = {}) => {
  const result = await appClient().chat.search({
    q,
    ...(filters.channelId ? { channelId: filters.channelId } : {}),
    ...(filters.authorId ? { authorId: filters.authorId } : {}),
    ...(filters.peopleOnly ? { peopleOnly: true } : {}),
    ...(filters.withCitations ? { withCitations: true } : {}),
    ...(filters.from ? { from: filters.from.slice(0, 10) } : {}),
    ...(filters.to ? { to: filters.to.slice(0, 10) } : {}),
  });
  return result.items.map(
    (h): ChatMessageHit => ({
      channelId: h.channelId,
      message: toMessage(h.message),
      context: h.context ? toMessage(h.context) : null,
      root: h.root ? toMessage(h.root) : null,
    }),
  );
};

/** «Create task» da un messaggio: la creazione di sempre, col messaggio da cui nasce. */
const createTaskFromMessage: Chat["createTaskFromMessage"] = async (messageId, input) =>
  call(() => createTaskWith(input, messageId));

/** «Create request»: il codice compare sul messaggio a fine intake (lo scrive il worker). */
const createRequestFromMessage: Chat["createRequestFromMessage"] = async (messageId, input) =>
  call(() => createRequestWith(input, undefined, messageId));

/** Di progetto o generale (`projectId` null), aperto o privato coi suoi membri. */
const createChannel: Chat["createChannel"] = async (input) =>
  toChannelView(
    await call(
      () =>
        appClient().chat.channels.create({
          projectId: input.projectId,
          name: input.name,
          visibility: input.visibility,
          ...(input.description ? { description: input.description } : {}),
          ...(input.visibility === "private" && input.memberIds
            ? { memberIds: input.memberIds }
            : {}),
        }),
      "name",
    ),
  );

const updateChannel: Chat["updateChannel"] = async (channelId, patch) =>
  toChannelView(
    await call(
      () => appClient().chat.channels.update(channelId, patch),
      patch.name !== undefined ? "name" : "input",
    ),
  );

const archiveChannel: Chat["archiveChannel"] = async (channelId, archived = true) =>
  toChannelView(await call(() => appClient().chat.channels.update(channelId, { archived })));

const deleteChannel: Chat["deleteChannel"] = async (channelId) => {
  await call(() => appClient().chat.channels.remove(channelId));
};

// --- @Claude nei thread (fetta 3) ------------------------------------------------------

const stopClaudeReply: Chat["stopClaudeReply"] = async (id) =>
  toMessage(await call(() => appClient().chat.claude.stop(id)));

/** «Try again»: la risposta NUOVA, in fondo al thread. */
const retryClaudeReply: Chat["retryClaudeReply"] = async (id) =>
  toMessage(await call(() => appClient().chat.claude.retry(id)));

/** Solo chi ha chiamato, una volta: chi arriva secondo legge `already_answered`, come nel prototipo. */
const answerChatClaudeQuestion: Chat["answerChatClaudeQuestion"] = async (messageId, questionId, answer) => {
  try {
    await appClient().chat.claude.answer(messageId, { questionId, optionIndex: answer.optionIndex, text: answer.text });
  } catch (error) {
    if (error instanceof ApiError && error.code === "already_answered") {
      throw Object.assign(new Error("already_answered"), { byId: null });
    }
    return call(() => Promise.reject(error));
  }
};

const listClaudeQuestions: Chat["listClaudeQuestions"] = async () => {
  const questions = await orNone(() => appClient().chat.claude.questions());
  if (questions.items.length === 0) return [];
  const label = await channelLabels();
  return questions.items.map((q) => ({
    id: q.id,
    channelId: q.channelId,
    messageId: q.messageId,
    rootId: q.rootId,
    channelLabel: label(q.channelId),
    questionId: q.questionId,
    text: q.text,
    options: q.options.map((o) => ({ label: o.label, ...(o.description ? { consequence: o.description } : {}) })),
    createdAt: q.createdAt,
  }));
};

/**
 * Le rotte delle proposte rispondono 404 anche quando il canale è archiviato
 * o chi conferma non ne è più membro: qui si distingue col canale, per dirlo
 * come il prototipo («archiviato», «non sei più nel canale»).
 */
async function proposalGone(messageId: string): Promise<Error> {
  const channelId = channelOfMessage.get(messageId);
  if (!channelId) return new Error("not_found");
  let ch: ServerChannel | null;
  try {
    // Un 404 (`read` → null) o un 403: non lo si legge più.
    ch = await read(() => appClient().chat.channels.get(channelId));
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return new Error("not_member");
    // Un altro guasto (500, rete) non dice niente sul canale: resta un errore.
    return error instanceof Error ? error : new Error("other");
  }
  if (!ch || !ch.isMember) return new Error("not_member");
  if (ch.archived) return new Error("invalid: archived");
  return new Error("not_found");
}

async function onProposal<T>(messageId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw await proposalGone(messageId);
    throw error;
  }
}

/** Conferma (anche coi valori di «Edit», che il server esegue): la conferma della conversazione. */
const confirmChatProposal: Chat["confirmChatProposal"] = (messageId, proposalId, options = {}) =>
  onProposal(messageId, () => confirmOnServer(proposalId, options));

const cancelChatProposal: Chat["cancelChatProposal"] = async (messageId, proposalId) => {
  await onProposal(messageId, () => appClient().claude.proposals.cancel(proposalId));
};

/** «Edit»: gli argomenti dalla vista (solo chi ha chiamato li ha); riletta se non c'è ancora. */
const editChatProposal: Chat["editChatProposal"] = async (messageId, proposalId, actionIndex = 0) => {
  if (!proposalActionsOf(proposalId)) await getMessage(messageId);
  const action = proposalActionsOf(proposalId)?.[actionIndex];
  if (!action) throw new Error("not_found");
  return { fn: action.fn as Awaited<ReturnType<Chat["editChatProposal"]>>["fn"], args: action.args };
};

/** Le funzioni della fetta 1 (lo stream, in `chatStream.ts`, lo aggiunge `index.ts`). */
export const chatFunctions: Partial<Chat> = {
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
  openDm,
  inviteMembers,
  removeMember,
  listQuestions,
  dismissQuestion,
  searchChat,
  createTaskFromMessage,
  createRequestFromMessage,
  stopClaudeReply,
  retryClaudeReply,
  answerChatClaudeQuestion,
  listClaudeQuestions,
  confirmChatProposal,
  cancelChatProposal,
  editChatProposal,
};

/** Il namespace `chat` senza lo stream (i test del livello dati); il resto resta «non integrato». */
export const chat: Chat = partialNamespace<Chat>("chat", chatFunctions);
