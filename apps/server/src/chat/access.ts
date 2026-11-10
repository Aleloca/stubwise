import { chatChannelMembers, chatChannels, users, type Db } from "@stubwise/db";
import { projectViewerIds } from "@stubwise/notifications";
import type { ProjectPermission } from "@stubwise/shared";
import { and, eq, exists, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { projectIdsWithPermission, projectPermissionsFor, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/**
 * Chi VEDE, chi LEGGE e chi GESTISCE un canale della Chat (area 4): la regola
 * di `data/chat/visibility.ts` del prototipo, in UN posto. Lista, lettura,
 * stream, ricerca, menzioni, domande e card d'inbox passano tutte da qui. Un
 * canale che non si vede è `null`, cioè 404, come uno che non esiste.
 *
 * Vedere = sapere che esiste (nome e membri); leggere = i messaggi.
 * - Aperto di progetto: lo vede (e legge) chi vede il progetto.
 * - Aperto generale: tutti.
 * - Privato: i membri lo leggono; chi gestisce quell'ambito lo VEDE ma non
 *   lo legge (D2). Uno di progetto, solo se il progetto si vede ancora.
 * - DM: esiste solo per chi partecipa, nemmeno per il full admin (D2).
 * Del «general» di un progetto sono membri tutti quelli che vedono il
 * progetto (derivato, mai copiato).
 */

export type ChatViewer = Pick<SessionUser, "id" | "instancePermissions">;
export type ChannelRow = typeof chatChannels.$inferSelect;
type DbLike = Pick<Db, "select">;

/** Chi guarda è membro del canale (le righe dei membri; il «general» a parte). */
function memberSql(viewerId: string): SQL {
  return exists(
    sql`(select 1 from ${chatChannelMembers} where ${chatChannelMembers.channelId} = ${chatChannels.id} and ${chatChannelMembers.userId} = ${viewerId})`,
  );
}

function inProjects(ids: "all" | string[]): SQL {
  if (ids === "all") return isNotNull(chatChannels.projectId);
  if (ids.length === 0) return sql`false`;
  return inArray(chatChannels.projectId, ids);
}

/** La WHERE dei canali che chi guarda VEDE. */
export async function channelVisibleSql(db: Db, viewer: ChatViewer): Promise<SQL> {
  const visible = await visibleProjectIds(db, viewer);
  const managed = await projectIdsWithPermission(db, viewer, "chat.channels.manage");
  const member = memberSql(viewer.id);
  const managesGeneral = viewer.instancePermissions.has("chat.general.manage");
  return or(
    and(
      eq(chatChannels.kind, "project"),
      inProjects(visible),
      or(eq(chatChannels.visibility, "open"), member, inProjects(managed)),
    ),
    and(
      eq(chatChannels.kind, "general"),
      managesGeneral ? undefined : or(eq(chatChannels.visibility, "open"), member),
    ),
    and(eq(chatChannels.kind, "dm"), member),
  )!;
}

/**
 * La WHERE dei canali di cui chi guarda LEGGE i messaggi: quelli che vede,
 * tranne i privati di cui non è membro (chi gestisce no, D2). La usano la
 * ricerca, le menzioni, le domande e le card.
 */
export async function channelReadableSql(db: Db, viewer: ChatViewer): Promise<SQL> {
  return and(
    await channelVisibleSql(db, viewer),
    or(eq(chatChannels.visibility, "open"), eq(chatChannels.isGeneral, true), memberSql(viewer.id)),
  )!;
}

/** Il canale, se chi guarda lo vede; altrimenti null (404). */
export async function visibleChannel(db: Db, viewer: ChatViewer, id: string): Promise<ChannelRow | null> {
  const [row] = await db
    .select()
    .from(chatChannels)
    .where(and(eq(chatChannels.id, id), await channelVisibleSql(db, viewer)));
  return row ?? null;
}

export interface ChannelAccess {
  isMember: boolean;
  /** Legge i messaggi (un privato di cui non è membro no, nemmeno chi gestisce). */
  canRead: boolean;
  canWrite: boolean;
  canJoin: boolean;
  canLeave: boolean;
  canEditInfo: boolean;
  canEditTopic: boolean;
  canEditEvents: boolean;
  canInvite: boolean;
  canRemove: boolean;
  canArchive: boolean;
  canDelete: boolean;
  /** Almeno un'azione di gestione (il campo della fetta 1). */
  canManage: boolean;
  /** Gestisce i canali di quell'ambito (`chat.channels.manage` nel progetto, `chat.general.manage`). */
  managesScope: boolean;
  /** Il creatore o chi gestisce l'ambito; mai in un DM. */
  managesChannel: boolean;
  permissions: ReadonlySet<ProjectPermission>;
  memberCount: number;
}

/**
 * Ciò che chi guarda può fare in un canale che VEDE: `channelPermissions` del
 * prototipo, la sola fonte di `canWrite`, `canInvite`, `canDelete`…
 */
export async function channelAccess(db: DbLike, viewer: ChatViewer, channel: ChannelRow): Promise<ChannelAccess> {
  const permissions = channel.projectId
    ? ((await projectPermissionsFor(db, viewer, channel.projectId)) ?? new Set<ProjectPermission>())
    : new Set<ProjectPermission>();
  const dm = channel.kind === "dm";
  let isMember = channel.isGeneral;
  let memberCount = 0;
  if (!channel.isGeneral) {
    const rows = await db
      .select({ userId: chatChannelMembers.userId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, channel.id));
    memberCount = rows.length;
    isMember = rows.some((r) => r.userId === viewer.id);
  }
  const managesScope =
    !dm &&
    (channel.kind === "project"
      ? permissions.has("chat.channels.manage")
      : viewer.instancePermissions.has("chat.general.manage"));
  const managesChannel = !dm && (channel.createdBy === viewer.id || managesScope);
  const canRead = channel.visibility === "open" || channel.isGeneral || isMember;
  const live = channel.archivedAt === null;
  // Il «general» segue il progetto e un DM le sue persone: nessuno entra, esce, invita o toglie a mano.
  const fixedMembers = channel.isGeneral || dm;
  const canEditInfo = managesChannel && live && !channel.isGeneral;
  const canArchive = managesChannel && !channel.isGeneral;
  const canDelete = managesScope && !channel.isGeneral;
  return {
    isMember,
    canRead,
    canWrite: isMember && canRead && live,
    canJoin: !isMember && canRead && live && !fixedMembers && channel.visibility === "open",
    // Un DM a due non si lascia; un gruppo sì. Un privato non resta senza membri.
    canLeave:
      isMember &&
      !channel.isGeneral &&
      (dm ? memberCount > 2 : channel.visibility === "open" || memberCount > 1),
    canEditInfo,
    canEditTopic: isMember && live && !dm,
    canEditEvents: managesChannel && live && channel.kind === "project",
    canInvite: live && !fixedMembers && (channel.visibility === "private" ? managesChannel : isMember || managesChannel),
    canRemove: managesChannel && live && !fixedMembers,
    canArchive,
    canDelete,
    canManage: canEditInfo || canArchive || canDelete,
    managesScope,
    managesChannel,
    permissions,
    memberCount,
  };
}

/** Le persone dell'istanza (gli utenti che non sono un agente). */
async function humanIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.isAgent, false));
  return rows.map((r) => r.id);
}

