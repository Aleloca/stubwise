import { channelName } from "../../domain/chatLabel";
import { canSeeDriveFile } from "../drive/visibility";
import { PEOPLE } from "../seed/people";
import { chatKey, copy, gate, now, PROPOSAL_EXPIRY, state, visibleProjectIds } from "../store";
import type {
  AppNotification,
  Channel,
  ChannelMember,
  ChannelMessagesPage,
  ChannelRow,
  ChannelView,
  ChatMessage,
  ChatMessageHit,
  ChatMessageView,
  ChatClaudeQuestion,
  ChatQuestion,
  ChatSearchFilters,
  CitationRef,
  ConversationEvent,
  ReadState,
  ThreadView,
  ThreadWithNews,
  Utterance,
} from "../types";
import { mentionKindFor } from "./mentions";
import {
  canReadChannel,
  canSeeChannel,
  channelPermissions,
  membersOf,
  notifyLevelOf,
} from "./visibility";

// Le letture della Chat. Ognuna parte da `canSeeChannel`/`canReadChannel`
// (visibility.ts): un canale che non si vede risponde come uno che non
// esiste (`null`), e i messaggi di un canale che non si legge non entrano in
// nessun conteggio, elenco, ricerca, anteprima o notifica. Un messaggio
// eliminato non ha testo in nessun posto; senza risposte, dopo un giorno
// sparisce dal flusso, con risposte resta «Message deleted».

const DAY_MS = 86_400_000;

export const channelById = (id: string): Channel | undefined =>
  state.channels.find((c) => c.id === id);

export const messageById = (id: string): ChatMessage | undefined =>
  state.chatMessages.find((m) => m.id === id);

export const readStateOf = (personId: string, channelId: string): ReadState | undefined =>
  state.chatReads.get(chatKey(personId, channelId));

/** Nel flusso del canale: le radici e le risposte mandate «anche nel canale». */
export const inChannelFlow = (m: ChatMessage): boolean =>
  m.threadOf === null || m.alsoInChannel === true;

const byTime = (a: ChatMessage, b: ChatMessage) => a.createdAt.localeCompare(b.createdAt);

/** I messaggi di un canale con le risposte di ogni radice: il contesto di una lettura. */
export interface ChannelData {
  ch: Channel;
  /** Tutti i messaggi del canale, nell'ordine in cui sono arrivati. */
  messages: ChatMessage[];
  replies: Map<string, ChatMessage[]>;
}

export function channelData(ch: Channel, messages?: ChatMessage[]): ChannelData {
  const list = messages ?? state.chatMessages.filter((m) => m.channelId === ch.id);
  const replies = new Map<string, ChatMessage[]>();
  for (const m of list) {
    if (m.threadOf === null) continue;
    const thread = replies.get(m.threadOf) ?? [];
    thread.push(m);
    replies.set(m.threadOf, thread);
  }
  return { ch, messages: list, replies };
}

/** I messaggi per canale, in un passaggio (per le letture che guardano tutti i canali). */
function messagesByChannel(): Map<string, ChatMessage[]> {
  const out = new Map<string, ChatMessage[]>();
  for (const m of state.chatMessages) {
    const list = out.get(m.channelId) ?? [];
    list.push(m);
    out.set(m.channelId, list);
  }
  return out;
}

/**
 * Un messaggio eliminato senza risposte visibili e più vecchio di un giorno
 * non c'è più; con risposte resta («Message deleted» con il thread).
 */
export function isGone(m: ChatMessage, replies: readonly ChatMessage[] = []): boolean {
  if (m.deletedAt === null) return false;
  if (replies.some((r) => !isGone(r))) return false;
  return Date.parse(now()) - Date.parse(m.deletedAt) >= DAY_MS;
}

/** Le risposte visibili di una radice, in ordine. */
export function liveReplies(data: ChannelData, rootId: string): ChatMessage[] {
  return (data.replies.get(rootId) ?? []).filter((r) => !isGone(r)).sort(byTime);
}

/** Il flusso del canale come si legge: radici e risposte «anche nel canale», senza gli spariti. */
export function channelFlow(data: ChannelData): ChatMessage[] {
  return data.messages
    .filter((m) => inChannelFlow(m) && !isGone(m, data.replies.get(m.id) ?? []))
    .sort(byTime);
}

