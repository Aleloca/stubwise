import {
  backlogItems,
  chatChannelMembers,
  chatChannelPrefs,
  chatChannels,
  chatDismissedQuestions,
  chatMessageCitations,
  chatMessageLinks,
  chatMessages,
  chatReactions,
  chatReads,
  chatThreadFollows,
  chatClaudeQuestions,
  agentSessionInputs,
  claudeProposals,
  departmentMembers,
  departments,
  projects,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { projectViewerIds, projectViewerIdsByProject, publishNotification } from "@stubwise/notifications";
import { AGENT_SESSION_INPUT_CHANNEL } from "@stubwise/shared";
import type {
  ProjectPermission,
  ChatCitationRef,
  ChatChannelView,
  ChatMessageView,
  ChatNotifyLevel,
  CreateChatChannelInput,
  PatchChatChannelInput,
} from "@stubwise/shared";
import { CHAT_DM_MAX_PEOPLE, CHAT_EVENT_KINDS, CHAT_GENERAL_DEFAULT_EVENTS, CHAT_SEARCH_MIN, chatChannelNameSchema } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { projectPermissionsFor, projectPermissionsMap, visibleProjectIds } from "../auth/access.js";
import { isUniqueViolation } from "../routes/shared.js";
import { personName } from "../services/people.js";
import { requestVisibility } from "../services/project-requests.js";
import { visibleTasksCondition } from "../services/task-view.js";
import { citationsToStore, citationViews, hasVisibleCitationSql } from "./citations.js";
import { callContext, callsClaude, claudeReplyViews, rootsWithClaudeWorking, startClaudeReply, stopSession } from "./claude.js";
import {
  accessFrom,
  allowedMemberIds,
  channelAccess,
  channelMemberIds,
  channelMemberSql,
  channelReadableSql,
  channelReaderIds,
  channelVisibleSql,
  visibleChannel,
  type ChannelAccess,
  type ChannelRow,
  type ChatViewer,
} from "./access.js";

/**
 * La Chat fra persone (area 4, fette 1 e 2): canali di progetto e generali,
 * aperti e privati, DM, messaggi, thread a un livello, reazioni, letti,
 * preferenze, thread seguiti, menzioni, domande, ricerca. Chi vede, chi legge e
 * chi gestisce lo decide `access.ts`; qui le scritture e le viste di chi
 * guarda. Regole del prototipo (`data/chat/*`): si modificano ed eliminano
 * solo i propri messaggi (D6); un eliminato non ha testo (CHECK); le menzioni
 * e le domande le ricava il server dal testo, sui nomi di chi legge il canale
 * (R-G6: `@channel` e `@reparto` non avvisano, contano solo fra le menzioni
 * del canale).
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
const forbidden = (message = "Not allowed") => new ChatError(403, "forbidden", message);

/** Avvisa lo stream del canale (al commit). */
async function notifyChannel(db: Db | Tx, channelId: string): Promise<void> {
  await db.execute(sql`select pg_notify(${CHAT_CHANNEL_NOTIFY}, ${JSON.stringify({ channelId })})`);
}

/** Il testo per la ricerca: senza maiuscole né accenti (`fold` del prototipo). */
export function foldChatText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// --- Persone, menzioni, domande -------------------------------------------------

/** Le persone (non Claude) fra `ids`, coi nomi come li mostra l'app. */
async function peopleOf(db: Db | Tx, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(inArray(users.id, [...new Set(ids)]), eq(users.isAgent, false)));
  return rows.map((r) => ({ id: r.id, name: personName(r) }));
}

/**
 * Le persone nominate direttamente fra chi legge il canale; mai chi scrive.
 * I nomi più lunghi prima, e ogni nome trovato CONSUMA il suo tratto di testo:
 * «@Ale Loca» nomina Ale Loca e non anche «Ale», mentre «@Ale Loca e @Ale»
 * li nomina tutti e due.
 */
async function mentionedIn(db: Db | Tx, channel: ChannelRow, text: string, authorId: string): Promise<string[]> {
  if (!text.includes("@")) return [];
  const readers = await peopleOf(db, await channelReaderIds(db as Db, channel));
  let rest = text;
  const out: string[] = [];
  for (const p of readers.sort((a, b) => b.name.length - a.name.length)) {
    const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "gu");
    if (!re.test(rest)) continue;
    rest = rest.replace(re, (m) => " ".repeat(m.length));
    if (p.id !== authorId) out.push(p.id);
  }
  return out;
}

/**
 * A chi il messaggio chiede una risposta (`questionTargets` del prototipo):
 * alle persone nominate, se il testo finisce con «?» o la casella lo forza
 * («Ask for a reply»). Mai chi scrive (già escluso dalle nominate).
 */
function questionTargets(text: string, mentioned: readonly string[], forced: boolean): string[] {
  if (!forced && !/\?\s*$/.test(text.trim())) return [];
  return [...mentioned];
}

/**
 * Le card di un messaggio per le persone che lo devono sapere: `chat.question`
 * a un MEMBRO a cui il messaggio chiede una risposta (è lui che la trova in
 * «Da decidere» e può rispondere), `chat.mention` agli altri nominati.
 */
async function publishCards(
  tx: Tx,
  input: {
    channel: ChannelRow;
    messageId: string;
    authorId: string;
    authorName: string;
    to: readonly string[];
    asks: readonly string[];
    members: ReadonlySet<string>;
  },
): Promise<void> {
  for (const userId of input.to) {
    await publishNotification(
      tx,
      {
        kind: input.asks.includes(userId) && input.members.has(userId) ? "chat.question" : "chat.mention",
        chatMessageId: input.messageId,
        channelId: input.channel.id,
        channelName: input.channel.name,
        projectId: input.channel.projectId,
        authorUserId: input.authorId,
        authorName: input.authorName,
      },
      { accountUserId: userId, ...(input.channel.projectId ? { projectId: input.channel.projectId } : {}) },
    );
  }
}

/**
 * Le espressioni (regex di Postgres) delle menzioni di gruppo che riguardano
 * chi guarda: `@channel` e i suoi reparti (`mentionKindFor` del prototipo).
 */
async function groupPatterns(db: Db, viewerId: string): Promise<string[]> {
  const rows = await db
    .select({ name: departments.name })
    .from(departmentMembers)
    .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
    .where(eq(departmentMembers.userId, viewerId));
  return ["channel", ...rows.map((r) => r.name)].map(
    (name) => `@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![[:alnum:]_])`,
  );
}

function groupSql(patterns: readonly string[]): SQL {
  return sql`(${chatMessages.kind} <> 'system' and ${chatMessages.body} ~ any(array[${sql.join(
    patterns.map((p) => sql`${p}`),
    sql`, `,
  )}]::text[]))`;
}

function directSql(viewerId: string): SQL {
  return sql`(${chatMessages.kind} <> 'system' and (${viewerId}::uuid = any(${chatMessages.mentionedIds}) or ${viewerId}::uuid = any(${chatMessages.asksReplyOf})))`;
}

/** Nel flusso del canale: le radici e le risposte mandate «anche nel canale». */
const flowSql = sql`(${chatMessages.threadRootId} is null or ${chatMessages.alsoInChannel})`;

/**
 * Un eliminato senza risposte vive e più vecchio di un giorno non c'è più
 * (`isGone` del prototipo); con risposte resta («Message deleted» col thread).
 */
const goneSql = sql`(${chatMessages.deletedAt} is not null
  and ${chatMessages.deletedAt} < now() - interval '1 day'
  and not exists (
    select 1 from chat_messages r
    where r.thread_root_id = ${chatMessages.id}
      and (r.deleted_at is null or r.deleted_at >= now() - interval '1 day')
  ))`;

// --- Viste ----------------------------------------------------------------

/**
 * Le viste dei canali per chi guarda, in BLOCCO: le stesse query per uno o per
 * cento canali (permessi, membri, preferenze, letture, ultimo messaggio,
 * conteggi), non nove per canale. Lo stream la chiama a ogni giro, le liste una
 * volta. `toMe` è ciò che accende il punto del binario.
 *
 * I conteggi sono `countsOf` del prototipo, per livello: non letti = i
 * messaggi del flusso dopo la lettura, non propri (quelli di sistema compresi);
 * con «solo menzioni» solo quelli rivolti a chi guarda, in un silenziato
 * nessuno. Menzioni: le dirette sempre (anche nelle risposte, dopo la lettura
 * del thread), `@channel` e reparto solo con «tutti», in un DM ogni messaggio
 * di una persona salvo silenziato.
 */
