import { driveContentJobs, driveFileChunks, driveFiles, driveFolderLinks, googleAccounts, insertDriveReference, type Db } from "@stubwise/db";
import { GOOGLE_EXPORT_MIME, listFolderFiles, refreshAccessToken, type DriveListedFile } from "@stubwise/google";
import { loadGoogleAccountCredentials } from "@stubwise/google/credentials";
import { driveContentKindOf, driveFileTypeOf } from "@stubwise/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIVE_READONLY_SCOPE } from "./google-source.js";

/**
 * LA SINCRONIZZAZIONE DELLE CARTELLE GOOGLE COLLEGATE (area 6, F5b, B5; QB1 =
 * b, decisione del maintainer): al collegamento e a «Sincronizza ora» (una
 * richiesta, `sync_requested_at`) e una volta al giorno da sola, SEMPRE con
 * la casella di chi ha collegato la cartella. Sono letture: nessuna scrittura
 * verso Google.
 *
 * - Un LEASE per cartella (`lease_until`, preso con `FOR UPDATE SKIP LOCKED`):
 *   due giri non sincronizzano la stessa cartella insieme.
 * - Una cartella SCADUTA (la casella non c'è, è disattivata o senza
 *   `drive.readonly`) non si legge: si salta, e la richiesta resta per quando
 *   la casella torna.
 * - I tetti: al più {@link FOLDER_SYNC_MAX_LINKS} cartelle per giro e
 *   {@link FOLDER_SYNC_MAX_FILES} file per cartella; le estrazioni le fa il
 *   job del contenuto al suo passo (un file nuovo nasce col suo job).
 * - Il prototipo (`data/drive/writes.ts`, `syncFolder`): un file nuovo entra
 *   (aggiunto da chi ha collegato); uno cambiato su Google torna in
 *   elaborazione; uno sparito diventa `deleted` (e perde il contenuto); i
 *   nascosti restano nascosti; un file già nel progetto aggiunto a mano resta
 *   com'è. Una lista TAGLIATA dal tetto non fa sparire niente.
 */

export const FOLDER_SYNC_MAX_LINKS = 5;
export const FOLDER_SYNC_MAX_FILES = 500;
export const FOLDER_SYNC_EVERY_MS = 24 * 3600_000;
export const FOLDER_SYNC_LEASE_MS = 10 * 60_000;

export interface FolderSyncClient {
  refreshAccessToken: typeof refreshAccessToken;
  listFolderFiles: typeof listFolderFiles;
}
export const realFolderSyncClient: FolderSyncClient = { refreshAccessToken, listFolderFiles };

export interface FolderSyncDeps {
  db: Db;
  encryptionKey: Buffer;
  client?: FolderSyncClient;
  now?: () => Date;
  log?: (m: string) => void;
  maxLinks?: number;
  maxFiles?: number;
}

type Link = typeof driveFolderLinks.$inferSelect;

/** Prende (col lease) le cartelle da sincronizzare: chieste, mai sincronizzate, o vecchie di un giorno. */
async function claimLinks(deps: FolderSyncDeps, now: Date): Promise<Link[]> {
  const lease = new Date(now.getTime() + FOLDER_SYNC_LEASE_MS);
  const dueBefore = new Date(now.getTime() - FOLDER_SYNC_EVERY_MS);
  return deps.db.transaction(async (tx) => {
    const due = await tx
      .select({ id: driveFolderLinks.id })
      .from(driveFolderLinks)
      .where(
        sql`(${driveFolderLinks.syncRequestedAt} is not null or ${driveFolderLinks.syncedAt} is null or ${driveFolderLinks.syncedAt} < ${dueBefore.toISOString()}::timestamptz)
          and (${driveFolderLinks.leaseUntil} is null or ${driveFolderLinks.leaseUntil} < ${now.toISOString()}::timestamptz)`,
      )
      .orderBy(sql`${driveFolderLinks.syncRequestedAt} asc nulls last`, sql`${driveFolderLinks.syncedAt} asc nulls first`)
      .limit(deps.maxLinks ?? FOLDER_SYNC_MAX_LINKS)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx.update(driveFolderLinks).set({ leaseUntil: lease }).where(inArray(driveFolderLinks.id, due.map((d) => d.id))).returning();
  });
}