/** Toglie a un messaggio eliminato tutto ciò che diceva. */
export function scrubDeleted(m: ChatMessage): void {
  m.text = "";
  m.attachments = [];
  m.citations = [];
  m.reactions = [];
  m.asksReplyOf = [];
  // Le task nate dal messaggio restano, ma il messaggio non le annuncia più.
  m.linkedCodes = [];
  if (m.claudeEvents) m.claudeEvents = [];
}

/**
 * La persona ha risposto a `m` dopo che è stato scritto: nel suo thread o,
 * per un messaggio nel canale, anche nel canale.
 */
function answered(m: ChatMessage, personId: string, data: ChannelData): boolean {
  const thread = m.threadOf ?? m.id;
  return data.messages.some(
    (n) =>
      n.authorId === personId &&
      n.kind === "person" &&
      n.deletedAt === null &&
      n.createdAt > m.createdAt &&
      (n.threadOf === thread || (m.threadOf === null && n.threadOf === null)),
  );
}

/**
 * Una proposta aperta di una risposta di @Claude scade come nell'area 3:
 * dopo 20 messaggi del thread arrivati dopo la risposta (di persone e di
 * Claude) o dopo 24 ore. Si calcola a lettura, non si salva.
 */
export function chatProposalExpired(
  data: ChannelData,
  m: ChatMessage,
  proposal: ConversationEvent,
): boolean {
  if (proposal.type !== "proposal" || proposal.status !== "open" || m.threadOf === null) {
    return false;
  }
  const after = liveReplies(data, m.threadOf).filter(
    (r) => r.id !== m.id && r.createdAt > m.createdAt,
  ).length;
  return (
    after >= PROPOSAL_EXPIRY.messages ||
    Date.parse(now()) - Date.parse(proposal.at) >= PROPOSAL_EXPIRY.ms
  );
}

/** Le task e le richieste nate dal messaggio, per codice (`resolveCitations` decide chi le vede). */
function linkedRefsOf(m: ChatMessage): CitationRef[] {
  return m.linkedCodes.flatMap((code): CitationRef[] => {
    const task = state.tasks.find((t) => t.code === code);
    if (task) return [{ kind: "task", id: task.id }];
    const request = state.requests.find((r) => r.code === code);
    return request ? [{ kind: "request", id: request.id }] : [];
  });
}

/** Il messaggio come lo legge la persona: una copia, con il riassunto del thread. */
export function presentMessage(
  personId: string,
  m: ChatMessage,
  data: ChannelData = channelData(channelById(m.channelId)!),
): ChatMessageView {
  const base = copy(m);
  if (m.deletedAt !== null) scrubDeleted(base);
  // Una proposta scaduta si legge già `expired`, come nella conversazione.
  for (const e of base.claudeEvents ?? []) {
    if (e.type === "proposal" && chatProposalExpired(data, m, e)) e.status = "expired";
    // Gli argomenti delle azioni (titoli, campi) sono solo di chi può confermarle.
    if (e.type === "proposal" && e.requesterId !== personId) {
      e.actions = e.actions.map((a) => ({ ...a, args: {} }));
    }
  }
  const hiddenCodes = base.claudeEvents ? redactClaudeEvents(personId, m, base.claudeEvents) : [];
  const replies = m.threadOf === null ? liveReplies(data, m.id) : [];
  const followedAt = readStateOf(personId, m.channelId)?.threadReads[m.id];
  const last = replies.at(-1);
  const participants: string[] = [];
  for (const r of [...replies].reverse()) {
    if (r.authorId !== null && !participants.includes(r.authorId)) participants.push(r.authorId);
  }
  return {
    ...base,
    thread: last
      ? {
          replyCount: replies.length,
          lastReplyAt: last.createdAt,
          lastReplyById: last.authorId,
          participantIds: participants.slice(0, 3),
          hasNews:
            followedAt !== undefined &&
            replies.some((r) => r.authorId !== personId && r.createdAt > followedAt),
          following: followedAt !== undefined,
          claudeReplying: replies.some(
            (r) => r.claudeRun?.state === "working" && r.deletedAt === null,
          ),
        }
      : null,
    answeredIds: base.asksReplyOf.filter((id) => answered(m, id, data)),
    mentionsViewer: mentionKindFor(m, personId, membersOf(data.ch)) !== null,
    linkedRefs: linkedRefsOf(base),
    ...(m.kind === "claude" ? { hiddenCodes } : {}),
  };
}