/**
 * Chi LEGGE il canale: le persone a cui una menzione o una domanda può
 * arrivare. Un aperto di progetto lo legge chi vede il progetto; un aperto
 * generale tutti; un privato e un DM i loro membri (che, in un privato di
 * progetto, vedono ancora il progetto). Claude escluso dal chiamante.
 */
export async function channelReaderIds(db: Db, channel: ChannelRow): Promise<string[]> {
  if (channel.isGeneral || (channel.kind === "project" && channel.visibility === "open")) {
    return channel.projectId ? projectViewerIds(db, channel.projectId) : [];
  }
  if (channel.kind === "general" && channel.visibility === "open") return humanIds(db);
  const members = await channelMemberIds(db, channel);
  if (channel.kind !== "project" || !channel.projectId) return members;
  const viewers = new Set(await projectViewerIds(db, channel.projectId));
  return members.filter((id) => viewers.has(id));
}

/** I membri da mostrare: nel «general» quelli del progetto, altrove le righe dei membri. */
export async function channelMemberIds(db: Db, channel: ChannelRow): Promise<string[]> {
  if (channel.isGeneral) return channel.projectId ? projectViewerIds(db, channel.projectId) : [];
  const rows = await db
    .select({ userId: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .where(eq(chatChannelMembers.channelId, channel.id));
  return rows.map((r) => r.userId);
}

/**
 * Chi può entrare in un canale di quell'ambito: in un progetto chi lo vede,
 * altrove ogni persona (Claude mai: si chiama con «@Claude»).
 */
export async function allowedMemberIds(db: Db, projectId: string | null): Promise<Set<string>> {
  const humans = new Set(await humanIds(db));
  if (!projectId) return humans;
  return new Set((await projectViewerIds(db, projectId)).filter((id) => humans.has(id)));
}
