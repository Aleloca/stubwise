import { chatChannelMembers, chatChannels, type Db } from "@stubwise/db";
import { projectViewerIds } from "@stubwise/notifications";
import type { ProjectPermission } from "@stubwise/shared";
import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { projectPermissionsFor, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/**
 * Chi VEDE, chi SCRIVE e chi GESTISCE un canale della Chat (area 4, fetta 1):
 * la regola di `data/chat/visibility.ts` del prototipo, in UN posto. Lista,
 * lettura, stream, menzioni e notifiche passano tutte da qui. Un canale che
 * non si vede è `null`, cioè 404, come uno che non esiste.
 *
 * Fetta 1: i soli canali di PROGETTO, aperti (il «general» e quelli creati).
 * - Si VEDE chi vede il progetto.
 * - Si SCRIVE da membro, in un canale non archiviato. Del «general» sono
 *   membri tutti quelli che vedono il progetto (derivato, mai copiato).
 * - Si GESTISCE (rinomina, archivia, elimina) con `chat.channels.manage` nel
 *   progetto. Il «general» non lo gestisce nessuno.
 */

export type ChatViewer = Pick<SessionUser, "id" | "instancePermissions">;
export type ChannelRow = typeof chatChannels.$inferSelect;
type DbLike = Pick<Db, "select">;

/** La WHERE dei canali che chi guarda vede (fetta 1: di progetto, nei progetti che vede). */
export async function channelVisibleSql(db: Db, viewer: ChatViewer): Promise<SQL> {
  const visible = await visibleProjectIds(db, viewer);
  const projectChannel = and(eq(chatChannels.kind, "project"), isNotNull(chatChannels.projectId))!;
  if (visible === "all") return projectChannel;
  if (visible.length === 0) return sql`false`;
  return and(projectChannel, inArray(chatChannels.projectId, visible))!;
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
  canWrite: boolean;
  canJoin: boolean;
  canLeave: boolean;
  canManage: boolean;
  permissions: ReadonlySet<ProjectPermission>;
}

/** Ciò che chi guarda può fare in un canale che VEDE (la sola fonte di `canWrite`, `canManage`…). */
export async function channelAccess(db: DbLike, viewer: ChatViewer, channel: ChannelRow): Promise<ChannelAccess> {
  const permissions = channel.projectId
    ? ((await projectPermissionsFor(db, viewer, channel.projectId)) ?? new Set<ProjectPermission>())
    : new Set<ProjectPermission>();
  let isMember = channel.isGeneral;
  if (!isMember) {
    const [m] = await db
      .select({ userId: chatChannelMembers.userId })
      .from(chatChannelMembers)
      .where(and(eq(chatChannelMembers.channelId, channel.id), eq(chatChannelMembers.userId, viewer.id)));
    isMember = m !== undefined;
  }
  const archived = channel.archivedAt !== null;
  return {
    isMember,
    canWrite: isMember && !archived,
    canJoin: !isMember && !channel.isGeneral && !archived,
    canLeave: isMember && !channel.isGeneral,
    canManage: !channel.isGeneral && permissions.has("chat.channels.manage"),
    permissions,
  };
}

/**
 * Chi LEGGE il canale: le persone a cui una menzione può arrivare (un canale
 * di progetto aperto lo legge chi vede il progetto). Claude escluso dal
 * chiamante (non è una persona da avvisare).
 */
export async function channelReaderIds(db: Db, channel: ChannelRow): Promise<string[]> {
  return channel.projectId ? projectViewerIds(db, channel.projectId) : [];
}

/** I membri da mostrare: nel «general» quelli del progetto, altrove le righe dei membri. */
export async function channelMemberIds(db: Db, channel: ChannelRow): Promise<string[]> {
  if (channel.isGeneral) return channelReaderIds(db, channel);
  const rows = await db
    .select({ userId: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .where(eq(chatChannelMembers.channelId, channel.id));
  return rows.map((r) => r.userId);
}
