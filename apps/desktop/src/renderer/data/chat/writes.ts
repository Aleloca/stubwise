// Le scritture usano `createTaskAs`/`createRequestAs` solo dentro le
// funzioni: l'import circolare con `api-mutations` è innocuo.
import { createRequestAs, createTaskAs, type NewRequestInput } from "../api-mutations";
import { findCodes } from "../../domain/claude/parse";
import { DOC_PAGES } from "../seed/docPages";
import { REPO_FILES } from "../seed/repoFiles";
import {
  chatKey,
  chatNow,
  gate,
  newId,
  state,
  storeGeneration,
  visibleProjectIds,
  visibleTasks,
} from "../store";
import {
  channelStream,
  notifyChatChange,
  patchChatMessage,
  recheckChatSubscribers,
  runScript,
  threadStream,
} from "../stream";
import type {
  Channel,
  CitationRef,
  ChannelPatch,
  ChannelView,
  ChatEventKind,
  ChatMessage,
  ChatMessageInput,
  ChatMessageView,
  NewChannelInput,
  NewTaskInput,
  NotifyLevel,
  ProjectRequest,
  ReadState,
  Task,
} from "../types";
import { can, viewerFor } from "../viewer";
import { callClaudeIfAsked, haltReply } from "./claude";
import { mentionKindFor, mentionsName, questionTargets } from "./mentions";
import { PEOPLE } from "../seed/people";
import {
  channelById,
  channelData,
  channelFlow,
  channelView,
  chatQuestionsOf,
  liveReplies,
  presentMessage,
  readStateOf,
  readableChannel,
  readableMessage,
  scrubDeleted,
  seenChannel,
} from "./reads";
import {
  canReadChannel,
  channelPermissions,
  isHuman,
  membersOf,
  notifyLevelOf,
} from "./visibility";

// Le scritture della Chat, come le altre del «server» finto: ognuna passa da
// `gate()` (quindi `failNext` la fa fallire), legge chi agisce dalla
// sessione e verifica tutto prima di scrivere — un canale che non vede è
// `not_found`, un'azione che non gli spetta `forbidden`, un dato che non va
// `invalid: …`. Dopo un rifiuto lo stato è intatto. I permessi di un canale
// sono quelli di `channelPermissions` (visibility.ts), gli stessi che legge
// la UI. Un messaggio nuovo entra solo da `runScript` (passo `post`).

const forbidden = () => new Error("forbidden");
const notFound = () => new Error("not_found");
const invalid = (what: string) => new Error(`invalid: ${what}`);

/** Tutti gli eventi di progetto, nell'ordine delle impostazioni del canale. */
export const CHAT_EVENT_KINDS: readonly ChatEventKind[] = [
  "release_page",
  "milestone_reached",
  "brief_ready",
  "pr_opened",
  "pr_merged",
  "request_new",
  "task_closed",
];

/** Le persone di un DM, compreso chi lo apre. */
export const DM_MAX_PEOPLE = 8;

/** Il nome di un canale: minuscole, numeri e trattini, al più 40 caratteri. */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 40;