/**
 * Le righe d'azione, le proposte e le domande di una risposta di @Claude
 * come le legge `personId` (R-E9): il codice di una task o di una richiesta
 * che non vede resta, il suo nome no — né nei riassunti delle proposte, né
 * nelle etichette e nei risultati delle azioni, né nel testo di una
 * domanda. Riscrive `events` (una copia) e restituisce quei codici, che la
 * UI mostra tenui. Il testo di Claude no: lo legge uguale ogni lettore.
 *
 * Solo ciò che la risposta ha REGISTRATO (R-G5): le sue citazioni, gli
 * oggetti delle azioni proposte, i codici nati da una conferma — esistono
 * per costruzione, perché chi ha chiamato li ha letti. Un codice scritto in
 * un'etichetta o in un testo e basta («Looked up SEC-9 · Not found») non si
 * guarda mai: nascosto o inesistente si legge identico (testo), nessun
 * oracolo di esistenza.
 */
function redactClaudeEvents(
  personId: string,
  recorded: Pick<ChatMessage, "citations" | "claudeEvents">,
  events: ConversationEvent[],
): string[] {
  const visible = visibleProjectIds(personId);
  const hidden = new Map<string, string>();
  const consider = (object: { code: string; title: string; projectId: string } | undefined) => {
    if (object && !visible.has(object.projectId)) hidden.set(object.code, object.title);
  };
  const task = (id: unknown) => (typeof id === "string" ? state.tasksById.get(id) : undefined);
  const request = (id: unknown) =>
    typeof id === "string" ? state.requests.find((r) => r.id === id) : undefined;
  for (const ref of recorded.citations) {
    if (ref.kind === "task") consider(task(ref.id));
    if (ref.kind === "request") consider(request(ref.id));
    // Un file del Drive che il lettore non può aprire (R-H5): progetto
    // invisibile, nascosto o tolto dopo la risposta si leggono identici — il
    // codice registrato con la citazione, tenue; il nome esce dalle righe
    // d'azione. Non dipende dal file che c'è ancora: uno tolto non c'è più.
    if (ref.kind === "drive") {
      const file = state.driveFiles.find((f) => f.id === ref.id);
      const code = ref.code ?? file?.code;
      if (code && !(file && canSeeDriveFile(personId, file))) hidden.set(code, file?.name ?? "");
    }
  }
  // Il titolo di un oggetto che il lettore non vede e che la proposta scrive
  // da solo (non dopo il suo codice): la richiesta da trasformare, la task o
  // la richiesta da creare in un progetto che non vede. Per proposta e azione.
  const hiddenTitles = new Map<string, string>();
  for (const e of recorded.claudeEvents ?? []) {
    if (e.type !== "proposal") continue;
    e.actions.forEach(({ fn, args }, i) => {
      if (["updateTask", "planTask"].includes(fn)) consider(task(args.id));
      if (["addComment", "startRun"].includes(fn)) consider(task(args.taskId));
      if (["convertRequest", "archiveRequest"].includes(fn)) {
        const r = request(args.id);
        consider(r);
        if (r && !visible.has(r.projectId)) hiddenTitles.set(`${e.id}:${i}`, r.title);
      }
      if (["createTask", "createRequest"].includes(fn)) {
        const { projectId, title } = args;
        if (typeof projectId === "string" && typeof title === "string" && !visible.has(projectId)) {
          hiddenTitles.set(`${e.id}:${i}`, title);
        }
      }
    });
    for (const code of e.resultCodes ?? []) {
      consider(
        state.tasks.find((t) => t.code === code) ?? state.requests.find((r) => r.code === code),
      );
    }
  }
  if (hidden.size === 0 && hiddenTitles.size === 0) return [];
  const redact = (text: string, elided?: string): string => {
    let out = text;
    for (const [code, title] of hidden) {
      if (title) out = out.split(`${code} ${title}`).join(code);
    }
    // Un titolo scritto da solo non ha un codice che resti: si legge «…».
    return elided ? out.split(elided).join("…") : out;
  };
  // Le frasi registrate (chiave e parametri): i parametri sono i dati da riscrivere.
  const redactText = (text: Utterance | undefined, elided?: string): Utterance | undefined =>
    text?.params
      ? {
          key: text.key,
          params: Object.fromEntries(
            Object.entries(text.params).map(([k, v]) => [
              k,
              typeof v === "string" ? redact(v, elided) : v,
            ]),
          ),
        }
      : text;
  for (const e of events) {
    if (e.type === "action") {
      e.label = redact(e.label);
      if (e.labelText) e.labelText = redactText(e.labelText);
      if (e.input !== undefined) e.input = redact(e.input);
      if (e.result !== undefined) e.result = redact(e.result);
      if (e.resultText) e.resultText = redactText(e.resultText);
    }
    if (e.type === "proposal") {
      const id = e.id;
      e.actions = e.actions.map((a, i) => {
        const elided = hiddenTitles.get(`${id}:${i}`);
        return {
          ...a,
          summary: redact(a.summary, elided),
          ...(a.summaryText ? { summaryText: redactText(a.summaryText, elided)! } : {}),
        };
      });
    }
    if (e.type === "question") e.text = redact(e.text);
  }
  return [...hidden.keys()];
}