/** Una cartella, con la casella di chi l'ha collegata. Ritorna i file nuovi, cambiati e spariti. */
async function syncOne(deps: FolderSyncDeps, link: Link, now: Date): Promise<{ added: number; changed: number; deleted: number } | "expired"> {
  const client = deps.client ?? realFolderSyncClient;
  if (!link.accountId) return "expired";
  const [account] = await deps.db.select({ disabledAt: googleAccounts.disabledAt, scopes: googleAccounts.scopes }).from(googleAccounts).where(eq(googleAccounts.id, link.accountId));
  if (!account || account.disabledAt || !account.scopes.includes(DRIVE_READONLY_SCOPE)) return "expired";
  const credentials = await loadGoogleAccountCredentials(deps.db, deps.encryptionKey, link.accountId);
  if (!credentials) return "expired";
  const tokens = await client.refreshAccessToken({ clientId: credentials.clientId, clientSecret: credentials.clientSecret, refreshToken: credentials.refreshToken });
  const max = deps.maxFiles ?? FOLDER_SYNC_MAX_FILES;
  // Uno in più del tetto: dice se la lista è stata tagliata (allora niente sparisce).
  const listed = await client.listFolderFiles({ accessToken: tokens.accessToken, folderId: link.googleFolderId, max: max + 1 });
  const complete = listed.length <= max;
  const seen = listed.slice(0, max);

  const existing = await deps.db
    .select({ id: driveFiles.id, googleFileId: driveFiles.googleFileId, folderLinkId: driveFiles.folderLinkId, modifiedAt: driveFiles.modifiedAt, unavailable: driveFiles.unavailable, mime: driveFiles.mime })
    .from(driveFiles)
    .where(and(eq(driveFiles.projectId, link.projectId), eq(driveFiles.source, "google"), isNull(driveFiles.deletedAt)));
  const byGoogleId = new Map(existing.map((f) => [f.googleFileId!, f]));
  let added = 0;
  let changed = 0;
  for (const file of seen) {
    const ref = byGoogleId.get(file.id);
    if (!ref) {
      await insertDriveReference(deps.db, {
        projectId: link.projectId,
        addedBy: link.linkedBy,
        googleAccountId: link.accountId,
        folderLinkId: link.id,
        file,
        type: driveFileTypeOf(file.mimeType),
        extractable: extractable(file),
      });
      added += 1;
      continue;
    }
    // Aggiunto a mano, o da un'altra cartella: resta com'è.
    if (ref.folderLinkId !== link.id) continue;
    const moved = file.modifiedAt !== null && (ref.modifiedAt === null || file.modifiedAt.getTime() !== ref.modifiedAt.getTime());
    if (!moved && ref.unavailable === null) continue;
    await deps.db.transaction(async (tx) => {
      await tx
        .update(driveFiles)
        .set({ name: file.name, modifiedAt: file.modifiedAt, unavailable: null, ...(extractable(file) ? { contentStatus: "pending" as const, contentReason: null } : {}) })
        .where(eq(driveFiles.id, ref.id));
      if (extractable(file)) await tx.insert(driveContentJobs).values({ fileId: ref.id }).onConflictDoNothing();
    });
    changed += 1;
  }

  let deleted = 0;
  if (complete) {
    const live = new Set(seen.map((f) => f.id));
    const gone = existing.filter((f) => f.folderLinkId === link.id && f.unavailable === null && !live.has(f.googleFileId!)).map((f) => f.id);
    if (gone.length > 0) {
      // Sparito da Google: non disponibile, e il suo testo se ne va (B2).
      await deps.db.transaction(async (tx) => {
        await tx.update(driveFiles).set({ unavailable: "deleted", contentText: null, summary: null }).where(inArray(driveFiles.id, gone));
        await tx.delete(driveFileChunks).where(inArray(driveFileChunks.fileId, gone));
      });
      deleted = gone.length;
    }
  }
  await deps.db.update(driveFolderLinks).set({ syncedAt: now, syncRequestedAt: null, leaseUntil: null, syncError: null }).where(eq(driveFolderLinks.id, link.id));
  return { added, changed, deleted };
}

function extractable(file: DriveListedFile): boolean {
  return driveContentKindOf(GOOGLE_EXPORT_MIME[file.mimeType] ?? file.mimeType) !== null;
}

/** Un giro: le cartelle dovute, una alla volta. Non lancia; ritorna quante ne ha sincronizzate. */
export async function syncDueFolderLinks(deps: FolderSyncDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? (() => {});
  const links = await claimLinks(deps, now);
  let synced = 0;
  for (const link of links) {
    try {
      const out = await syncOne(deps, link, now);
      if (out === "expired") {
        // Scaduta: non si legge; la richiesta resta per quando la casella torna.
        await deps.db.update(driveFolderLinks).set({ leaseUntil: null, syncError: "expired" }).where(eq(driveFolderLinks.id, link.id));
        continue;
      }
      synced += 1;
      log(`[drive] cartella ${link.id}: ${out.added} nuovi, ${out.changed} cambiati, ${out.deleted} spariti`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[drive] cartella ${link.id} non sincronizzata: ${message}`);
      await deps.db.update(driveFolderLinks).set({ leaseUntil: null, syncError: message.slice(0, 500) }).where(eq(driveFolderLinks.id, link.id));
    }
  }
  return synced;
}

/** Il poller: un giro ogni `intervalSeconds`, mai due insieme nello stesso processo (il lease copre più worker). */
export function startFolderSyncPoller(opts: FolderSyncDeps & { intervalSeconds: number; signal: AbortSignal }): () => void {
  if (opts.intervalSeconds <= 0) return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running || opts.signal.aborted) return;
    running = true;
    void syncDueFolderLinks(opts)
      .catch((err: unknown) => opts.log?.(`[drive] giro delle cartelle non riuscito: ${String(err)}`))
      .finally(() => {
        running = false;
      });
  }, opts.intervalSeconds * 1000);
  const stop = () => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