/** Il nome come lo scrive la casella: minuscole, spazi in trattini. */
export function normalizeChannelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Un istante subito prima di `at` (per seguire un thread con la sola risposta di adesso da leggere). */
const justBefore = (at: string): string =>
  new Date(Date.parse(at) - 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** L'ultimo messaggio del flusso del canale (o la sua nascita). */
function latestInChannel(ch: Channel): string {
  const flow = channelFlow(channelData(ch));
  return flow.at(-1)?.createdAt ?? ch.createdAt;
}

/** La lettura della persona nel canale; nasce «tutto letto» se non c'è ancora. */
function ensureReadState(personId: string, ch: Channel): ReadState {
  const key = chatKey(personId, ch.id);
  let read = state.chatReads.get(key);
  if (!read) {
    read = { personId, channelId: ch.id, lastReadAt: latestInChannel(ch), threadReads: {} };
    state.chatReads.set(key, read);
  }
  return read;
}

/** Toglie a una persona ciò che aveva in un canale da cui esce: lettura e preferenza. */
function forgetMember(personId: string, channelId: string): void {
  state.chatReads.delete(chatKey(personId, channelId));
  state.chatNotify.delete(chatKey(personId, channelId));
}

function seen(me: string, id: string): Channel {
  const ch = seenChannel(me, id);
  if (!ch) throw notFound();
  return ch;
}

function readable(me: string, id: string): Channel {
  const ch = readableChannel(me, id);
  if (!ch) throw notFound();
  return ch;
}

function message(me: string, id: string): { m: ChatMessage; ch: Channel } {
  const found = readableMessage(me, id);
  if (!found) throw notFound();
  return { m: found.message, ch: found.data.ch };
}

/** Il canale è scrivibile dalla persona: membro, non archiviato. */
function writable(me: string, ch: Channel): void {
  if (!channelPermissions(me, ch).isMember) throw forbidden();
  if (ch.archived) throw invalid("archived");
}

const view = (me: string, ch: Channel): ChannelView => channelView(me, ch);

// --- messaggi -------------------------------------------------------------------

/**
 * Le menzioni di un messaggio nuovo: una notifica a chi è nominato e legge
 * il canale (@channel e @reparto solo a chi ha «tutti i messaggi»; le
 * dirette sempre), e chi è nominato
 * in un thread lo segue (con la sola risposta di adesso da leggere).
 */
function deliverMentions(m: ChatMessage, ch: Channel): void {
  const members = membersOf(ch);
  const candidates = new Set([...members, ...m.asksReplyOf]);
  for (const personId of candidates) {
    const kind = mentionKindFor(m, personId, members);
    if (kind === null || !canReadChannel(personId, ch)) continue;
    // @channel e @reparto avvisano solo chi ha «tutti i messaggi»; le dirette sempre.
    if (kind === "group" && notifyLevelOf(personId, ch.id) !== "all") continue;
    state.notifications.push({
      id: newId("n-chat"),
      kind: m.asksReplyOf.includes(personId) ? "chat.question" : "chat.mention",
      projectId: ch.projectId,
      objectCode: "",
      departmentId: null,
      recipientIds: [personId],
      // Titolo e testo si derivano a lettura dal messaggio (`presentChatNotification`).
      title: "",
      body: "",
      createdAt: m.createdAt,
      read: false,
      archived: false,
      snoozedUntil: null,
      link: "",
      chatMessageId: m.id,
    });
    if (m.threadOf !== null && members.includes(personId)) follow(personId, ch, m);
  }
}

/**
 * Il testo nomina ancora l'oggetto citato: il codice di una task, di una
 * richiesta o di un progetto, il titolo di una pagina, il percorso di un
 * file (come li inserisce «#»), «@Nome» di una persona, il nome di un
 * traguardo, la versione o il titolo di una pagina di Release, la prima
 * frase di un brief. Tolto dal testo con una modifica, non resta citato.
 */
function stillNamed(ref: CitationRef, text: string): boolean {
  switch (ref.kind) {
    case "task": {
      const code = state.tasksById.get(ref.id)?.code;
      return code !== undefined && text.includes(code);
    }
    case "request": {
      const code = state.requests.find((r) => r.id === ref.id)?.code;
      return code !== undefined && text.includes(code);
    }
    case "project": {
      const code = state.projectsById.get(ref.id)?.code;
      return code !== undefined && text.includes(code);
    }
    case "doc": {
      const title = DOC_PAGES.find((d) => d.id === ref.id)?.title;
      return title !== undefined && text.includes(title);
    }
    case "file": {
      const path = REPO_FILES.find((f) => f.id === ref.id)?.path;
      return path !== undefined && text.includes(path);
    }
    case "person": {
      const name = PEOPLE.find((p) => p.id === ref.id)?.name;
      return name !== undefined && mentionsName(text, name);
    }
    case "milestone": {
      const name = state.milestones.find((m) => m.id === ref.id)?.name;
      return name !== undefined && text.includes(name);
    }
    case "release": {
      const page = state.releasePages.find((r) => r.id === ref.id);
      return page !== undefined && (text.includes(page.version) || text.includes(page.title));
    }
    case "brief": {
      const headline = state.briefs.find((b) => b.id === ref.id)?.headline;
      const first = headline?.split(/(?<=\.)\s/)[0];
      return first !== undefined && text.includes(first);
    }
  }
}

/**
 * Le citazioni di un messaggio: quelle scelte nella casella che il testo
 * nomina ancora, più i codici scritti a mano («AUD-88») di task e richieste
 * che chi scrive vede — un codice diventa link da sé. Un codice che chi
 * scrive non vede resta testo. Alla modifica si ricalcolano dal testo nuovo:
 * un codice tolto dal testo non resta citato.
 */
function citationsOf(me: string, text: string, picked: readonly CitationRef[]): CitationRef[] {
  const out = structuredClone(picked.filter((ref) => stillNamed(ref, text)));
  const has = (ref: CitationRef) => out.some((r) => r.kind === ref.kind && r.id === ref.id);
  const visible = visibleProjectIds(me);
  for (const { code, kind } of findCodes(text)) {
    const id =
      kind === "task"
        ? visibleTasks(me).find((t) => t.code === code)?.id
        : state.requests.find((r) => r.code === code && visible.has(r.projectId))?.id;
    if (id && !has({ kind, id })) out.push({ kind, id });
  }
  return out;
}

/** La persona segue il thread di `m` (se non lo seguiva, con `m` da leggere). */
function follow(personId: string, ch: Channel, m: ChatMessage): void {
  const read = ensureReadState(personId, ch);
  const rootId = m.threadOf ?? m.id;
  read.threadReads[rootId] ??= justBefore(m.createdAt);
}

/**
 * Scrive un messaggio nel canale o, con `threadOf`, nel thread di una
 * radice. Solo un membro (in un aperto si entra prima con «Join channel»:
 * nessun ingresso silenzioso), mai in un archiviato. Chi scrive ha letto
 * fin qui e segue il thread; lo segue anche chi ha scritto la radice.
 */
export async function sendMessage(
  channelId: string,
  input: ChatMessageInput,
): Promise<ChatMessageView> {
  const me = await gate("chat.sendMessage");
  const gen = storeGeneration();
  const ch = readable(me, channelId);
  writable(me, ch);
  const text = input.text.trim();
  const attachments = input.attachments ?? [];
  if (!text && attachments.length === 0) throw invalid("text");
  let root: ChatMessage | null = null;
  if (input.threadOf !== undefined) {
    const found = readableMessage(me, input.threadOf);
    if (!found || found.data.ch.id !== ch.id) throw notFound();
    if (found.message.threadOf !== null) throw invalid("threadOf");
    root = found.message;
  }
  if (input.alsoInChannel && !root) throw invalid("alsoInChannel");

  const at = chatNow();
  const m: ChatMessage = {
    id: root ? newId(root.id) : newId(ch.id),
    channelId: ch.id,
    threadOf: root?.id ?? null,
    authorId: me,
    kind: "person",
    text,
    attachments: structuredClone(attachments),
    citations: citationsOf(me, text, input.citations ?? []),
    reactions: [],
    asksReplyOf: questionTargets(text, me, input.asksReply === true),
    linkedCodes: [],
    createdAt: at,
    editedAt: null,
    deletedAt: null,
    deletedById: null,
  };
  if (root && input.alsoInChannel) m.alsoInChannel = true;

  await runScript(
    root ? threadStream(root.id) : channelStream(ch.id),
    [{ step: "post", message: m }],
    gen,
  );
  if (gen !== storeGeneration()) throw new Error("reset");
  // Il passo `post` lo scarta se nel frattempo il canale è stato archiviato o chi scrive ne è uscito.
  if (!state.chatMessages.includes(m)) throw ch.archived ? invalid("archived") : forbidden();

  const read = ensureReadState(me, ch);
  if (!root || m.alsoInChannel) read.lastReadAt = at;
  if (root) {
    read.threadReads[root.id] = at;
    if (root.authorId !== null && root.kind === "person" && membersOf(ch).includes(root.authorId)) {
      follow(root.authorId, ch, m);
    }
  }
  deliverMentions(m, ch);
  notifyChatChange(ch.id);
  // «@Claude»: la risposta nasce subito nel thread, a nome di chi scrive.
  await callClaudeIfAsked(me, ch, m, gen);
  return presentMessage(me, m);
}

/** Il messaggio è di chi agisce: il suo, o una risposta di @Claude che ha chiamato lui. */
const ownMessage = (me: string, m: ChatMessage): boolean =>
  (m.kind === "person" && m.authorId === me) || (m.kind === "claude" && m.calledById === me);

/**
 * Modifica il testo di un proprio messaggio (mai quello di altri, né una
 * risposta di Claude). Le domande seguono il testo nuovo: chi non è più
 * nominato non aspetta più.
 */
export async function editMessage(id: string, text: string): Promise<ChatMessageView> {
  const me = await gate("chat.editMessage");
  const { m, ch } = message(me, id);
  if (m.kind !== "person" || m.authorId !== me) throw forbidden();
  if (m.deletedAt !== null) throw invalid("deleted");
  writable(me, ch);
  const trimmed = text.trim();
  if (!trimmed && m.attachments.length === 0) throw invalid("text");
  const asked = questionTargets(trimmed, me);
  const kept = m.asksReplyOf.filter((p) => questionTargets(trimmed, me, true).includes(p));
  const updated = patchChatMessage(m.id, {
    text: trimmed,
    citations: citationsOf(me, trimmed, m.citations),
    editedAt: chatNow(),
    asksReplyOf: [...new Set([...kept, ...asked])],
  });
  return presentMessage(me, updated);
}

/**
 * Elimina un proprio messaggio (o la risposta di @Claude che si è chiamato):
 * il testo sparisce ovunque, con allegati, citazioni, reazioni e domande.
 * Senza risposte, dopo un giorno sparisce anche la riga.
 */
export async function deleteMessage(id: string): Promise<void> {
  const me = await gate("chat.deleteMessage");
  const { m, ch } = message(me, id);
  if (!ownMessage(me, m)) throw forbidden();
  if (m.deletedAt !== null) throw invalid("deleted");
  if (ch.archived) throw invalid("archived");
  // Una risposta di @Claude che sta ancora arrivando si ferma con lei: le
  // sue proposte aperte decadono con il testo (nessun esito da mostrare).
  if (m.kind === "claude" && m.claudeRun?.state === "working") haltReply(m, "stopped");
  const scrubbed = structuredClone(m);
  scrubDeleted(scrubbed);
  patchChatMessage(m.id, {
    text: scrubbed.text,
    attachments: scrubbed.attachments,
    citations: scrubbed.citations,
    reactions: scrubbed.reactions,
    asksReplyOf: scrubbed.asksReplyOf,
    linkedCodes: scrubbed.linkedCodes,
    ...(scrubbed.claudeEvents ? { claudeEvents: scrubbed.claudeEvents } : {}),
    deletedAt: chatNow(),
    deletedById: me,
  });
}

/** Mette o toglie la propria reazione con `emoji` (membri, canale non archiviato). */
export async function toggleReaction(id: string, emoji: string): Promise<ChatMessageView> {
  const me = await gate("chat.toggleReaction");
  const { m, ch } = message(me, id);
  writable(me, ch);
  if (m.deletedAt !== null) throw invalid("deleted");
  if (!emoji.trim()) throw invalid("emoji");
  const reactions = structuredClone(m.reactions);
  const existing = reactions.find((r) => r.emoji === emoji);
  if (!existing) reactions.push({ emoji, personIds: [me] });
  else if (existing.personIds.includes(me)) {
    existing.personIds = existing.personIds.filter((p) => p !== me);
  } else existing.personIds.push(me);
  return presentMessage(
    me,
    patchChatMessage(m.id, { reactions: reactions.filter((r) => r.personIds.length > 0) }),
  );
}

// --- letture e preferenze personali ---------------------------------------------

/**
 * Segna letto il canale fino a `at` (di base l'ultimo messaggio). Un `at`
 * più vecchio rimette i messaggi dopo fra i non letti («Mark unread from
 * here»). Per chi non è membro non c'è nulla da segnare.
 */
export async function markRead(channelId: string, at?: string): Promise<void> {
  const me = await gate("chat.markRead");
  const ch = readable(me, channelId);
  if (!membersOf(ch).includes(me)) return;
  ensureReadState(me, ch).lastReadAt = at ?? latestInChannel(ch);
  notifyChatChange(ch.id);
}

/** Segna letto un thread che si segue, fino a `at` (di base l'ultima risposta). */
export async function markThreadRead(rootId: string, at?: string): Promise<void> {
  const me = await gate("chat.markThreadRead");
  const { m, ch } = message(me, rootId);
  const read = readStateOf(me, ch.id);
  const id = m.threadOf ?? m.id;
  if (!read || read.threadReads[id] === undefined) return;
  const last = liveReplies(channelData(ch), id).at(-1)?.createdAt ?? m.createdAt;
  read.threadReads[id] = at ?? last;
  notifyChatChange(ch.id);
}

/** Segue o smette di seguire un thread («Follow/Unfollow thread»); solo un membro. */
export async function setThreadFollow(rootId: string, following: boolean): Promise<void> {
  const me = await gate("chat.setThreadFollow");
  const { m, ch } = message(me, rootId);
  if (!membersOf(ch).includes(me)) throw forbidden();
  const id = m.threadOf ?? m.id;
  const read = ensureReadState(me, ch);
  if (following) {
    read.threadReads[id] ??= liveReplies(channelData(ch), id).at(-1)?.createdAt ?? m.createdAt;
  } else delete read.threadReads[id];
  notifyChatChange(ch.id);
}

/** Le notifiche del canale per chi guarda: tutti, solo menzioni, silenziato. */
export async function setNotifyLevel(channelId: string, level: NotifyLevel): Promise<void> {
  const me = await gate("chat.setNotifyLevel");
  const ch = readable(me, channelId);
  if (!membersOf(ch).includes(me)) throw forbidden();
  if (!["all", "mentions", "muted"].includes(level)) throw invalid("level");
  if (level === "all") state.chatNotify.delete(chatKey(me, ch.id));
  else state.chatNotify.set(chatKey(me, ch.id), level);
  notifyChatChange(ch.id);
}

/** Ignora una domanda della Chat in «Da decidere». */
export async function dismissQuestion(messageId: string): Promise<void> {
  const me = await gate("chat.dismissQuestion");
  if (!chatQuestionsOf(me).some((q) => q.messageId === messageId)) throw notFound();
  state.chatDismissed.add(chatKey(me, messageId));
  const ch = channelById(state.chatMessages.find((m) => m.id === messageId)!.channelId)!;
  notifyChatChange(ch.id);
}

// --- canali ---------------------------------------------------------------------

/** «Join channel»: un aperto che si legge, non archiviato (mai il «general», che segue il progetto). */
export async function joinChannel(channelId: string): Promise<ChannelView> {
  const me = await gate("chat.joinChannel");
  const ch = seen(me, channelId);
  if (!channelPermissions(me, ch).canJoin) throw forbidden();
  ch.memberIds = [...ch.memberIds, me];
  ensureReadState(me, ch);
  notifyChatChange(ch.id);
  return view(me, ch);
}

/**
 * Esce dal canale. Il «general» del progetto e un DM a due non si lasciano;
 * un privato non resta senza membri.
 */
export async function leaveChannel(channelId: string): Promise<void> {
  const me = await gate("chat.leaveChannel");
  const ch = seen(me, channelId);
  if (!channelPermissions(me, ch).canLeave) throw forbidden();
  ch.memberIds = ch.memberIds.filter((p) => p !== me);
  forgetMember(me, ch.id);
  recheckChatSubscribers();
  notifyChatChange(ch.id);
}

/**
 * Crea un canale: di progetto con `chat.channels.create` in quel progetto,
 * generale con `chat.general.create`. Nome unico nell'ambito. Un aperto
 * nasce con il solo creatore; un privato anche con le persone invitate
 * (in un progetto solo i suoi membri). Di progetto: pubblica Release,
 * traguardi e brief.
 */
export async function createChannel(input: NewChannelInput): Promise<ChannelView> {
  const me = await gate("chat.createChannel");
  const viewer = viewerFor(me);
  if (input.projectId !== null) {
    const project = state.projectsById.get(input.projectId);
    if (!project || !can(viewer, "chat.channels.create", input.projectId)) {
      throw project && visibleProjectIds(me).has(project.id) ? forbidden() : notFound();
    }
  } else if (!can(viewer, "chat.general.create")) throw forbidden();
  const name = normalizeChannelName(input.name);
  if (!NAME_RE.test(name) || name.length > NAME_MAX) throw invalid("name");
  const taken = state.channels.some(
    (c) => c.kind !== "dm" && c.projectId === input.projectId && c.name === name,
  );
  if (taken) throw invalid("name_taken");
  if (!["open", "private"].includes(input.visibility)) throw invalid("visibility");
  const invited = input.visibility === "private" ? (input.memberIds ?? []) : [];
  const allowed = allowedMembers(input.projectId);
  for (const id of invited) if (!allowed(id)) throw invalid("members");
  const ch: Channel = {
    id: newId(input.projectId ? "ch-prj" : "ch-gen"),
    kind: input.projectId ? "project" : "general",
    projectId: input.projectId,
    name,
    description: input.description?.trim() ?? "",
    topic: "",
    visibility: input.visibility,
    createdById: me,
    archived: false,
    isGeneral: false,
    memberIds: [...new Set([me, ...invited])],
    publishedEvents: input.projectId ? ["release_page", "milestone_reached", "brief_ready"] : [],
    createdAt: chatNow(),
  };
  state.channels.push(ch);
  for (const id of ch.memberIds) ensureReadState(id, ch);
  notifyChatChange(ch.id);
  return view(me, ch);
}

/** Chi può entrare in un canale dell'ambito: in un progetto solo i suoi membri, altrove chiunque. */
function allowedMembers(projectId: string | null): (personId: string) => boolean {
  const projectMembers = projectId ? state.projectsById.get(projectId)?.memberIds : undefined;
  return (personId) =>
    isHuman(personId) && (projectMembers === undefined || projectMembers.includes(personId));
}

/**
 * Nome e descrizione: il creatore o chi gestisce (il nome del «general» non
 * cambia). L'argomento: qualunque membro. La visibilità non cambia dopo la
 * creazione.
 */
export async function updateChannel(channelId: string, patch: ChannelPatch): Promise<ChannelView> {
  const me = await gate("chat.updateChannel");
  const ch = seen(me, channelId);
  const perms = channelPermissions(me, ch);
  const editsInfo = patch.name !== undefined || patch.description !== undefined;
  if (editsInfo && !perms.canEditInfo) throw forbidden();
  if (patch.topic !== undefined && !perms.canEditTopic) throw forbidden();
  let name: string | undefined;
  if (patch.name !== undefined) {
    name = normalizeChannelName(patch.name);
    if (ch.isGeneral && name !== ch.name) throw invalid("general");
    if (!NAME_RE.test(name) || name.length > NAME_MAX) throw invalid("name");
    const taken = state.channels.some(
      (c) => c.id !== ch.id && c.kind !== "dm" && c.projectId === ch.projectId && c.name === name,
    );
    if (taken) throw invalid("name_taken");
  }
  if (name !== undefined) ch.name = name;
  if (patch.description !== undefined) ch.description = patch.description.trim();
  if (patch.topic !== undefined) ch.topic = patch.topic.trim();
  notifyChatChange(ch.id);
  return view(me, ch);
}

/** Quali eventi del progetto arrivano nel canale (solo di progetto; il creatore o chi gestisce). */
export async function setPublishedEvents(
  channelId: string,
  events: ChatEventKind[],
): Promise<ChannelView> {
  const me = await gate("chat.setPublishedEvents");
  const ch = seen(me, channelId);
  if (!channelPermissions(me, ch).canEditEvents) throw forbidden();
  if (events.some((e) => !CHAT_EVENT_KINDS.includes(e))) throw invalid("events");
  ch.publishedEvents = CHAT_EVENT_KINDS.filter((e) => events.includes(e));
  notifyChatChange(ch.id);
  return view(me, ch);
}

/**
 * Archivia (o ripristina) un canale: resta leggibile a chi lo leggeva, in
 * sola lettura. Il creatore o chi gestisce, anche senza leggerlo; mai il
 * «general» del progetto né un DM.
 */
export async function archiveChannel(channelId: string, archived = true): Promise<ChannelView> {
  const me = await gate("chat.archiveChannel");
  const ch = seen(me, channelId);
  if (!channelPermissions(me, ch).canArchive) throw forbidden();
  ch.archived = archived;
  notifyChatChange(ch.id);
  return view(me, ch);
}

/**
 * Elimina un canale con tutti i suoi messaggi, per tutti: link e citazioni
 * smettono di aprirsi. Stesse regole dell'archiviazione.
 */
export async function deleteChannel(channelId: string): Promise<void> {
  const me = await gate("chat.deleteChannel");
  const ch = seen(me, channelId);
  if (!channelPermissions(me, ch).canDelete) throw forbidden();
  state.channels = state.channels.filter((c) => c.id !== ch.id);
  state.chatMessages = state.chatMessages.filter((m) => m.channelId !== ch.id);
  for (const [key, read] of state.chatReads) {
    if (read.channelId === ch.id) state.chatReads.delete(key);
  }
  for (const key of state.chatNotify.keys()) {
    if (key.endsWith(`\u0000${ch.id}`)) state.chatNotify.delete(key);
  }
  recheckChatSubscribers();
  notifyChatChange(ch.id);
}

/**
 * Aggiunge persone. In un privato il creatore o chi gestisce, e mai se
 * stesso (altrimenti «chi gestisce non ne legge i messaggi» si aggirerebbe
 * con un clic); in un aperto qualunque membro. In un canale di progetto
 * solo membri del progetto. Mai nel «general» né in un DM.
 */
export async function inviteMembers(channelId: string, personIds: string[]): Promise<ChannelView> {
  const me = await gate("chat.inviteMembers");
  const ch = seen(me, channelId);
  if (!channelPermissions(me, ch).canInvite) throw forbidden();
  const fresh = [...new Set(personIds)].filter((id) => !ch.memberIds.includes(id));
  if (fresh.length === 0) throw invalid("members");
  if (fresh.includes(me)) throw forbidden();
  const allowed = allowedMembers(ch.projectId);
  if (fresh.some((id) => !allowed(id))) throw invalid("members");
  ch.memberIds = [...ch.memberIds, ...fresh];
  for (const id of fresh) ensureReadState(id, ch);
  notifyChatChange(ch.id);
  return view(me, ch);
}

/**
 * Toglie una persona: il creatore o chi gestisce (mai nel «general» né in
 * un DM); un privato non resta senza membri.
 */
export async function removeMember(channelId: string, personId: string): Promise<ChannelView> {
  const me = await gate("chat.removeMember");
  const ch = seen(me, channelId);
  if (!channelPermissions(me, ch).canRemove) throw forbidden();
  if (!ch.memberIds.includes(personId)) throw notFound();
  if (ch.visibility === "private" && ch.memberIds.length <= 1) throw invalid("last_member");
  ch.memberIds = ch.memberIds.filter((p) => p !== personId);
  forgetMember(personId, ch.id);
  recheckChatSubscribers();
  notifyChatChange(ch.id);
  return view(me, ch);
}

/**
 * Apre un messaggio diretto con queste persone (fino a 8 compreso chi lo
 * apre): quello che esiste già con le stesse persone, o uno nuovo.
 */
export async function openDm(personIds: string[]): Promise<ChannelView> {
  const me = await gate("chat.openDm");
  const others = [...new Set(personIds)].filter((id) => id !== me);
  if (others.length === 0 || others.length > DM_MAX_PEOPLE - 1) throw invalid("members");
  if (others.some((id) => !isHuman(id))) throw invalid("members");
  const people = [me, ...others];
  const existing = state.channels.find(
    (c) =>
      c.kind === "dm" &&
      c.memberIds.length === people.length &&
      people.every((id) => c.memberIds.includes(id)),
  );
  if (existing) return view(me, existing);
  const ch: Channel = {
    id: newId("dm"),
    kind: "dm",
    projectId: null,
    name: "",
    description: "",
    topic: "",
    visibility: "private",
    createdById: me,
    archived: false,
    isGeneral: false,
    memberIds: people,
    publishedEvents: [],
    createdAt: chatNow(),
  };
  state.channels.push(ch);
  for (const id of people) ensureReadState(id, ch);
  notifyChatChange(ch.id);
  return view(me, ch);
}

// --- dal messaggio a Stubwise ---------------------------------------------------

/** Collega al messaggio il codice di ciò che ne è nato («→ AUD-14»). */
function link(m: ChatMessage, code: string): void {
  patchChatMessage(m.id, { linkedCodes: [...m.linkedCodes, code] });
}

/**
 * «Create task» da un messaggio che si legge: la creazione di sempre (con i
 * suoi permessi), e il messaggio porta il codice della task.
 */
export async function createTaskFromMessage(messageId: string, input: NewTaskInput): Promise<Task> {
  const me = await gate("chat.createTaskFromMessage");
  const { m } = message(me, messageId);
  if (m.deletedAt !== null) throw invalid("deleted");
  const task = createTaskAs(me, input);
  link(m, task.code);
  return structuredClone(task);
}

/** «Create request» da un messaggio che si legge: come «Create task». */
export async function createRequestFromMessage(
  messageId: string,
  input: NewRequestInput,
): Promise<ProjectRequest> {
  const me = await gate("chat.createRequestFromMessage");
  const { m } = message(me, messageId);
  if (m.deletedAt !== null) throw invalid("deleted");
  const request = createRequestAs(me, input);
  link(m, request.code);
  return structuredClone(request);
}