/** Il nome del canale come lo si legge: `AUD · general`, `# announcements`, i nomi del DM. */
export function channelLabel(ch: Channel, personId: string): string {
  return channelName(
    { ...ch, memberIds: membersOf(ch) },
    personId,
    (id) => state.projectsById.get(id)?.code,
    (id) => PEOPLE.find((p) => p.id === id)?.name,
  ).label;
}

export function channelView(personId: string, ch: Channel): ChannelView {
  const readable = canReadChannel(personId, ch);
  return {
    ...copy(ch),
    // Chi vede un privato senza leggerlo (chi gestisce) ne sa nome e membri:
    // né l'argomento né la descrizione.
    topic: readable ? ch.topic : "",
    description: readable ? ch.description : "",
    memberIds: [...membersOf(ch)],
    ...channelPermissions(personId, ch),
    notifyLevel: notifyLevelOf(personId, ch.id),
  };
}

/**
 * I non letti e le menzioni di un canale per la persona, secondo le sue
 * notifiche (`all` / `mentions` / `muted`). Non letti: i messaggi del flusso
 * dopo la sua lettura, non suoi; con «solo menzioni» solo quelli che la
 * nominano direttamente, in un silenziato nessuno. Menzioni: quelle dirette
 * sempre (anche nelle risposte dei thread), `@channel` e reparto solo con
 * «tutti», e in un DM ogni messaggio salvo silenziato. I messaggi di
 * sistema contano come non letti, mai come menzione.
 */
export function channelCounts(
  personId: string,
  data: ChannelData,
): { unread: number; mentions: number } {
  const { unread, mentions } = countsOf(personId, data);
  return { unread, mentions };
}

/**
 * I conteggi di `channelCounts` più `toMe`: le menzioni rivolte proprio alla
 * persona (dirette, o un DM non silenziato), senza `@channel` né reparto. È
 * ciò che accende il punto della Chat sul binario.
 */
function countsOf(
  personId: string,
  data: ChannelData,
): { unread: number; mentions: number; toMe: number } {
  const read = readStateOf(personId, data.ch.id);
  const members = membersOf(data.ch);
  if (!read || !members.includes(personId) || !canReadChannel(personId, data.ch)) {
    return { unread: 0, mentions: 0, toMe: 0 };
  }
  const level = notifyLevelOf(personId, data.ch.id);
  const dm = data.ch.kind === "dm";
  let unread = 0;
  let mentions = 0;
  let mine = 0;
  for (const m of data.messages) {
    if (m.deletedAt !== null || m.authorId === personId) continue;
    const flow = inChannelFlow(m);
    const since = flow ? read.lastReadAt : (read.threadReads[m.threadOf!] ?? read.lastReadAt);
    if (m.createdAt <= since) continue;
    const kind = mentionKindFor(m, personId, members);
    // In un DM ogni messaggio di una persona è rivolto a chi partecipa.
    const toMe = kind === "direct" || (dm && m.kind !== "system");
    if (flow && (level === "all" || (level === "mentions" && toMe))) unread++;
    const counts =
      kind === "direct" || (level !== "muted" && toMe) || (level === "all" && kind === "group");
    if (counts) mentions++;
    if (kind === "direct" || (level !== "muted" && toMe)) mine++;
  }
  return { unread, mentions, toMe: mine };
}