async function channelViewsBatch(
  db: Db,
  viewer: ChatViewer,
  channels: readonly ChannelRow[],
): Promise<{ view: ChatChannelView; toMe: number }[]> {
  if (channels.length === 0) return [];
  const ids = channels.map((c) => c.id);
  const permissionsByProject = await projectPermissionsMap(db, viewer);
  const memberRows = await db
    .select({ channelId: chatChannelMembers.channelId, userId: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .where(inArray(chatChannelMembers.channelId, ids));
  const membersOf = new Map<string, string[]>();
  for (const r of memberRows) membersOf.set(r.channelId, [...(membersOf.get(r.channelId) ?? []), r.userId]);
  // Chi vede ciascun progetto: i membri del «general», e il filtro degli ex membri.
  const viewersOf = new Map(
    [...(await projectViewerIdsByProject(db, channels.flatMap((c) => (c.projectId ? [c.projectId] : [])))).entries()].map(
      ([projectId, ids]) => [projectId, new Set(ids)] as const,
    ),
  );
  const candidates = new Set([...memberRows.map((r) => r.userId), ...[...viewersOf.values()].flatMap((v) => [...v])]);
  const humans = new Set((await peopleOf(db, [...candidates])).map((p) => p.id));
  const prefs = new Map(
    (
      await db
        .select({ channelId: chatChannelPrefs.channelId, level: chatChannelPrefs.level })
        .from(chatChannelPrefs)
        .where(and(eq(chatChannelPrefs.userId, viewer.id), inArray(chatChannelPrefs.channelId, ids)))
    ).map((r) => [r.channelId, r.level]),
  );
  const reads = new Map(
    (
      await db
        .select({ channelId: chatReads.channelId, at: chatReads.lastReadAt })
        .from(chatReads)
        .where(and(eq(chatReads.userId, viewer.id), inArray(chatReads.channelId, ids), isNull(chatReads.threadRootId)))
    ).map((r) => [r.channelId, r.at]),
  );
  const lasts = new Map(
    (
      await db
        .select({
          channelId: chatMessages.channelId,
          at: sql<string>`to_char(max(${chatMessages.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        })
        .from(chatMessages)
        .where(and(inArray(chatMessages.channelId, ids), sql`not ${goneSql}`))
        .groupBy(chatMessages.channelId)
    ).map((r) => [r.channelId, r.at]),
  );
  // I conteggi di tutti i canali in UNA query: il livello dalla preferenza, il DM dal canale.
  const level = sql`coalesce((select p.level from chat_channel_prefs p where p.user_id = ${viewer.id} and p.channel_id = ${chatMessages.channelId}), 'all')`;
  const direct = directSql(viewer.id);
  const group = groupSql(await groupPatterns(db, viewer.id));
  const toMe = sql`(${direct} or (${chatChannels.kind} = 'dm' and ${chatMessages.kind} <> 'system'))`;
  const channelRead = sql`coalesce((
    select cr.last_read_at from ${chatReads} cr
    where cr.user_id = ${viewer.id} and cr.channel_id = ${chatMessages.channelId} and cr.thread_root_id is null
  ), to_timestamp(0))`;
  const threadRead = sql`coalesce((
    select cr.last_read_at from ${chatReads} cr
    where cr.user_id = ${viewer.id} and cr.thread_root_id = ${chatMessages.threadRootId}
  ), ${channelRead})`;
  const countRows = await db
    .select({
      channelId: chatMessages.channelId,
      unread: sql<number>`count(*) filter (where ${flowSql} and (${level} = 'all' or (${level} = 'mentions' and ${toMe})))::int`,
      mentions: sql<number>`count(*) filter (where ${direct} or (${level} <> 'muted' and ${toMe}) or (${level} = 'all' and ${group}))::int`,
      toMe: sql<number>`count(*) filter (where ${direct} or (${level} <> 'muted' and ${toMe}))::int`,
    })
    .from(chatMessages)
    .innerJoin(chatChannels, eq(chatChannels.id, chatMessages.channelId))
    .where(
      and(
        inArray(chatMessages.channelId, ids),
        isNull(chatMessages.deletedAt),
        or(isNull(chatMessages.authorId), ne(chatMessages.authorId, viewer.id)),
        sql`${chatMessages.createdAt} > (case when ${flowSql} then ${channelRead} else ${threadRead} end)`,
      ),
    )
    .groupBy(chatMessages.channelId);
  const counts = new Map(countRows.map((r) => [r.channelId, r]));

  return channels.map((channel) => {
    const rows = membersOf.get(channel.id) ?? [];
    const permissions = new Set<ProjectPermission>(
      channel.projectId ? ((permissionsByProject[channel.projectId] ?? []) as ProjectPermission[]) : [],
    );
    const access = accessFrom(viewer, channel, permissions, rows);
    const projectViewers = channel.projectId ? viewersOf.get(channel.projectId) : undefined;
    // I membri da mostrare: nel «general» chi vede il progetto; in un canale di progetto, senza gli ex membri.
    const members = (channel.isGeneral ? [...(projectViewers ?? [])] : rows)
      .filter((id) => humans.has(id))
      .filter((id) => channel.kind !== "project" || !projectViewers || projectViewers.has(id));
    const counted = access.isMember && access.canRead ? counts.get(channel.id) : undefined;
    const lastRead = access.isMember ? (reads.get(channel.id) ?? null) : null;
    const last = access.canRead ? lasts.get(channel.id) : undefined;
    const view: ChatChannelView = {
      id: channel.id,
      kind: channel.kind,
      projectId: channel.projectId,
      name: channel.name,
      // Chi vede un privato senza leggerlo (chi gestisce) ne sa nome e membri:
      // né l'argomento, né la descrizione, né l'attività.
      description: access.canRead ? channel.description : "",
      topic: access.canRead ? channel.topic : "",
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
      canRead: access.canRead,
      canEditInfo: access.canEditInfo,
      canEditTopic: access.canEditTopic,
      canEditEvents: access.canEditEvents,
      canInvite: access.canInvite,
      canRemove: access.canRemove,
      canArchive: access.canArchive,
      canDelete: access.canDelete,
      unread: counted?.unread ?? 0,
      mentions: counted?.mentions ?? 0,
      level: prefs.get(channel.id) ?? "all",
      lastReadAt: lastRead?.toISOString() ?? null,
      lastMessageAt: last ?? null,
      publishedEvents: channel.publishedEvents.filter((e): e is (typeof CHAT_EVENT_KINDS)[number] =>
        (CHAT_EVENT_KINDS as readonly string[]).includes(e),
      ),
    };
    return { view, toMe: counted?.toMe ?? 0 };
  });
}

/** Il canale come lo vede chi guarda (lo vede: il chiamante l'ha controllato). */
export async function channelView(db: Db, viewer: ChatViewer, channel: ChannelRow): Promise<ChatChannelView> {
  return (await channelViewsBatch(db, viewer, [channel]))[0]!.view;
}

/**
 * Le task e le richieste nate dai messaggi, che chi guarda VEDE (la regola
 * delle task e quella delle richieste, nella WHERE): un codice che non vede
 * non esce.
 */
async function linksOf(
  db: Db,
  viewer: ChatViewer,
  ids: readonly string[],
): Promise<Map<string, { kind: "task" | "request"; id: string; code: string }[]>> {
  const out = new Map<string, { kind: "task" | "request"; id: string; code: string }[]>();
  if (ids.length === 0) return out;
  const push = (messageId: string, link: { kind: "task" | "request"; id: string; code: string }) =>
    out.set(messageId, [...(out.get(messageId) ?? []), link]);
  const taskRows = await db
    .select({ messageId: chatMessageLinks.messageId, id: tickets.id, code: sql<string>`${projects.code} || '-' || ${tickets.number}` })
    .from(chatMessageLinks)
    .innerJoin(tickets, eq(tickets.id, chatMessageLinks.ticketId))
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(and(inArray(chatMessageLinks.messageId, [...ids]), await visibleTasksCondition(db, viewer)))
    .orderBy(asc(chatMessageLinks.createdAt));
  for (const r of taskRows) push(r.messageId, { kind: "task", id: r.id, code: r.code });
  const visible = await visibleProjectIds(db, viewer);
  if (visible !== "all" && visible.length === 0) return out;
  const requestRows = await db
    .select({ messageId: chatMessageLinks.messageId, id: backlogItems.id, code: sql<string>`${projects.code} || '-R' || ${backlogItems.number}` })
    .from(chatMessageLinks)
    .innerJoin(backlogItems, eq(backlogItems.id, chatMessageLinks.backlogItemId))
    .innerJoin(projects, eq(projects.id, backlogItems.projectId))
    .where(
      and(
        inArray(chatMessageLinks.messageId, [...ids]),
        visible === "all" ? undefined : inArray(backlogItems.projectId, visible),
        await requestVisibility(db, viewer),
      ),
    )
    .orderBy(asc(chatMessageLinks.createdAt));
  for (const r of requestRows) push(r.messageId, { kind: "request", id: r.id, code: r.code });
  return out;
}

/** I messaggi come li vede chi guarda: reazioni, risposte, seguito, permessi, legami. */
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
  const followOf = new Map(follows.map((f) => [f.root, f.following]));
  const live = rows.filter((r) => r.deletedAt === null).map((r) => r.id);
  const links = await linksOf(db, viewer, live);
  const citationRows =
    live.length === 0
      ? []
      : await db
          .select({ messageId: chatMessageCitations.messageId, kind: chatMessageCitations.kind, refId: chatMessageCitations.refId })
          .from(chatMessageCitations)
          .where(inArray(chatMessageCitations.messageId, live))
          .orderBy(asc(chatMessageCitations.position));
  const citations = await citationViews(db, viewer, citationRows);
  // Le risposte di @Claude (fetta 3): chi guarda è membro del loro canale? (decide chi può decidere)
  // I canali e l'appartenenza in due query, non per canale (review della fetta 2).
  const claudeChannelIds = [...new Set(rows.filter((r) => r.kind === "claude").map((r) => r.channelId))];
  const memberOf = new Map<string, { isMember: boolean; archived: boolean }>();
  if (claudeChannelIds.length > 0) {
    const channelRows = await db
      .select({ id: chatChannels.id, isGeneral: chatChannels.isGeneral, archivedAt: chatChannels.archivedAt })
      .from(chatChannels)
      .where(inArray(chatChannels.id, claudeChannelIds));
    const mine = new Set(
      (
        await db
          .select({ channelId: chatChannelMembers.channelId })
          .from(chatChannelMembers)
          .where(and(eq(chatChannelMembers.userId, viewer.id), inArray(chatChannelMembers.channelId, claudeChannelIds)))
      ).map((r) => r.channelId),
    );
    // La regola di `accessFrom`: il «general» o una riga fra i membri.
    for (const c of channelRows) memberOf.set(c.id, { isMember: c.isGeneral || mine.has(c.id), archived: c.archivedAt !== null });
  }
  const claude = await claudeReplyViews(db, viewer, rows, async (channelId) => memberOf.get(channelId) ?? { isMember: false, archived: true });
  const replying = await rootsWithClaudeWorking(db, rows.filter((r) => r.threadRootId === null).map((r) => r.id));
  return rows.map((m) => {
    const own = m.authorId === viewer.id && m.kind === "person";
    const deleted = m.deletedAt !== null;
    const reply = replies.get(m.id);
    // Un eliminato non dice più niente: né testo, né reazioni, né domande, né legami.
    const linked = deleted ? [] : (links.get(m.id) ?? []);
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
      reactions: deleted
        ? []
        : [...(byMessage.get(m.id) ?? new Map()).entries()].map(([emoji, personIds]) => ({ emoji, personIds })),
      replyCount: reply?.n ?? 0,
      lastReplyAt: reply?.last?.toISOString() ?? null,
      lastReplyById: reply?.lastBy ?? null,
      replyParticipantIds: reply?.participants ?? [],
      following: followOf.get(m.id) === true,
      mentionedIds: deleted ? [] : m.mentionedIds,
      canEdit: own && !deleted,
      // La risposta di @Claude la elimina chi l'ha chiamata (D6).
      canDelete: (own || (m.kind === "claude" && m.calledById === viewer.id)) && !deleted,
      viaClaude: m.viaClaudeActionId !== null,
      alsoInChannel: m.alsoInChannel,
      asksReplyOf: deleted ? [] : m.asksReplyOf,
      linked,
      linkedCodes: linked.map((l) => l.code),
      citations: deleted ? [] : (citations.get(m.id) ?? []),
      claude: claude.get(m.id) ?? null,
      claudeReplying: replying.has(m.id),
    } satisfies ChatMessageView;
  });
}

// --- Canali -----------------------------------------------------------------

export async function listChannels(
  db: Db,
  viewer: ChatViewer,
  opts: { projectId?: string; kind?: ChannelRow["kind"]; archived: boolean },
): Promise<ChatChannelView[]> {
  return (await listChannelsWithSignal(db, viewer, opts)).map((c) => c.view);
}

async function listChannelsWithSignal(
  db: Db,
  viewer: ChatViewer,
  opts: { projectId?: string; kind?: ChannelRow["kind"]; archived: boolean },
): Promise<{ view: ChatChannelView; toMe: number }[]> {
  const rows = await db
    .select()
    .from(chatChannels)
    .where(
      and(
        await channelVisibleSql(db, viewer),
        opts.projectId ? eq(chatChannels.projectId, opts.projectId) : undefined,
        opts.kind ? eq(chatChannels.kind, opts.kind) : undefined,
        opts.archived ? sql`${chatChannels.archivedAt} is not null` : isNull(chatChannels.archivedAt),
      ),
    )
    .orderBy(desc(chatChannels.isGeneral), asc(chatChannels.name), asc(chatChannels.createdAt));
  return channelViewsBatch(db, viewer, rows);
}

export async function getChannel(db: Db, viewer: ChatViewer, id: string): Promise<ChatChannelView> {
  const channel = await visibleChannel(db, viewer, id);
  if (!channel) throw notFound();
  return channelView(db, viewer, channel);
}

/** Il canale, se chi guarda ne LEGGE i messaggi (un privato che gestisce senza esserne membro no: 404). */
async function readableChannel(db: Db, viewer: ChatViewer, id: string): Promise<{ channel: ChannelRow; access: ChannelAccess }> {
  const channel = await visibleChannel(db, viewer, id);
  if (!channel) throw notFound();
  const access = await channelAccess(db, viewer, channel);
  if (!access.canRead) throw notFound();
  return { channel, access };
}

/** Le persone invitate: ammesse nell'ambito (in un progetto chi lo vede), mai Claude. */
async function checkInvitees(db: Db, projectId: string | null, ids: readonly string[]): Promise<void> {
  const allowed = await allowedMemberIds(db, projectId);
  if (ids.some((id) => !allowed.has(id))) {
    throw new ChatError(400, "invalid_members", "Some of these people can't join this channel");
  }
}

/**
 * Crea un canale: di progetto con `chat.channels.create` in quel progetto,
 * generale (senza progetto) con `chat.general.create`. Nome unico
 * nell'ambito. Un aperto nasce col solo creatore; un privato anche con le
 * persone invitate (in un progetto, chi lo vede). Di progetto: pubblica
 * Release, traguardi e brief.
 */
export async function createChannel(db: Db, viewer: ChatViewer, input: CreateChatChannelInput): Promise<ChatChannelView> {
  const name = chatChannelNameSchema.parse(input.name);
  const projectId = input.projectId ?? null;
  if (projectId) {
    const permissions = await projectPermissionsFor(db, viewer, projectId);
    if (!permissions) throw notFound();
    if (!permissions.has("chat.channels.create")) throw forbidden("Can't create channels here");
  } else if (!viewer.instancePermissions.has("chat.general.create")) {
    throw forbidden("Can't create general channels");
  }
  const visibility = input.visibility ?? "open";
  const invited = visibility === "private" ? [...new Set(input.memberIds ?? [])].filter((id) => id !== viewer.id) : [];
  await checkInvitees(db, projectId, invited);
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(chatChannels)
        .values({
          projectId,
          kind: projectId ? "project" : "general",
          visibility,
          name,
          description: input.description ?? "",
          topic: input.topic ?? "",
          createdBy: viewer.id,
          publishedEvents: projectId ? [...CHAT_GENERAL_DEFAULT_EVENTS] : [],
        })
        .returning({ id: chatChannels.id });
      // Chi crea il canale ne è membro, con chi ha invitato.
      await tx
        .insert(chatChannelMembers)
        .values([viewer.id, ...invited].map((userId) => ({ channelId: row!.id, userId })));
      return row!.id;
    });
    return getChannel(db, viewer, id);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ChatError(409, "name_taken", "A channel with this name already exists");
    throw error;
  }
}

/**
 * Nome e descrizione: il creatore o chi gestisce (il «general» non cambia).
 * L'argomento: qualunque membro. Archiviare: il creatore o chi gestisce. La
 * visibilità non cambia dopo la creazione.
 */
export async function updateChannel(
  db: Db,
  viewer: ChatViewer,
  id: string,
  patch: PatchChatChannelInput,
): Promise<ChatChannelView> {
  const channel = await visibleChannel(db, viewer, id);
  if (!channel) throw notFound();
  const access = await channelAccess(db, viewer, channel);
  const editsInfo = patch.name !== undefined || patch.description !== undefined;
  if (channel.isGeneral && (editsInfo || patch.archived !== undefined)) {
    throw new ChatError(409, "general_channel", "The general channel can't be changed");
  }
  if (editsInfo && !access.canEditInfo) throw forbidden("Can't change this channel");
  // La descrizione non la legge chi gestisce senza leggere il canale: non la riscrive alla cieca.
  if (patch.description !== undefined && !access.canRead) throw forbidden("Can't change this channel");
  if (patch.topic !== undefined && !access.canEditTopic) throw forbidden("Only members change the topic");
  if (patch.archived !== undefined && !access.canArchive) throw forbidden("Can't archive this channel");
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

/** Elimina un canale coi suoi messaggi: solo chi gestisce i canali dell'ambito (R-G3), mai il «general» né un DM. */
export async function deleteChannel(db: Db, viewer: ChatViewer, id: string): Promise<void> {
  const channel = await visibleChannel(db, viewer, id);
  if (!channel) throw notFound();
  if (channel.isGeneral) throw new ChatError(409, "general_channel", "The general channel can't be changed");
  if (!(await channelAccess(db, viewer, channel)).canDelete) throw forbidden("Can't delete this channel");
  await db.delete(chatChannels).where(eq(chatChannels.id, id));
  await notifyChannel(db, id);
}

/** La chiave di un DM: gli id delle sue persone, ordinati. */
const dmKeyOf = (ids: readonly string[]): string => [...new Set(ids)].sort().join(",");

/**
 * Entra o esce. «Join»: un aperto che si legge, non archiviato (mai il
 * «general», che segue il progetto). Uscire: il «general» e un DM a due no; un
 * privato non resta senza membri. Da un gruppo DM, la chiave segue chi resta.
 */
export async function joinChannel(db: Db, viewer: ChatViewer, id: string, join: boolean): Promise<ChatChannelView | null> {
  const channel = await visibleChannel(db, viewer, id);
  if (!channel) throw notFound();
  if (channel.isGeneral) throw new ChatError(409, "general_channel", "Everyone in the project is in the general channel");
  const access = await channelAccess(db, viewer, channel);
  if (join) {
    if (access.isMember) return getChannel(db, viewer, id);
    if (channel.archivedAt !== null) throw new ChatError(409, "channel_archived", "The channel is archived");
    if (!access.canJoin) throw forbidden("Ask to be invited");
    await db.insert(chatChannelMembers).values({ channelId: id, userId: viewer.id }).onConflictDoNothing();
  } else {
    if (!access.isMember) return getChannel(db, viewer, id);
    await db.transaction(async (tx) => {
      // Le uscite e le rimozioni dello stesso canale si mettono in fila: il
      // conteggio dei membri si rilegge DOPO il lock, così due uscite insieme
      // non lasciano un privato vuoto né una `dm_key` vecchia.
      const locked = await lockChannel(tx, id);
      // Contano solo i membri che leggono ancora (review della fetta 2): la riga
      // di chi non vede più il progetto resta, ma non tiene vivo un privato.
      const now = accessFrom(viewer, locked, access.permissions, await channelMemberIds(tx, locked));
      if (!now.isMember) return;
      if (!now.canLeave) throw new ChatError(409, "cannot_leave", "You can't leave this conversation");
      await tx
        .delete(chatChannelMembers)
        .where(and(eq(chatChannelMembers.channelId, id), eq(chatChannelMembers.userId, viewer.id)));
      if (channel.kind === "dm") await refreshDmKey(tx, id);
    });
  }
  await notifyChannel(db, id);
  // Chi esce da un privato o da un DM non lo vede più.
  const still = await visibleChannel(db, viewer, id);
  return still ? channelView(db, viewer, still) : null;
}

/**
 * Il canale con il lock della riga, dentro la transazione di chi cambia i
 * membri. `FOR NO KEY UPDATE`: mette in fila uscite e rimozioni senza
 * bloccare chi inserisce messaggi o membri (le FK prendono `FOR KEY SHARE`).
 */
async function lockChannel(tx: Tx, id: string): Promise<ChannelRow> {
  const [row] = await tx.select().from(chatChannels).where(eq(chatChannels.id, id)).for("no key update");
  if (!row) throw notFound();
  return row;
}

async function refreshDmKey(tx: Tx, channelId: string): Promise<void> {
  const rows = await tx
    .select({ userId: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .where(eq(chatChannelMembers.channelId, channelId));
  await tx.update(chatChannels).set({ dmKey: dmKeyOf(rows.map((r) => r.userId)) }).where(eq(chatChannels.id, channelId));
}

/**
 * Aggiunge persone. In un privato il creatore o chi gestisce, e mai sé stesso
 * (altrimenti «chi gestisce non ne legge i messaggi» si aggirerebbe con un
 * clic); in un aperto qualunque membro. In un canale di progetto solo chi vede
 * il progetto. Mai nel «general» né in un DM.
 */
export async function inviteMembers(db: Db, viewer: ChatViewer, id: string, personIds: readonly string[]): Promise<ChatChannelView> {
  const channel = await visibleChannel(db, viewer, id);
  if (!channel) throw notFound();
  const access = await channelAccess(db, viewer, channel);
  if (!access.canInvite) throw forbidden("Can't add people to this channel");
  const current = new Set(await channelMemberIds(db, channel));
  const fresh = [...new Set(personIds)].filter((p) => !current.has(p));
  if (fresh.length === 0) throw new ChatError(400, "invalid_members", "Everyone is already in the channel");
  if (fresh.includes(viewer.id)) throw forbidden("You can't add yourself");
  await checkInvitees(db, channel.projectId, fresh);
  await db.insert(chatChannelMembers).values(fresh.map((userId) => ({ channelId: id, userId }))).onConflictDoNothing();
  await notifyChannel(db, id);
  return getChannel(db, viewer, id);
}

/** Toglie una persona: il creatore o chi gestisce (mai nel «general» né in un DM); un privato non resta vuoto. */
export async function removeMember(db: Db, viewer: ChatViewer, id: string, personId: string): Promise<ChatChannelView | null> {
  const channel = await visibleChannel(db, viewer, id);
  if (!channel) throw notFound();
  const access = await channelAccess(db, viewer, channel);
  if (!access.canRemove) throw forbidden("Can't remove people from this channel");
  await db.transaction(async (tx) => {
    // Come all'uscita: il conteggio si rilegge sotto il lock del canale.
    const locked = await lockChannel(tx, id);
    // Solo chi legge ancora (review della fetta 2), come all'uscita.
    const current = await channelMemberIds(tx, locked);
    if (!current.includes(personId)) throw notFound();
    if (channel.visibility === "private" && current.length <= 1) {
      throw new ChatError(409, "last_member", "A private channel can't be left empty");
    }
    await tx
      .delete(chatChannelMembers)
      .where(and(eq(chatChannelMembers.channelId, id), eq(chatChannelMembers.userId, personId)));
  });
  await notifyChannel(db, id);
  const still = await visibleChannel(db, viewer, id);
  return still ? channelView(db, viewer, still) : null;
}

/**
 * Apre un messaggio diretto con queste persone (fino a 8 compresa chi lo
 * apre): quello che esiste già con le stesse persone (il più vecchio), o uno
 * nuovo. Due aperture uguali in contemporanea si serializzano sulla chiave.
 */
export async function openDm(db: Db, viewer: ChatViewer, personIds: readonly string[]): Promise<ChatChannelView> {
  const others = [...new Set(personIds)].filter((p) => p !== viewer.id);
  if (others.length === 0 || others.length > CHAT_DM_MAX_PEOPLE - 1) {
    throw new ChatError(400, "invalid_members", `A direct message has 2 to ${CHAT_DM_MAX_PEOPLE} people`);
  }
  if ((await peopleOf(db, others)).length !== others.length) {
    throw new ChatError(400, "invalid_members", "Some of these people don't exist");
  }
  const people = [viewer.id, ...others];
  const key = dmKeyOf(people);
  const id = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`chat-dm:${key}`}))`);
    // Il più vecchio con la chiave E con esattamente quelle persone: una
    // chiave rimasta indietro non apre mai il DM sbagliato.
    const candidates = await tx
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(and(eq(chatChannels.kind, "dm"), eq(chatChannels.dmKey, key)))
      .orderBy(asc(chatChannels.createdAt));
    for (const c of candidates) {
      const members = await tx
        .select({ userId: chatChannelMembers.userId })
        .from(chatChannelMembers)
        .where(eq(chatChannelMembers.channelId, c.id));
      if (dmKeyOf(members.map((m) => m.userId)) === key) return c.id;
    }
    const [row] = await tx
      .insert(chatChannels)
      .values({ kind: "dm", visibility: "private", name: "", createdBy: viewer.id, dmKey: key })
      .returning({ id: chatChannels.id });
    await tx.insert(chatChannelMembers).values(people.map((userId) => ({ channelId: row!.id, userId })));
    return row!.id;
  });
  return getChannel(db, viewer, id);
}

// --- Messaggi ----------------------------------------------------------------

/** Il messaggio, se chi guarda ne LEGGE il canale. */
async function readableMessage(
  db: Db,
  viewer: ChatViewer,
  id: string,
): Promise<{ message: MessageRow; channel: ChannelRow; access: ChannelAccess }> {
  const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, id));
  if (!message) throw notFound();
  const { channel, access } = await readableChannel(db, viewer, message.channelId);
  return { message, channel, access };
}

const PAGE_DEFAULT = 50;

/** `created_at` in microsecondi interi, per il cursore di pagina (un `Date` perderebbe i µs). */
const createdMicros = sql<string>`(extract(epoch from ${chatMessages.createdAt}) * 1000000)::bigint`;

/**
 * Una pagina del FLUSSO del canale (le radici e le risposte «anche nel
 * canale», senza gli spariti), dalla più vecchia alla più nuova; `before` =
 * `<µs di created_at>|<id>`, opaco per il client. Un cursore malformato è 400.
 */
export async function listMessages(
  db: Db,
  viewer: ChatViewer,
  channelId: string,
  opts: { before?: string; limit?: number },
): Promise<{ items: ChatMessageView[]; before: string | null }> {
  await readableChannel(db, viewer, channelId);
  const limit = Math.min(Math.max(opts.limit ?? PAGE_DEFAULT, 1), 200);
  const cursor = parseCursor(opts.before);
  const rows = await db
    .select({ message: chatMessages, micros: sql<string>`${createdMicros}::text` })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.channelId, channelId),
        flowSql,
        sql`not ${goneSql}`,
        cursor
          ? sql`(${createdMicros}, ${chatMessages.id}) < (${cursor.micros}::bigint, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).reverse();
  const first = page[0];
  return {
    items: await messageViews(db, viewer, page.map((r) => r.message)),
    before: rows.length > limit && first ? `${first.micros}|${first.message.id}` : null,
  };
}

const PAGE_CURSOR_RE = /^(\d{1,19})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function parseCursor(raw: string | undefined): { micros: string; id: string } | null {
  if (!raw) return null;
  const m = PAGE_CURSOR_RE.exec(raw);
  if (!m || BigInt(m[1]!) > CHAT_CURSOR_MAX) throw new ChatError(400, "invalid_cursor", "Invalid page cursor");
  return { micros: m[1]!, id: m[2]! };
}

export async function getMessage(db: Db, viewer: ChatViewer, id: string): Promise<ChatMessageView> {
  const { message } = await readableMessage(db, viewer, id);
  return (await messageViews(db, viewer, [message]))[0]!;
}

/** Il thread di un messaggio: la radice e le risposte vive (con l'id di una risposta, la sua radice). */
export async function getThread(
  db: Db,
  viewer: ChatViewer,
  id: string,
): Promise<{ root: ChatMessageView; replies: ChatMessageView[]; lastReadAt: string | null }> {
  const { message } = await readableMessage(db, viewer, id);
  const rootId = message.threadRootId ?? message.id;
  const [root] = await db.select().from(chatMessages).where(eq(chatMessages.id, rootId));
  const replies = await db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.threadRootId, rootId), sql`not ${goneSql}`))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  const views = await messageViews(db, viewer, [root!, ...replies]);
  const [read] = await db
    .select({ at: chatReads.lastReadAt })
    .from(chatReads)
    .where(and(eq(chatReads.userId, viewer.id), eq(chatReads.threadRootId, rootId)));
  return { root: views[0]!, replies: views.slice(1), lastReadAt: read?.at.toISOString() ?? null };
}

/** Sostituisce le citazioni di un messaggio (alla scrittura e alla modifica). */
async function writeCitations(
  tx: Tx,
  messageId: string,
  citations: readonly { kind: ChatCitationRef["kind"]; id: string }[],
): Promise<void> {
  await tx.delete(chatMessageCitations).where(eq(chatMessageCitations.messageId, messageId));
  if (citations.length === 0) return;
  await tx
    .insert(chatMessageCitations)
    .values(citations.map((c, position) => ({ messageId, kind: c.kind, refId: c.id, position })));
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
  input: { text: string; threadRootId?: string; alsoInChannel?: boolean; asksReply?: boolean; citations?: readonly ChatCitationRef[] },
): Promise<ChatMessageView> {
  const { channel, access } = await readableChannel(db, viewer, channelId);
  if (channel.archivedAt !== null) throw new ChatError(409, "channel_archived", "The channel is archived");
  if (!access.canWrite) throw new ChatError(403, "not_member", "Join the channel to write");
  let root: MessageRow | undefined;
  if (input.threadRootId) {
    [root] = await db.select().from(chatMessages).where(eq(chatMessages.id, input.threadRootId));
    if (!root || root.channelId !== channelId || root.threadRootId !== null || root.deletedAt !== null) {
      throw new ChatError(400, "invalid_thread", "Reply to a message of this channel");
    }
  }
  if (input.alsoInChannel && !root) {
    throw new ChatError(400, "invalid_also_in_channel", "Only a reply goes also to the channel");
  }
  const mentioned = await mentionedIn(db, channel, input.text, viewer.id);
  const asks = questionTargets(input.text, mentioned, input.asksReply === true);
  const citations = await citationsToStore(db, viewer, input.text, input.citations ?? []);
  const members = new Set(await channelMemberIds(db, channel));
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
        notifiedIds: mentioned,
        asksReplyOf: asks,
        alsoInChannel: Boolean(root && input.alsoInChannel),
        searchFolded: foldChatText(input.text),
      })
      .returning();
    await writeCitations(tx, row!.id, citations);
    // «@Claude»: la risposta nasce SUBITO nel thread di questo messaggio, a nome
    // di chi scrive (fetta 3). Una modifica che aggiunge «@Claude» non chiama.
    if (callsClaude(input.text)) {
      const rootId = root?.id ?? row!.id;
      await startClaudeReply(tx, { viewer, channel, call: row!, rootId, thread: await callContext(tx, viewer, row!, rootId) });
    }
    if (root) {
      // La radice cambia (risposte, ultima risposta): lo stream la rimanda.
      await tx.update(chatMessages).set({ updatedAt: sql`now()` }).where(eq(chatMessages.id, root.id));
      // Seguono il thread: l'autore della radice, chi risponde, chi è nominato.
      await follow(tx, [...(root.authorId ? [root.authorId] : []), viewer.id, ...mentioned], root.id);
    } else if (mentioned.length > 0) {
      await follow(tx, [viewer.id, ...mentioned], row!.id);
    }
    // Le menzioni e le domande dirette: una card per persona (D4), con push.
    // Il canale lo legge, l'ha controllato `mentionedIn` (chi legge il canale).
    await publishCards(tx, {
      channel,
      messageId: row!.id,
      authorId: viewer.id,
      authorName: author?.name ?? "",
      to: mentioned,
      asks,
      members,
    });
    await notifyChannel(tx, channelId);
    return row!.id;
  });
  return getMessage(db, viewer, id);
}

async function ownMessage(
  db: Db,
  viewer: ChatViewer,
  id: string,
  opts: { claudeReply?: boolean } = {},
): Promise<{ message: MessageRow; channel: ChannelRow; access: ChannelAccess }> {
  const found = await readableMessage(db, viewer, id);
  // Il proprio messaggio, o (solo per eliminarla) la risposta di @Claude che si è chiamata (D6).
  const own = found.message.authorId === viewer.id && found.message.kind === "person";
  const ownReply = opts.claudeReply === true && found.message.kind === "claude" && found.message.calledById === viewer.id;
  if (!own && !ownReply) {
    throw new ChatError(403, "not_yours", "Only your own messages");
  }
  if (found.message.deletedAt !== null) throw new ChatError(409, "deleted", "The message was deleted");
  // In un archiviato non si modifica né si elimina (writes.ts:405, :429 del prototipo).
  if (found.channel.archivedAt !== null) throw new ChatError(409, "channel_archived", "The channel is archived");
  return found;
}

/**
 * Modifica: solo i propri (D6). Le menzioni si ricalcolano; avvisa solo chi
 * è nominato ADESSO per la prima volta. Le domande seguono il testo nuovo: chi
 * non è più nominato non aspetta più, chi lo è ancora resta.
 */
export async function editMessage(
  db: Db,
  viewer: ChatViewer,
  id: string,
  text: string,
  picked: readonly ChatCitationRef[] = [],
): Promise<ChatMessageView> {
  const { message, channel, access } = await ownMessage(db, viewer, id);
  // Modificare è scrivere: solo da membro (`writable` del prototipo).
  if (!access.canWrite) throw new ChatError(403, "not_member", "Join the channel to edit");
  // Le citazioni si ricalcolano dal testo nuovo: quelle di prima più le scelte nuove.
  const before = await db
    .select({ kind: chatMessageCitations.kind, id: chatMessageCitations.refId })
    .from(chatMessageCitations)
    .where(eq(chatMessageCitations.messageId, id))
    .orderBy(asc(chatMessageCitations.position));
  const citations = await citationsToStore(db, viewer, text, [...before, ...picked]);
  const mentioned = await mentionedIn(db, channel, text, viewer.id);
  // Avvisa solo chi non è MAI stato avvisato per questo messaggio: una menzione
  // tolta e rimessa non manda una seconda card.
  const added = mentioned.filter((m) => !message.notifiedIds.includes(m));
  const asked = questionTargets(text, mentioned, false);
  const kept = message.asksReplyOf.filter((p) => mentioned.includes(p));
  const asks = [...new Set([...kept, ...asked])];
  const members = new Set(await channelMemberIds(db, channel));
  const [author] = await peopleOf(db, [viewer.id]);
  await db.transaction(async (tx) => {
    await tx
      .update(chatMessages)
      .set({
        body: text,
        mentionedIds: mentioned,
        notifiedIds: [...new Set([...message.notifiedIds, ...added])],
        asksReplyOf: asks,
        searchFolded: foldChatText(text),
        editedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(chatMessages.id, id));
    await writeCitations(tx, id, citations);
    // Chi è nominato con una modifica segue il thread, come alla scrittura.
    if (added.length > 0) await follow(tx, message.threadRootId ? added : [viewer.id, ...added], message.threadRootId ?? id);
    await publishCards(tx, {
      channel,
      messageId: id,
      authorId: viewer.id,
      authorName: author?.name ?? "",
      to: added,
      asks,
      members,
    });
    await notifyChannel(tx, channel.id);
  });
  return getMessage(db, viewer, id);
}

/** Eliminazione: solo i propri (D6); il testo sparisce (CHECK `deleted_at` ⇒ `body = ''`), con domande e reazioni. */
export async function deleteMessage(db: Db, viewer: ChatViewer, id: string): Promise<void> {
  const { channel, message } = await ownMessage(db, viewer, id, { claudeReply: true });
  await db.transaction(async (tx) => {
    // Una risposta di @Claude che lavora si ferma con lei, e le sue proposte aperte decadono.
    if (message.kind === "claude") {
      await stopSession(tx, message.agentSessionId);
      if (message.agentSessionId) {
        await tx
          .update(claudeProposals)
          .set({ status: "cancelled", decidedAt: sql`now()`, decidedBy: viewer.id })
          .where(and(eq(claudeProposals.sessionId, message.agentSessionId), eq(claudeProposals.status, "open")));
      }
      if (message.claudeState === "working" || message.claudeState === "waiting") {
        await tx.update(chatMessages).set({ claudeState: "stopped" }).where(eq(chatMessages.id, id));
      }
    }
    await tx
      .update(chatMessages)
      .set({
        body: "",
        mentionedIds: [],
        asksReplyOf: [],
        searchFolded: "",
        deletedAt: sql`now()`,
        deletedBy: viewer.id,
        updatedAt: sql`now()`,
      })
      .where(eq(chatMessages.id, id));
    await tx.delete(chatReactions).where(eq(chatReactions.messageId, id));
    await tx.delete(chatMessageCitations).where(eq(chatMessageCitations.messageId, id));
    // Una risposta eliminata cambia la radice (risposte, ultima): lo stream la rimanda.
    if (message.threadRootId) {
      await tx.update(chatMessages).set({ updatedAt: sql`now()` }).where(eq(chatMessages.id, message.threadRootId));
    }
    await notifyChannel(tx, channel.id);
  });
}

/** Reazione: un toggle (`toggleReaction` del prototipo), da chi legge il canale ed è membro. */
export async function toggleReaction(db: Db, viewer: ChatViewer, id: string, emoji: string): Promise<ChatMessageView> {
  const { message, channel, access } = await readableMessage(db, viewer, id);
  if (message.deletedAt !== null) throw new ChatError(409, "deleted", "The message was deleted");
  if (!access.canWrite) throw new ChatError(403, "not_member", "Join the channel to react");
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

/**
 * Letto fino a `at`: il canale, o con `threadRootId` il thread (`markRead` /
 * `markThreadRead` del prototipo). Un `at` esplicito vale com'è, anche più
 * vecchio: è «Mark unread from here», che rimette fra i non letti i messaggi
 * dopo. Senza `at`, fino all'ultimo messaggio (del canale, o del thread), con
 * l'ora del DATABASE, mai quella del server: i due orologi non coincidono, e i
 * microsecondi di Postgres non passano da un `Date`.
 */
export async function markRead(
  db: Db,
  viewer: ChatViewer,
  channelId: string,
  input: { threadRootId?: string; at?: string },
): Promise<void> {
  await readableChannel(db, viewer, channelId);
  if (input.threadRootId) {
    const [root] = await db.select({ channelId: chatMessages.channelId }).from(chatMessages).where(eq(chatMessages.id, input.threadRootId));
    if (!root || root.channelId !== channelId) throw notFound();
    const at = input.at
      ? sql`${input.at}::timestamptz`
      : sql`(select coalesce(max(m.created_at), now()) from chat_messages m where m.id = ${input.threadRootId} or m.thread_root_id = ${input.threadRootId})`;
    await db
      .insert(chatReads)
      .values({ userId: viewer.id, channelId, threadRootId: input.threadRootId, lastReadAt: at })
      .onConflictDoUpdate({
        target: [chatReads.userId, chatReads.threadRootId],
        targetWhere: sql`${chatReads.threadRootId} is not null`,
        set: { lastReadAt: sql`excluded.last_read_at` },
      });
    return;
  }
  const at = input.at
    ? sql`${input.at}::timestamptz`
    : sql`(select coalesce(max(m.created_at), now()) from chat_messages m where m.channel_id = ${channelId})`;
  await db
    .insert(chatReads)
    .values({ userId: viewer.id, channelId, lastReadAt: at })
    .onConflictDoUpdate({
      target: [chatReads.userId, chatReads.channelId],
      targetWhere: sql`${chatReads.threadRootId} is null`,
      set: { lastReadAt: sql`excluded.last_read_at` },
    });
}

export async function setNotifyLevel(db: Db, viewer: ChatViewer, channelId: string, level: ChatNotifyLevel): Promise<ChatChannelView> {
  const { channel } = await readableChannel(db, viewer, channelId);
  await db
    .insert(chatChannelPrefs)
    .values({ userId: viewer.id, channelId, level })
    .onConflictDoUpdate({ target: [chatChannelPrefs.userId, chatChannelPrefs.channelId], set: { level } });
  return channelView(db, viewer, channel);
}

export async function setThreadFollow(db: Db, viewer: ChatViewer, id: string, following: boolean): Promise<ChatMessageView> {
  const { message, access } = await readableMessage(db, viewer, id);
  // Seguire un thread è da membro (writes.ts:498 del prototipo).
  if (!access.isMember) throw new ChatError(403, "not_member", "Join the channel to follow its threads");
  const rootId = message.threadRootId ?? message.id;
  await db
    .insert(chatThreadFollows)
    .values({ userId: viewer.id, rootMessageId: rootId, following })
    .onConflictDoUpdate({ target: [chatThreadFollows.userId, chatThreadFollows.rootMessageId], set: { following } });
  return getMessage(db, viewer, rootId);
}

// --- @Claude: fermare, rifare, rispondere, decidere (fetta 3) ----------------------

/** Una risposta di @Claude che chi agisce legge, e che ha chiamato lui. */
async function ownClaudeReply(
  db: Db,
  viewer: ChatViewer,
  id: string,
): Promise<{ message: MessageRow; channel: ChannelRow; access: ChannelAccess }> {
  const found = await readableMessage(db, viewer, id);
  if (found.message.kind !== "claude" || found.message.claudeState === null) throw notFound();
  if (found.message.calledById !== viewer.id) throw new ChatError(403, "not_yours", "Only who called Claude");
  if (found.message.deletedAt !== null) throw new ChatError(409, "deleted", "The message was deleted");
  return found;
}

/**
 * «Stop»: solo chi l'ha chiamata, su una risposta che lavora o aspetta. Il
 * testo arrivato resta; nulla arriva più (il turno si ferma).
 */
export async function stopClaudeReply(db: Db, viewer: ChatViewer, id: string): Promise<ChatMessageView> {
  const { message, channel } = await ownClaudeReply(db, viewer, id);
  await db.transaction(async (tx) => {
    const stopped = await tx
      .update(chatMessages)
      .set({ claudeState: "stopped", updatedAt: sql`now()` })
      .where(and(eq(chatMessages.id, id), inArray(chatMessages.claudeState, ["working", "waiting"])))
      .returning({ id: chatMessages.id });
    if (stopped.length === 0) throw new ChatError(409, "invalid_status", "The reply isn't running");
    await stopSession(tx, message.agentSessionId);
    await notifyChannel(tx, channel.id);
  });
  return getMessage(db, viewer, id);
}

/**
 * «Try again» su una risposta fallita: solo chi l'ha chiamata, una volta.
 * Rifà la stessa chiamata come una risposta NUOVA in fondo al thread (la
 * fallita resta, senza più «Try again»), con lo stesso contesto: il thread fino
 * alla chiamata. Il messaggio che chiamava deve esserci ancora.
 */
export async function retryClaudeReply(db: Db, viewer: ChatViewer, id: string): Promise<ChatMessageView> {
  const { message, channel, access } = await ownClaudeReply(db, viewer, id);
  if (message.claudeState !== "failed" || message.claudeRetried) throw new ChatError(409, "invalid_status", "Only a failed reply, once");
  if (channel.archivedAt !== null) throw new ChatError(409, "channel_archived", "The channel is archived");
  if (!access.isMember) throw new ChatError(403, "not_member", "Join the channel to call Claude");
  const [call] = message.callMessageId ? await db.select().from(chatMessages).where(eq(chatMessages.id, message.callMessageId)) : [];
  if (!call || call.deletedAt !== null) throw new ChatError(409, "deleted", "The message that called Claude was deleted");
  const rootId = call.threadRootId ?? call.id;
  const fresh = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(chatMessages)
      .set({ claudeRetried: true, updatedAt: sql`now()` })
      .where(and(eq(chatMessages.id, id), eq(chatMessages.claudeRetried, false)))
      .returning({ id: chatMessages.id });
    if (claimed.length === 0) throw new ChatError(409, "invalid_status", "Only a failed reply, once");
    const replyId = await startClaudeReply(tx, { viewer, channel, call, rootId, thread: await callContext(tx, viewer, call, rootId) });
    await notifyChannel(tx, channel.id);
    return replyId;
  });
  if (!fresh) throw new ChatError(409, "claude_unavailable", "Claude isn't available on this instance");
  return getMessage(db, viewer, fresh);
}

/**
 * Risponde alla domanda che Claude ha fatto a chi l'ha chiamato (R-G4): solo
 * lui, una volta — una seconda risposta, anche concorrente, è
 * `already_answered`. La stessa risposta di Claude riparte, con i suoi permessi.
 */
export async function answerClaudeQuestion(
  db: Db,
  viewer: ChatViewer,
  id: string,
  answer: { questionId: string; optionIndex: number | null; text: string | null },
): Promise<ChatMessageView> {
  const { message, channel, access } = await ownClaudeReply(db, viewer, id);
  const [question] = await db
    .select()
    .from(chatClaudeQuestions)
    .where(and(eq(chatClaudeQuestions.id, answer.questionId), eq(chatClaudeQuestions.replyMessageId, id)));
  if (!question) throw notFound();
  if (question.answeredAt !== null) throw new ChatError(409, "already_answered", "Already answered");
  if (message.claudeState !== "waiting" || !message.agentSessionId) throw new ChatError(409, "invalid_status", "The reply isn't waiting");
  if (channel.archivedAt !== null) throw new ChatError(409, "channel_archived", "The channel is archived");
  if (!access.isMember) throw new ChatError(403, "not_member", "Join the channel to answer");
  const option = answer.optionIndex === null ? undefined : question.options[answer.optionIndex];
  if (answer.optionIndex !== null && !option) throw new ChatError(400, "invalid_option", "No such option");
  const text = answer.text?.trim() || null;
  if (!option && !text) throw new ChatError(400, "invalid_answer", "Pick an option or write an answer");
  const sessionId = message.agentSessionId;
  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(chatClaudeQuestions)
      .set({ answerOptionIndex: answer.optionIndex, answerText: text, answeredBy: viewer.id, answeredAt: sql`now()` })
      .where(and(eq(chatClaudeQuestions.id, question.id), isNull(chatClaudeQuestions.answeredAt)))
      .returning({ id: chatClaudeQuestions.id });
    if (claimed.length === 0) throw new ChatError(409, "already_answered", "Already answered");
    await tx.update(chatMessages).set({ claudeState: "working", updatedAt: sql`now()` }).where(eq(chatMessages.id, id));
    // La ripresa: la stessa sessione, con la risposta come messaggio di chi ha chiamato.
    const label = option?.label ?? text!;
    await tx.insert(agentSessionInputs).values({
      sessionId,
      authorUserId: viewer.id,
      text: text && option ? `${option.label} — ${text}` : label,
      interrupt: false,
    });
    await tx.execute(sql`select pg_notify(${AGENT_SESSION_INPUT_CHANNEL}, ${JSON.stringify({ sessionId })})`);
    await notifyChannel(tx, channel.id);
  });
  return getMessage(db, viewer, id);
}

// --- Viste trasversali ---------------------------------------------------------

/**
 * I thread seguiti con novità per chi guarda (la WHERE di `threadsWithNews`,
 * sopra `chat_messages` della radice, `chat_thread_follows` e `chat_channels`):
 * la usa anche `signalOf`, con un EXISTS, senza costruire viste.
 */
async function threadNewsWhere(db: Db, viewer: ChatViewer): Promise<SQL> {
  const readable = await channelReadableSql(db, viewer);
  return and(
        eq(chatThreadFollows.following, true),
        readable,
        // Membro del canale, nella WHERE (review della fetta 2): i thread di un
        // canale lasciato non occupano i 100 posti. Chi esce smette così di
        // seguirne i thread, a lettura, senza riscrivere i follow.
        channelMemberSql(viewer.id),
        // Le novità PRIMA del limite: cento thread seguiti senza risposte nuove non nascondono il centunesimo.
        sql`exists (
          select 1 from chat_messages r
          where r.thread_root_id = ${chatMessages.id}
            and r.deleted_at is null
            and (r.author_id is null or r.author_id <> ${viewer.id})
            and r.created_at > coalesce((
              select cr.last_read_at from chat_reads cr
              where cr.user_id = ${viewer.id} and cr.thread_root_id = ${chatMessages.id}
            ), to_timestamp(0))
        )`,
  )!;
}

/**
 * Le radici dei thread che chi guarda segue, nei canali che legge e di cui è
 * membro, con risposte di altri dopo la sua lettura del thread.
 */
export async function threadsWithNews(
  db: Db,
  viewer: ChatViewer,
): Promise<{ root: ChatMessageView; unreadReplies: number; latestReplies: ChatMessageView[]; archived: boolean }[]> {
  const rows = await db
    .select({
      root: chatMessages,
      channel: chatChannels,
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
    .where(await threadNewsWhere(db, viewer))
    .orderBy(desc(chatMessages.updatedAt))
    .limit(100);
  const withNews = rows;
  if (withNews.length === 0) return [];
  // Le ultime tre risposte vive di OGNI thread in una query a finestra, e una vista sola per tutto.
  const rootIds = withNews.map((r) => r.root.id);
  const latestIds = [
    ...(await db.execute<{ id: string }>(sql`
      select id from (
        select ${chatMessages.id} as id,
          row_number() over (partition by ${chatMessages.threadRootId} order by ${chatMessages.createdAt} desc, ${chatMessages.id} desc) as rank
        from ${chatMessages}
        where ${chatMessages.threadRootId} in (${sql.join(rootIds.map((id) => sql`${id}::uuid`), sql`, `)})
          and not ${goneSql}
      ) ranked
      where rank <= 3
    `)),
  ].map((r) => r.id);
  const latestRows = latestIds.length > 0 ? await db.select().from(chatMessages).where(inArray(chatMessages.id, latestIds)) : [];
  const views = await messageViews(db, viewer, [...withNews.map((r) => r.root), ...latestRows]);
  const byId = new Map(views.map((v) => [v.id, v]));
  return withNews.map((r) => ({
    root: byId.get(r.root.id)!,
    unreadReplies: r.unread,
    latestReplies: latestRows
      .filter((m) => m.threadRootId === r.root.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((m) => byId.get(m.id)!),
    archived: r.channel.archivedAt !== null,
  }));
}

/**
 * Le menzioni di chi guarda nei canali che legge (persona, domanda, e
 * `@channel`/reparto dove è membro), dal più recente.
 */
export async function mentionsOf(db: Db, viewer: ChatViewer): Promise<ChatMessageView[]> {
  const direct = directSql(viewer.id);
  const group = groupSql(await groupPatterns(db, viewer.id));
  const rows = await db
    .select({ message: chatMessages, channel: chatChannels, direct: sql<boolean>`${direct}` })
    .from(chatMessages)
    .innerJoin(chatChannels, eq(chatChannels.id, chatMessages.channelId))
    .where(
      and(
        // `@channel`/reparto solo dove è membro, nella WHERE (review della fetta 2).
        or(direct, and(group, channelMemberSql(viewer.id))),
        isNull(chatMessages.deletedAt),
        or(isNull(chatMessages.authorId), ne(chatMessages.authorId, viewer.id)),
        await channelReadableSql(db, viewer),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(50);
  return messageViews(db, viewer, rows.map((r) => r.message));
}

/**
 * Il punto del binario (`chatSignalOf` del prototipo): qualcosa rivolto proprio
 * a chi guarda — una menzione diretta o una domanda non lette, un DM non letto
 * non silenziato, un thread seguito con risposte nuove — nei canali non
 * archiviati. Il traffico normale dei canali e `@channel`/reparto no.
 */
export async function signalOf(db: Db, viewer: ChatViewer): Promise<{ hasNews: boolean; mentions: number }> {
  const channels = await listChannelsWithSignal(db, viewer, { archived: false });
  const mentions = channels.reduce((n, c) => n + c.toMe, 0);
  if (mentions > 0) return { hasNews: true, mentions };
  // Un EXISTS, non le viste dei thread (review della fetta 2).
  const [row] = await db
    .select({ yes: sql<number>`1` })
    .from(chatMessages)
    .innerJoin(chatThreadFollows, and(eq(chatThreadFollows.rootMessageId, chatMessages.id), eq(chatThreadFollows.userId, viewer.id)))
    .innerJoin(chatChannels, eq(chatChannels.id, chatMessages.channelId))
    .where(and(await threadNewsWhere(db, viewer), isNull(chatChannels.archivedAt)))
    .limit(1);
  return { hasNews: row !== undefined, mentions };
}

/** Il cursore più grande che Postgres accetta in un `bigint` (oltre è 400, non un giro infinito). */
export const CHAT_CURSOR_MAX = 9223372036854775807n;
/**
 * La finestra di sovrapposizione dello stream, in microsecondi. `updated_at =
 * now()` è l'INIZIO della transazione che scrive: una transazione lunga può
 * committare un messaggio con un `updated_at` più vecchio del cursore già
 * mandato. Si rilegge quindi da cursore meno la finestra, e `seen` scarta ciò
 * che è già partito con lo stesso `updated_at`.
 */
export const CHAT_STREAM_OVERLAP_MICROS = 5_000_000n;
/** Le righe in avanti per giro: oltre, il cursore avanza e il giro dopo continua. */
export const CHAT_STREAM_PAGE = 500;
/** Le righe della finestra dietro il cursore: tetto di sicurezza, ben sopra un canale vivo. */
export const CHAT_STREAM_OVERLAP_MAX = 2_000;

/**
 * I messaggi del canale cambiati dopo `after` (lo stream): nuovi, modificati,
 * eliminati, reazioni, risposte, legami. Senza `after` nessun messaggio, e il
 * cursore parte da adesso: la storia la carica la pagina, non lo stream.
 * `seen` (id → `updated_at` in µs) lo tiene chi apre lo stream, per tutta la
 * connessione: un messaggio ripetuto dalla finestra di sovrapposizione non
 * riparte, uno cambiato di nuovo sì.
 */
export async function changedSince(
  db: Db,
  viewer: ChatViewer,
  channelId: string,
  after: string | undefined,
  seen: Map<string, string> = new Map(),
): Promise<{ messages: ChatMessageView[]; cursor: string | null } | null> {
  const channel = await visibleChannel(db, viewer, channelId);
  if (!channel || !(await channelAccess(db, viewer, channel)).canRead) return null;
  // Il cursore: i MICROSECONDI dall'epoca, interi e solo cifre. Un `Date` del
  // JS troncherebbe ai millisecondi.
  const micros = sql<string>`(extract(epoch from ${chatMessages.updatedAt}) * 1000000)::bigint`;
  if (!after || !/^\d{1,20}$/.test(after) || BigInt(after) > CHAT_CURSOR_MAX) {
    const [row] = await db
      .select({ max: sql<string>`coalesce(max(${micros}), (extract(epoch from now()) * 1000000)::bigint)::text` })
      .from(chatMessages)
      .where(eq(chatMessages.channelId, channelId));
    // Niente in `seen` all'apertura (review della fetta 2): un messaggio arrivato
    // fra la lettura della pagina e l'apertura dello stream è nella finestra, e
    // il primo giro lo rimanda. Il client deduplica per id.
    return { messages: [], cursor: row?.max ?? "0" };
  }
  // Due letture distinte (review della fetta 2): la finestra di sovrapposizione
  // DIETRO il cursore (le transazioni committate in ritardo), e la lettura IN
  // AVANTI a pagine. Con una lettura sola e un `limit`, 500 righe nella
  // finestra già viste tenevano il cursore fermo per sempre.
  const at = BigInt(after);
  const from = at > CHAT_STREAM_OVERLAP_MICROS ? at - CHAT_STREAM_OVERLAP_MICROS : 0n;
  const overlap = await db
    .select({ message: chatMessages, cursor: sql<string>`${micros}::text` })
    .from(chatMessages)
    .where(and(eq(chatMessages.channelId, channelId), sql`${micros} > ${from.toString()}::bigint`, sql`${micros} <= ${at.toString()}::bigint`))
    .orderBy(asc(chatMessages.updatedAt), asc(chatMessages.id))
    .limit(CHAT_STREAM_OVERLAP_MAX);
  const forward = await db
    .select({ message: chatMessages, cursor: sql<string>`${micros}::text` })
    .from(chatMessages)
    .where(and(eq(chatMessages.channelId, channelId), sql`${micros} > ${at.toString()}::bigint`))
    .orderBy(asc(chatMessages.updatedAt), asc(chatMessages.id))
    .limit(CHAT_STREAM_PAGE);
  const rows = [...overlap, ...forward];
  const fresh = rows.filter((r) => seen.get(r.message.id) !== r.cursor);
  for (const r of fresh) seen.set(r.message.id, r.cursor);
  const top = forward.reduce((max, r) => (BigInt(r.cursor) > max ? BigInt(r.cursor) : max), at);
  // `seen` non cresce senza fine: ciò che è uscito dalla finestra non può tornare.
  const floor = top - CHAT_STREAM_OVERLAP_MICROS;
  for (const [id, cursorOf] of seen) if (BigInt(cursorOf) < floor) seen.delete(id);
  return {
    messages: await messageViews(db, viewer, fresh.map((r) => r.message)),
    cursor: top.toString(),
  };
}

// --- Domande («Da decidere») ------------------------------------------------------

/** La persona ha risposto a `m` dopo che è stato scritto: nel suo thread o, per un messaggio del canale, nel canale. */
function answeredSql(viewerId: string): SQL {
  return sql`exists (
    select 1 from chat_messages n
    where n.channel_id = ${chatMessages.channelId}
      and n.author_id = ${viewerId}
      and n.kind = 'person'
      and n.deleted_at is null
      and n.created_at > ${chatMessages.createdAt}
      and (
        n.thread_root_id = coalesce(${chatMessages.threadRootId}, ${chatMessages.id})
        or (${chatMessages.threadRootId} is null and n.thread_root_id is null)
      )
  )`;
}

export interface ChatQuestionItem {
  id: string;
  channelId: string;
  messageId: string;
  rootId: string;
  askedById: string | null;
  text: string;
  createdAt: string;
}

/**
 * Le domande rivolte a chi guarda (`chatQuestionsOf` del prototipo): i
 * messaggi che gli chiedono una risposta, nei canali che legge e di cui è
 * membro, non archiviati, finché non risponde o non le ignora. Un messaggio
 * eliminato non chiede più nulla.
 */
export async function questionsOf(db: Db, viewer: ChatViewer): Promise<ChatQuestionItem[]> {
  const rows = await db
    .select({ message: chatMessages, channel: chatChannels })
    .from(chatMessages)
    .innerJoin(chatChannels, eq(chatChannels.id, chatMessages.channelId))
    .where(
      and(
        sql`${viewer.id}::uuid = any(${chatMessages.asksReplyOf})`,
        isNull(chatMessages.deletedAt),
        isNull(chatChannels.archivedAt),
        await channelReadableSql(db, viewer),
        sql`not exists (
          select 1 from ${chatDismissedQuestions} d
          where d.user_id = ${viewer.id} and d.message_id = ${chatMessages.id}
        )`,
        sql`not ${answeredSql(viewer.id)}`,
        // Solo dove può ancora rispondere: membro, nella WHERE (review della fetta 2).
        channelMemberSql(viewer.id),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(200);
  const out: ChatQuestionItem[] = [];
  for (const { message: m } of rows) {
    out.push({
      id: `chat:${m.id}`,
      channelId: m.channelId,
      messageId: m.id,
      rootId: m.threadRootId ?? m.id,
      askedById: m.authorId,
      text: m.body,
      createdAt: m.createdAt.toISOString(),
    });
  }
  return out;
}

/** Ignora una domanda della Chat in «Da decidere» (solo una che è davvero sua e aperta). */
export async function dismissQuestion(db: Db, viewer: ChatViewer, messageId: string): Promise<void> {
  const open = await questionsOf(db, viewer);
  const question = open.find((q) => q.messageId === messageId);
  if (!question) throw notFound();
  await db.insert(chatDismissedQuestions).values({ userId: viewer.id, messageId }).onConflictDoNothing();
  await notifyChannel(db, question.channelId);
}

// --- Ricerca ---------------------------------------------------------------------

export interface ChatSearchFilters {
  channelId?: string;
  authorId?: string;
  peopleOnly?: boolean;
  withCitations?: boolean;
  from?: string;
  to?: string;
  limit?: number;
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Cerca nei messaggi dei canali che chi guarda LEGGE (mai un privato di cui
 * non è membro, nemmeno se lo gestisce, mai un DM altrui), archiviati
 * compresi; mai i messaggi eliminati. Ogni parola deve comparire, senza
 * maiuscole né accenti. Da 2 caratteri in su; dal più recente. Con ogni
 * risultato, il messaggio vivo prima (contesto) e, per una risposta, la radice.
 */
export async function searchChat(
  db: Db,
  viewer: ChatViewer,
  q: string,
  filters: ChatSearchFilters,
): Promise<{ channelId: string; message: ChatMessageView; context: ChatMessageView | null; root: ChatMessageView | null }[]> {
  const terms = foldChatText(q).split(/\s+/).filter(Boolean);
  if (q.trim().length < CHAT_SEARCH_MIN || terms.length === 0) return [];
  const rows = await db
    .select({ message: chatMessages })
    .from(chatMessages)
    .innerJoin(chatChannels, eq(chatChannels.id, chatMessages.channelId))
    .where(
      and(
        await channelReadableSql(db, viewer),
        isNull(chatMessages.deletedAt),
        ...terms.map((t) => sql`${chatMessages.searchFolded} like ${`%${likeEscape(t)}%`}`),
        filters.channelId ? eq(chatMessages.channelId, filters.channelId) : undefined,
        filters.authorId ? eq(chatMessages.authorId, filters.authorId) : undefined,
        filters.peopleOnly ? ne(chatMessages.kind, "system") : undefined,
        filters.withCitations ? await hasVisibleCitationSql(db, viewer, chatMessages.id) : undefined,
        filters.from ? sql`(${chatMessages.createdAt} at time zone 'UTC')::date >= ${filters.from}::date` : undefined,
        filters.to ? sql`(${chatMessages.createdAt} at time zone 'UTC')::date <= ${filters.to}::date` : undefined,
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(Math.min(Math.max(filters.limit ?? 50, 1), 200));
  const messages = rows.map((r) => r.message);
  if (messages.length === 0) return [];
  // Il contesto di OGNI risultato in una query (il messaggio vivo prima, nello
  // stesso flusso: il canale per una radice o una risposta «anche nel canale»,
  // il thread per una risposta), le radici in un'altra, e una vista sola.
  const contextRows = await db.execute<{ hit_id: string; context_id: string }>(sql`
    select h.id as hit_id, c.id as context_id
    from chat_messages h
    cross join lateral (
      select p.id from chat_messages p
      where p.channel_id = h.channel_id
        and p.deleted_at is null
        and p.created_at < h.created_at
        and (case
          when h.thread_root_id is null or h.also_in_channel then (p.thread_root_id is null or p.also_in_channel)
          else (p.thread_root_id = h.thread_root_id or p.id = h.thread_root_id)
        end)
      order by p.created_at desc, p.id desc
      limit 1
    ) c
    where h.id in (${sql.join(messages.map((m) => sql`${m.id}::uuid`), sql`, `)})
  `);
  const contextOf = new Map([...contextRows].map((r) => [r.hit_id, r.context_id]));
  const extraIds = [...new Set([...contextOf.values(), ...messages.flatMap((m) => (m.threadRootId ? [m.threadRootId] : []))])];
  const extra = extraIds.length > 0 ? await db.select().from(chatMessages).where(inArray(chatMessages.id, extraIds)) : [];
  const byRow = new Map([...messages, ...extra].map((m) => [m.id, m]));
  const views = await messageViews(db, viewer, [...byRow.values()]);
  const byId = new Map(views.map((v) => [v.id, v]));
  return messages.map((m) => {
    const contextId = contextOf.get(m.id);
    return {
      channelId: m.channelId,
      message: byId.get(m.id)!,
      context: contextId ? (byId.get(contextId) ?? null) : null,
      root: m.threadRootId ? (byId.get(m.threadRootId) ?? null) : null,
    };
  });
}

// --- Dal messaggio a Stubwise («Create task», «Create request») -----------------

/**
 * Il messaggio da cui nasce una task o una richiesta: chi la crea lo deve
 * LEGGERE, e non dev'essere eliminato (`createTaskFromMessage` del prototipo).
 * `false` risponde come un messaggio che non c'è.
 */
export async function messageLinkable(db: Db, viewer: ChatViewer, messageId: string): Promise<boolean> {
  try {
    const { message } = await readableMessage(db, viewer, messageId);
    return message.deletedAt === null;
  } catch (error) {
    if (error instanceof ChatError) return false;
    throw error;
  }
}

/**
 * Lega al messaggio ciò che ne è nato («→ AUD-14»), nella transazione di chi
 * lo crea; il messaggio avanza (`updated_at`) così lo stream lo rimanda. Lo
 * stesso oggetto una volta sola.
 */
export async function linkMessage(
  tx: Pick<Db, "insert" | "update" | "execute">,
  input: { messageId: string; ticketId?: string; backlogItemId?: string; createdBy: string | null },
): Promise<void> {
  await tx
    .insert(chatMessageLinks)
    .values({
      messageId: input.messageId,
      ticketId: input.ticketId ?? null,
      backlogItemId: input.backlogItemId ?? null,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .update(chatMessages)
    .set({ updatedAt: sql`now()` })
    .where(eq(chatMessages.id, input.messageId))
    .returning({ channelId: chatMessages.channelId });
  if (row) await tx.execute(sql`select pg_notify(${CHAT_CHANNEL_NOTIFY}, ${JSON.stringify({ channelId: row.channelId })})`);
}

export { channelView as viewChannel };
export type { ChannelRow };

/**
 * La card `chat.mention` o `chat.question` DERIVATA a lettura: per ogni
 * notifica, il messaggio come lo vede chi legge — canale, thread, chi scrive,
 * un estratto — o `null` se il messaggio è stato eliminato o chi legge non ne
 * legge più il canale (la card allora è `objectGone`, senza link). Nel jsonb
 * solo gli id. UNA lettura dell'utente, e una per i messaggi della pagina.
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
    if (!channels.has(m.channelId)) {
      const seen = await visibleChannel(db, viewer, m.channelId);
      channels.set(m.channelId, seen && (await channelAccess(db, viewer, seen)).canRead ? seen : null);
    }
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