function channelRow(personId: string, ch: Channel, messages: ChatMessage[]): ChannelRow {
  const data = channelData(ch, messages);
  const readable = canReadChannel(personId, ch);
  const live = readable
    ? data.messages.filter((m) => !isGone(m, data.replies.get(m.id) ?? []))
    : [];
  const latest = live.reduce<string | null>(
    (max, m) => (max === null || m.createdAt > max ? m.createdAt : max),
    null,
  );
  return {
    ...channelView(personId, ch),
    ...channelCounts(personId, data),
    lastActivityAt: latest,
  };
}

/** Il canale se la persona lo vede (anche senza leggerlo). */
export function seenChannel(personId: string, id: string): Channel | null {
  const ch = channelById(id);
  return ch && canSeeChannel(personId, ch) ? ch : null;
}

/** Il canale se la persona ne legge i messaggi. */
export function readableChannel(personId: string, id: string): Channel | null {
  const ch = channelById(id);
  return ch && canReadChannel(personId, ch) ? ch : null;
}

/** Il messaggio se la persona lo legge e c'è ancora (uno sparito non esiste). */
export function readableMessage(
  personId: string,
  id: string,
): { message: ChatMessage; data: ChannelData } | null {
  const message = messageById(id);
  if (!message) return null;
  const ch = readableChannel(personId, message.channelId);
  if (!ch) return null;
  const data = channelData(ch);
  if (isGone(message, data.replies.get(message.id) ?? [])) return null;
  return { message, data };
}

/**
 * Il messaggio vivo prima di `m` nel suo flusso (il canale, o il thread con
 * la radice): un eliminato non fa da contesto, nemmeno vuoto (Review Focus 3).
 */
function contextOf(personId: string, m: ChatMessage, data: ChannelData): ChatMessageView | null {
  const flow =
    m.threadOf === null || m.alsoInChannel
      ? channelFlow(data)
      : [data.messages.find((x) => x.id === m.threadOf)!, ...liveReplies(data, m.threadOf)];
  const index = flow.findIndex((x) => x.id === m.id);
  const previous = flow
    .slice(0, Math.max(0, index))
    .reverse()
    .find((x) => x !== undefined && x.deletedAt === null);
  return previous ? presentMessage(personId, previous, data) : null;
}

function hit(personId: string, m: ChatMessage, data: ChannelData): ChatMessageHit {
  return {
    channelId: m.channelId,
    message: presentMessage(personId, m, data),
    context: contextOf(personId, m, data),
    root: rootOf(personId, m, data),
  };
}

/** La radice del thread di una risposta (eliminata: senza testo, come ovunque). */
function rootOf(personId: string, m: ChatMessage, data: ChannelData): ChatMessageView | null {
  if (m.threadOf === null) return null;
  const root = data.messages.find((x) => x.id === m.threadOf);
  return root ? presentMessage(personId, root, data) : null;
}

// --- letture ------------------------------------------------------------------

/**
 * I canali che chi guarda vede, con non letti, menzioni e ultima attività:
 * tutti (colonna e «Browse channels», con `isMember` e `archived`) o quelli
 * di un progetto (gli stessi, con gli stessi conteggi). Un privato visto da
 * chi gestisce senza esserne membro non rivela attività né conteggi.
 */
export async function listChannels(
  options: { scope: "all" } | { scope: "project"; projectId: string } = { scope: "all" },
): Promise<ChannelRow[]> {
  const me = await gate("chat.listChannels");
  const byChannel = messagesByChannel();
  return state.channels
    .filter(
      (ch) =>
        canSeeChannel(me, ch) && (options.scope === "all" || ch.projectId === options.projectId),
    )
    .map((ch) => channelRow(me, ch, byChannel.get(ch.id) ?? []));
}

/** Un canale con i permessi di chi guarda; `null` se non lo vede. */
export async function getChannel(id: string): Promise<ChannelView | null> {
  const me = await gate("chat.getChannel");
  const ch = seenChannel(me, id);
  return ch ? channelView(me, ch) : null;
}

/** I membri di un canale che chi guarda vede (anche un privato che gestisce). */
export async function listChannelMembers(id: string): Promise<ChannelMember[] | null> {
  const me = await gate("chat.listChannelMembers");
  const ch = seenChannel(me, id);
  if (!ch) return null;
  return membersOf(ch).map((personId) => ({ personId, isCreator: personId === ch.createdById }));
}

/**
 * Una pagina del flusso del canale (radici e risposte «anche nel canale»),
 * le più recenti prima di `before` (l'id di un messaggio), al più `limit`.
 * `null` se chi guarda non ne legge i messaggi.
 */
export async function listMessages(
  channelId: string,
  { before, limit = 50 }: { before?: string; limit?: number } = {},
): Promise<ChannelMessagesPage | null> {
  const me = await gate("chat.listMessages");
  const ch = readableChannel(me, channelId);
  if (!ch) return null;
  const data = channelData(ch);
  const flow = channelFlow(data);
  const at = before === undefined ? -1 : flow.findIndex((m) => m.id === before);
  const end = at >= 0 ? at : flow.length;
  const start = Math.max(0, end - limit);
  const read = readStateOf(me, ch.id);
  return {
    messages: flow.slice(start, end).map((m) => presentMessage(me, m, data)),
    hasMore: start > 0,
    lastReadAt: read && membersOf(ch).includes(me) ? read.lastReadAt : null,
  };
}

/** Un messaggio (per un link, un'anteprima, un salto): `null` se non lo legge o non c'è più. */
export async function getMessage(id: string): Promise<ChatMessageHit | null> {
  const me = await gate("chat.getMessage");
  const found = readableMessage(me, id);
  return found ? hit(me, found.message, found.data) : null;
}

/** Il thread di un messaggio (la radice, anche da una risposta): `null` se non lo legge. */
export async function listThread(messageId: string): Promise<ThreadView | null> {
  const me = await gate("chat.listThread");
  const found = readableMessage(me, messageId);
  if (!found) return null;
  const rootId = found.message.threadOf ?? found.message.id;
  const root = found.data.messages.find((m) => m.id === rootId);
  if (!root || isGone(root, found.data.replies.get(rootId) ?? [])) return null;
  return {
    channelId: root.channelId,
    root: presentMessage(me, root, found.data),
    replies: liveReplies(found.data, rootId).map((r) => presentMessage(me, r, found.data)),
    lastReadAt: readStateOf(me, root.channelId)?.threadReads[rootId] ?? null,
  };
}

/** I thread che chi guarda segue con risposte nuove (non sue), dal più recente. */
export async function listThreadsWithNews(): Promise<ThreadWithNews[]> {
  const me = await gate("chat.listThreadsWithNews");
  return threadsWithNewsOf(me);
}

function threadsWithNewsOf(me: string): ThreadWithNews[] {
  const out: ThreadWithNews[] = [];
  for (const read of state.chatReads.values()) {
    if (read.personId !== me) continue;
    const ch = readableChannel(me, read.channelId);
    if (!ch || !membersOf(ch).includes(me)) continue;
    const data = channelData(ch);
    for (const [rootId, readAt] of Object.entries(read.threadReads)) {
      const root = data.messages.find((m) => m.id === rootId);
      if (!root) continue;
      const replies = liveReplies(data, rootId);
      const fresh = replies.filter((r) => r.authorId !== me && r.createdAt > readAt);
      if (fresh.length === 0) continue;
      out.push({
        channelId: ch.id,
        root: presentMessage(me, root, data),
        latestReplies: replies.slice(-2).map((r) => presentMessage(me, r, data)),
        newCount: fresh.length,
      });
    }
  }
  const latest = (t: ThreadWithNews) => t.latestReplies.at(-1)!.createdAt;
  return out.sort((a, b) => latest(b).localeCompare(latest(a)));
}

/**
 * Il punto della Chat sul binario: c'è qualcosa rivolto proprio a chi guarda
 * — una menzione diretta non letta, un DM non letto (non silenziato), un
 * thread che segue con risposte nuove. Il traffico normale dei canali e
 * `@channel`/reparto no: con 50 progetti il punto sarebbe sempre acceso
 * (shape chat.md §6). Solo i canali della colonna (membro, non archiviati).
 */
export function chatSignalOf(personId: string): boolean {
  const byChannel = messagesByChannel();
  for (const ch of state.channels) {
    if (ch.archived) continue;
    if (countsOf(personId, channelData(ch, byChannel.get(ch.id) ?? [])).toMe > 0) return true;
  }
  // Anche i thread: uno di un canale archiviato non accende il punto.
  return threadsWithNewsOf(personId).some((t) => channelById(t.channelId)?.archived === false);
}

export async function hasNews(): Promise<boolean> {
  const me = await gate("chat.hasNews");
  return chatSignalOf(me);
}

/** Tutte le menzioni di chi guarda nei canali che legge (persona, reparto, @channel, domanda), dalla più recente. */
export async function listMentions(): Promise<ChatMessageHit[]> {
  const me = await gate("chat.listMentions");
  const out: ChatMessageHit[] = [];
  const byChannel = messagesByChannel();
  for (const ch of state.channels) {
    if (!canReadChannel(me, ch)) continue;
    const data = channelData(ch, byChannel.get(ch.id) ?? []);
    const members = membersOf(ch);
    for (const m of data.messages) {
      if (isGone(m, data.replies.get(m.id) ?? [])) continue;
      if (mentionKindFor(m, me, members) !== null) out.push(hit(me, m, data));
    }
  }
  return out.sort((a, b) => b.message.createdAt.localeCompare(a.message.createdAt));
}

/**
 * Le domande rivolte a chi guarda (in «Da decidere»): i messaggi che gli
 * chiedono una risposta, nei canali che legge, finché non risponde (nel
 * thread o, per un messaggio nel canale, nel canale) o non le ignora. Un
 * messaggio eliminato non chiede più nulla.
 */
export function chatQuestionsOf(personId: string): ChatQuestion[] {
  const out: ChatQuestion[] = [];
  const byChannel = messagesByChannel();
  for (const ch of state.channels) {
    // Come le domande di @Claude: solo dove può ancora rispondere (membro, non archiviato).
    if (ch.archived || !canReadChannel(personId, ch)) continue;
    if (!membersOf(ch).includes(personId)) continue;
    const data = channelData(ch, byChannel.get(ch.id) ?? []);
    for (const m of data.messages) {
      if (!m.asksReplyOf.includes(personId) || m.deletedAt !== null) continue;
      if (state.chatDismissed.has(chatKey(personId, m.id))) continue;
      if (answered(m, personId, data)) continue;
      out.push({
        id: `chat:${m.id}`,
        channelId: ch.id,
        messageId: m.id,
        rootId: m.threadOf ?? m.id,
        channelLabel: channelLabel(ch, personId),
        askedById: m.authorId!,
        text: m.text,
        createdAt: m.createdAt,
      });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listQuestions(): Promise<ChatQuestion[]> {
  const me = await gate("chat.listQuestions");
  return chatQuestionsOf(me);
}

/**
 * Le domande di @Claude a chi guarda, nei thread in cui l'ha chiamato
 * (R-G4): per «Da decidere», che le mostra accanto al thread. Solo quelle
 * ancora aperte — risposte (in un posto o nell'altro), risposta fermata o
 * eliminata, canale archiviato o non più letto: sparite da sole.
 */
export function chatClaudeQuestionsOf(personId: string): ChatClaudeQuestion[] {
  const out: ChatClaudeQuestion[] = [];
  for (const m of state.chatMessages) {
    if (m.kind !== "claude" || m.calledById !== personId || m.deletedAt !== null) continue;
    if (m.claudeRun?.state !== "waiting" || m.threadOf === null) continue;
    const ch = channelById(m.channelId);
    // Solo dove può ancora rispondere: membro di un canale non archiviato.
    if (!ch || ch.archived || !canReadChannel(personId, ch)) continue;
    if (!membersOf(ch).includes(personId)) continue;
    // Il testo della domanda come nel thread (R-E9): un titolo che non vede più non esce.
    const events = copy(m.claudeEvents ?? []);
    redactClaudeEvents(personId, m, events);
    for (const e of events) {
      if (e.type !== "question" || e.answer !== null) continue;
      out.push({
        id: `chat-claude:${m.id}:${e.questionId}`,
        channelId: ch.id,
        messageId: m.id,
        rootId: m.threadOf,
        channelLabel: channelLabel(ch, personId),
        questionId: e.questionId,
        text: e.text,
        options: copy(e.options),
        createdAt: e.at,
      });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listClaudeQuestions(): Promise<ChatClaudeQuestion[]> {
  const me = await gate("chat.listClaudeQuestions");
  return chatClaudeQuestionsOf(me);
}

/** Senza maiuscole né accenti. */
const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** I codici di task e richieste citati come gettoni: un codice trova anche chi lo cita. */
function citedCodes(m: ChatMessage): string[] {
  return m.citations.flatMap((ref) => {
    if (ref.kind === "task") return [state.tasksById.get(ref.id)?.code ?? ""];
    if (ref.kind === "request") return [state.requests.find((r) => r.id === ref.id)?.code ?? ""];
    return [];
  });
}

/**
 * Cerca nei messaggi dei canali che chi guarda legge (mai un privato di cui
 * non è membro, nemmeno se lo gestisce, mai un DM altrui), archiviati
 * compresi; mai i messaggi eliminati. Ogni parola della ricerca deve
 * comparire (senza maiuscole né accenti) nel testo, nei nomi degli allegati
 * o nei codici citati. Da 2 caratteri in su; dal più recente.
 */
export async function searchChat(
  q: string,
  filters: ChatSearchFilters = {},
): Promise<ChatMessageHit[]> {
  const me = await gate("chat.search");
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (q.trim().length < 2 || terms.length === 0) return [];
  const out: ChatMessageHit[] = [];
  const byChannel = messagesByChannel();
  for (const ch of state.channels) {
    if (filters.channelId !== undefined && ch.id !== filters.channelId) continue;
    if (!canReadChannel(me, ch)) continue;
    const data = channelData(ch, byChannel.get(ch.id) ?? []);
    for (const m of data.messages) {
      if (m.deletedAt !== null) continue;
      if (filters.authorId !== undefined && m.authorId !== filters.authorId) continue;
      if (filters.peopleOnly && m.kind === "system") continue;
      if (filters.withAttachments && m.attachments.length === 0) continue;
      if (filters.withCitations && m.citations.length === 0) continue;
      const day = m.createdAt.slice(0, 10);
      if (filters.from !== undefined && day < filters.from) continue;
      if (filters.to !== undefined && day > filters.to) continue;
      const haystack = fold(
        [m.text, ...m.attachments.map((a) => a.name), ...citedCodes(m)].join(" "),
      );
      if (terms.every((t) => haystack.includes(t))) out.push(hit(me, m, data));
    }
  }
  return out.sort((a, b) => b.message.createdAt.localeCompare(a.message.createdAt));
}

/**
 * Una notifica di menzione della Chat come la legge il destinatario: titolo
 * e testo dal messaggio di adesso. `null` se il messaggio è stato eliminato,
 * non c'è più o il destinatario non legge più il canale.
 */
export function presentChatNotification(
  personId: string,
  n: AppNotification,
): AppNotification | null {
  const found = n.chatMessageId ? readableMessage(personId, n.chatMessageId) : null;
  if (!found || found.message.deletedAt !== null) return null;
  const { message, data } = found;
  const author = PEOPLE.find((p) => p.id === message.authorId)?.name ?? "";
  const label = channelLabel(data.ch, personId);
  const asked = message.asksReplyOf.includes(personId);
  const thread = message.threadOf;
  return {
    ...copy(n),
    projectId: data.ch.projectId,
    objectCode: label,
    title: asked ? `${author} asked you in ${label}` : `${author} mentioned you in ${label}`,
    body: message.text.length > 160 ? `${message.text.slice(0, 159)}…` : message.text,
    link: thread
      ? `#/chat/${data.ch.id}?thread=${thread}&message=${message.id}`
      : `#/chat/${data.ch.id}?message=${message.id}`,
  };
}
