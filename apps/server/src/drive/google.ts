import { driveFiles, driveFolderLinks, googleAccounts, insertDriveReference, tombstoneDriveFiles, type Db } from "@stubwise/db";
import { DRIVE_FOLDER_MIME, getDriveFile as getGoogleFile, GOOGLE_EXPORT_MIME, GoogleApiError, listDriveFiles as listGoogleFiles, listDriveFolders, missingGoogleScopes, refreshAccessToken, type DriveListedFile } from "@stubwise/google";
import { loadGoogleAccountCredentials } from "@stubwise/google/credentials";
import { driveContentKindOf, driveFileTypeOf, googleOpenUrl, type DriveFileRow, type DriveFolderLink, type GoogleFileChoice, type GoogleFolderChoice } from "@stubwise/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { projectPermissionsFor, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { DRIVE_READONLY_SCOPE, DriveError, driveRowOf, drivePermsLookup, openDriveFile, visibleDriveFile } from "./service.js";

/**
 * GOOGLE DRIVE NEL DRIVE DEI PROGETTI (area 6, F5b; la specifica è il
 * prototipo, `apps/desktop/src/renderer/data/drive/`). Un RIFERIMENTO non è
 * una copia: il file resta su Google, «Apri» va su Google (i permessi li
 * applica Google a chi apre), e Stubwise ne tiene il testo come per un
 * caricato, letto SOLO con la casella di chi l'ha aggiunto o di chi ha
 * collegato la sua cartella (B3).
 *
 * - Aggiungere un file: `drive.upload`, dal PROPRIO Drive (il picker legge col
 *   token di chi guarda, mai d'altri); una volta per progetto
 *   (`already_in_project`); lo stesso file in un altro progetto è un
 *   riferimento nuovo, con un codice nuovo.
 * - Collegare, scollegare, sincronizzare una cartella, nascondere: `drive.manage`.
 * - «Togli» un riferimento: chi l'ha aggiunto, o `drive.manage`; un file di
 *   cartella disponibile non si toglie, si nasconde (`use_hide`).
 * - «Scaduta»/«accesso perso» si DERIVANO (B4): la casella di chi ha
 *   collegato la cartella non c'è più, è disattivata o senza `drive.readonly`.
 * - La sincronizzazione la fa il WORKER (`apps/worker/src/drive/folder-sync.ts`):
 *   qui la si chiede soltanto (`sync_requested_at`).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

export interface DriveGoogleClient {
  refreshAccessToken: typeof refreshAccessToken;
  listDriveFiles: typeof listGoogleFiles;
  listDriveFolders: typeof listDriveFolders;
  getDriveFile: typeof getGoogleFile;
}
export const realDriveGoogleClient: DriveGoogleClient = { refreshAccessToken, listDriveFiles: listGoogleFiles, listDriveFolders, getDriveFile: getGoogleFile };

export interface DriveGoogleDeps {
  db: Db;
  encryptionKey: Buffer;
  client: DriveGoogleClient;
}

/** Un errore di Google, o della casella, nelle parole che il client mappa. */
export class DriveGoogleError extends DriveError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly missing?: string[],
  ) {
    super(status, code, message);
  }
}

const notFound = () => new DriveError(404, "not_found", "Not found");

/** Una violazione dell'indice unico (Drizzle la avvolge: il codice di Postgres sta su `cause`). */
function uniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

async function sees(db: Db, viewer: Viewer, projectId: string): Promise<boolean> {
  const visible = await visibleProjectIds(db, viewer);
  return visible === "all" || visible.includes(projectId);
}

async function need(db: Db, viewer: Viewer, projectId: string, permission: "drive.upload" | "drive.manage"): Promise<void> {
  if (!(await sees(db, viewer, projectId))) throw notFound();
  const perms = await projectPermissionsFor(db, viewer, projectId);
  if (!perms?.has(permission)) throw new DriveError(403, "forbidden", `You need ${permission} in this project`);
}

/** La casella Google di chi guarda con cui si legge il Drive: la prima viva con `drive.readonly`. */
async function myAccount(db: Db, viewer: Viewer): Promise<{ id: string }> {
  const accounts = await db
    .select({ id: googleAccounts.id, scopes: googleAccounts.scopes, disabledAt: googleAccounts.disabledAt })
    .from(googleAccounts)
    .where(eq(googleAccounts.userId, viewer.id))
    .orderBy(asc(googleAccounts.email));
  const live = accounts.filter((a) => !a.disabledAt);
  const ok = live.find((a) => a.scopes.includes(DRIVE_READONLY_SCOPE));
  if (ok) return { id: ok.id };
  if (live.length > 0) throw new DriveGoogleError(409, "google_scope_missing", "Reconnect Google to read your Drive", missingGoogleScopes(live[0]!.scopes));
  throw new DriveGoogleError(409, "google_not_connected", "Connect Google to use your Drive");
}

async function tokenOf(deps: DriveGoogleDeps, accountId: string): Promise<string> {
  const credentials = await loadGoogleAccountCredentials(deps.db, deps.encryptionKey, accountId);
  if (!credentials) throw new DriveGoogleError(409, "token_expired", "Reconnect Google");
  const tokens = await deps.client.refreshAccessToken({ clientId: credentials.clientId, clientSecret: credentials.clientSecret, refreshToken: credentials.refreshToken });
  return tokens.accessToken;
}

/** Un errore di Google: 404 come `not_found` (Drive lo dà anche per un file non condiviso), gli altri tipizzati. */
function fromGoogle(err: unknown): never {
  if (err instanceof GoogleApiError) {
    if (err.code === "file_not_found") throw notFound();
    if (err.code === "insufficient_scope") throw new DriveGoogleError(409, "google_scope_missing", "Reconnect Google to read your Drive", [DRIVE_READONLY_SCOPE]);
    if (err.code === "invalid_grant" || err.status === 401) throw new DriveGoogleError(409, "token_expired", "Reconnect Google");
    throw new DriveGoogleError(502, "google_unavailable", "Could not reach Google");
  }
  throw err;
}

async function withGoogle<T>(deps: DriveGoogleDeps, viewer: Viewer, fn: (accessToken: string, accountId: string) => Promise<T>): Promise<T> {
  const account = await myAccount(deps.db, viewer);
  try {
    return await fn(await tokenOf(deps, account.id), account.id);
  } catch (err) {
    if (err instanceof DriveError) throw err;
    return fromGoogle(err);
  }
}

const choiceOf = (f: DriveListedFile, alreadyInProject: boolean): GoogleFileChoice => ({
  googleFileId: f.id,
  name: f.name,
  type: driveFileTypeOf(f.mimeType),
  mime: f.mimeType,
  owner: f.owner,
  modifiedAt: f.modifiedAt?.toISOString() ?? null,
  alreadyInProject,
});

/** I file Google già nel progetto (vivi). */
async function inProject(db: Db, projectId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: driveFiles.googleFileId })
    .from(driveFiles)
    .where(and(eq(driveFiles.projectId, projectId), eq(driveFiles.source, "google"), isNull(driveFiles.deletedAt), inArray(driveFiles.googleFileId, ids)));
  return new Set(rows.map((r) => r.id!));
}

/** Il picker «Aggiungi da Google Drive»: il MIO Drive (`drive.upload` nel progetto). */
export async function listGoogleChoices(deps: DriveGoogleDeps, viewer: Viewer, projectId: string, q: string | undefined): Promise<GoogleFileChoice[]> {
  await need(deps.db, viewer, projectId, "drive.upload");
  const page = await withGoogle(deps, viewer, (accessToken) => deps.client.listDriveFiles({ accessToken, ...(q ? { query: q } : {}), pageSize: 50 }));
  const taken = await inProject(deps.db, projectId, page.files.map((f) => f.id));
  return page.files.map((f) => choiceOf(f, taken.has(f.id)));
}

/** La ricerca FUORI dai progetti: i file del MIO Drive che non sono in nessun progetto che vedo. */
export async function listGoogleOutside(deps: DriveGoogleDeps, viewer: Viewer, q: string | undefined): Promise<GoogleFileChoice[]> {
  const page = await withGoogle(deps, viewer, (accessToken) => deps.client.listDriveFiles({ accessToken, ...(q ? { query: q } : {}), pageSize: 50 }));
  const ids = page.files.map((f) => f.id);
  if (ids.length === 0) return [];
  const visible = await visibleProjectIds(deps.db, viewer);
  const rows = await deps.db
    .select({ id: driveFiles.googleFileId })
    .from(driveFiles)
    .where(and(eq(driveFiles.source, "google"), isNull(driveFiles.deletedAt), inArray(driveFiles.googleFileId, ids), ...(visible === "all" ? [] : [inArray(driveFiles.projectId, visible.length > 0 ? visible : ["00000000-0000-0000-0000-000000000000"])])));
  const anywhere = new Set(rows.map((r) => r.id!));
  return page.files.filter((f) => !anywhere.has(f.id)).map((f) => choiceOf(f, false));
}

/** «Aggiungi da Google Drive» (`drive.upload`): un file del MIO Drive, una volta per progetto. */
export async function addGoogleFile(deps: DriveGoogleDeps, viewer: Viewer, projectId: string, googleFileId: string): Promise<DriveFileRow> {
  await need(deps.db, viewer, projectId, "drive.upload");
  const { meta, accountId } = await withGoogle(deps, viewer, async (accessToken, id) => ({ meta: await deps.client.getDriveFile({ accessToken, fileId: googleFileId }), accountId: id }));
  if (meta.trashed || meta.mimeType === DRIVE_FOLDER_MIME) throw notFound();
  if ((await inProject(deps.db, projectId, [meta.id])).size > 0) throw new DriveError(409, "already_in_project", "This file is already in the project");
  let id: string;
  try {
    id = await insertDriveReference(deps.db, {
      projectId,
      addedBy: viewer.id,
      googleAccountId: accountId,
      folderLinkId: null,
      file: { id: meta.id, name: meta.name, mimeType: meta.mimeType, sizeBytes: null, owner: meta.owners[0] ?? null, modifiedAt: null },
      type: driveFileTypeOf(meta.mimeType),
      extractable: driveContentKindOf(GOOGLE_EXPORT_MIME[meta.mimeType] ?? meta.mimeType) !== null,
    });
  } catch (err) {
    // Due aggiunte insieme: l'indice unico vivo decide (`already_in_project`).
    if (uniqueViolation(err)) throw new DriveError(409, "already_in_project", "This file is already in the project");
    throw err;
  }
  const r = (await visibleDriveFile(deps.db, viewer, id))!;
  return driveRowOf(r, viewer, await drivePermsLookup(deps.db, viewer));
}

/** Le cartelle del MIO Drive («Collega una cartella», `drive.manage`). */
export async function listGoogleFolderChoices(deps: DriveGoogleDeps, viewer: Viewer, projectId: string, q: string | undefined): Promise<GoogleFolderChoice[]> {
  await need(deps.db, viewer, projectId, "drive.manage");
  const page = await withGoogle(deps, viewer, (accessToken) => deps.client.listDriveFolders({ accessToken, ...(q ? { query: q } : {}) }));
  const linked = new Set(
    (await deps.db.select({ id: driveFolderLinks.googleFolderId }).from(driveFolderLinks).where(eq(driveFolderLinks.projectId, projectId))).map((r) => r.id),
  );
  return page.files.map((f) => ({ googleFolderId: f.id, name: f.name, path: [], fileCount: null, alreadyLinked: linked.has(f.id) }));
}

/** Le viste delle cartelle collegate, con «scaduta» e «accesso perso» DERIVATI (B4). */
async function folderViews(db: Db, where: ReturnType<typeof and>): Promise<DriveFolderLink[]> {
  const rows = await db
    .select({
      link: driveFolderLinks,
      accountId: googleAccounts.id,
      disabledAt: googleAccounts.disabledAt,
      scopes: googleAccounts.scopes,
      fileCount: sql<number>`(select count(*)::int from ${driveFiles} f where f.folder_link_id = ${driveFolderLinks.id} and f.deleted_at is null and not f.hidden)`,
    })
    .from(driveFolderLinks)
    .leftJoin(googleAccounts, eq(googleAccounts.id, driveFolderLinks.accountId))
    .where(where)
    .orderBy(asc(driveFolderLinks.name));
  return rows.map((r) => {
    const expired = r.accountId === null || r.disabledAt !== null || !(r.scopes ?? []).includes(DRIVE_READONLY_SCOPE);
    return {
      id: r.link.id,
      projectId: r.link.projectId,
      name: r.link.name,
      googleFolderId: r.link.googleFolderId,
      linkedById: r.link.linkedBy,
      linkedAt: r.link.linkedAt.toISOString(),
      status: expired ? ("expired" as const) : ("ok" as const),
      expiredAt: expired && r.disabledAt ? r.disabledAt.toISOString() : null,
      lastSyncedAt: r.link.syncedAt?.toISOString() ?? null,
      fileCount: r.fileCount,
      accessLost: expired && r.fileCount > 0,
    };
  });
}

/** Le cartelle collegate a un progetto (chi vede il progetto). */
export async function listProjectFolderLinks(db: Db, viewer: Viewer, projectId: string): Promise<DriveFolderLink[]> {
  if (!(await sees(db, viewer, projectId))) throw notFound();
  return folderViews(db, and(eq(driveFolderLinks.projectId, projectId)));
}

/** Le cartelle collegate da CHI GUARDA, nei progetti che vede: quelle che smettono di aggiornarsi se scollega Google. */
export async function listMyFolderLinks(db: Db, viewer: Viewer): Promise<DriveFolderLink[]> {
  const visible = await visibleProjectIds(db, viewer);
  if (visible !== "all" && visible.length === 0) return [];
  return folderViews(db, and(eq(driveFolderLinks.linkedBy, viewer.id), ...(visible === "all" ? [] : [inArray(driveFolderLinks.projectId, visible)])));
}

async function linkFor(db: Db, viewer: Viewer, linkId: string) {
  const [link] = await db.select().from(driveFolderLinks).where(eq(driveFolderLinks.id, linkId));
  if (!link || !(await sees(db, viewer, link.projectId))) throw notFound();
  return link;
}

/** «Collega una cartella» (`drive.manage`): la sincronizzazione la fa il worker, al prossimo giro. */
export async function linkGoogleFolder(deps: DriveGoogleDeps, viewer: Viewer, projectId: string, googleFolderId: string): Promise<DriveFolderLink> {
  await need(deps.db, viewer, projectId, "drive.manage");
  const { meta, accountId } = await withGoogle(deps, viewer, async (accessToken, id) => ({ meta: await deps.client.getDriveFile({ accessToken, fileId: googleFolderId }), accountId: id }));
  if (meta.trashed || meta.mimeType !== DRIVE_FOLDER_MIME) throw notFound();
  let id: string;
  try {
    const [row] = await deps.db
      .insert(driveFolderLinks)
      .values({ projectId, googleFolderId: meta.id, name: meta.name, linkedBy: viewer.id, accountId, syncRequestedAt: new Date() })
      .returning({ id: driveFolderLinks.id });
    id = row!.id;
  } catch (err) {
    if (uniqueViolation(err)) throw new DriveError(409, "already_linked", "This folder is already linked to the project");
    throw err;
  }
  return (await folderViews(deps.db, and(eq(driveFolderLinks.id, id))))[0]!;
}

/** «Scollega» (`drive.manage`): i suoi file se ne vanno dal progetto (su Google non cambia nulla). */
export async function unlinkGoogleFolder(db: Db, viewer: Viewer, linkId: string): Promise<void> {
  const link = await linkFor(db, viewer, linkId);
  const perms = await projectPermissionsFor(db, viewer, link.projectId);
  if (!perms?.has("drive.manage")) throw new DriveError(403, "forbidden", "You need drive.manage in this project");
  const files = await db.select({ id: driveFiles.id }).from(driveFiles).where(and(eq(driveFiles.folderLinkId, link.id), isNull(driveFiles.deletedAt)));
  await tombstoneDriveFiles(db, files.map((f) => f.id), viewer.id);
  await db.delete(driveFolderLinks).where(eq(driveFolderLinks.id, link.id));
}

/** «Sincronizza ora» (`drive.manage`): una richiesta al worker; una cartella scaduta non si sincronizza. */
export async function requestFolderSync(db: Db, viewer: Viewer, linkId: string): Promise<DriveFolderLink> {
  const link = await linkFor(db, viewer, linkId);
  const perms = await projectPermissionsFor(db, viewer, link.projectId);
  if (!perms?.has("drive.manage")) throw new DriveError(403, "forbidden", "You need drive.manage in this project");
  const [view] = await folderViews(db, and(eq(driveFolderLinks.id, link.id)));
  if (view!.status === "expired") throw new DriveError(409, "link_expired", "The account that linked this folder can't read it anymore");
  await db.update(driveFolderLinks).set({ syncRequestedAt: new Date() }).where(eq(driveFolderLinks.id, link.id));
  return view!;
}

/** «Togli» un riferimento (chi l'ha aggiunto o `drive.manage`); un file di cartella disponibile si nasconde (`use_hide`). */
export async function removeGoogleFile(db: Db, viewer: Viewer, id: string): Promise<void> {
  const r = await visibleDriveFile(db, viewer, id);
  if (!r) throw notFound();
  if (r.file.source !== "google") throw new DriveError(400, "not_a_google_file", "Only a Google reference can be removed");
  const row = driveRowOf(r, viewer, await drivePermsLookup(db, viewer));
  const mine = r.file.addedBy === viewer.id;
  const manage = (await projectPermissionsFor(db, viewer, r.file.projectId))?.has("drive.manage") === true;
  if (!mine && !manage) throw new DriveError(403, "forbidden", "Only who added it, or who manages the Drive");
  if (r.file.folderLinkId !== null && row.unavailable === null) throw new DriveError(409, "use_hide", "A file of a linked folder is hidden, not removed");
  await tombstoneDriveFiles(db, [r.file.id], viewer.id);
}

/** Nasconde (o rimostra) un file di cartella (`drive.manage`): la sincronizzazione non lo rimette. */
export async function setDriveFileHidden(db: Db, viewer: Viewer, id: string, hidden: boolean): Promise<DriveFileRow> {
  const r = await visibleDriveFile(db, viewer, id);
  if (!r) throw notFound();
  const perms = await projectPermissionsFor(db, viewer, r.file.projectId);
  if (!perms?.has("drive.manage")) throw new DriveError(403, "forbidden", "You need drive.manage in this project");
  if (r.file.folderLinkId === null) throw new DriveError(400, "not_a_folder_file", "Only a file of a linked folder can be hidden");
  await db.update(driveFiles).set(hidden ? { hidden: true, hiddenBy: viewer.id, hiddenAt: new Date() } : { hidden: false, hiddenBy: null, hiddenAt: null }).where(eq(driveFiles.id, r.file.id));
  const again = (await visibleDriveFile(db, viewer, id))!;
  return driveRowOf(again, viewer, await drivePermsLookup(db, viewer));
}

/** «Apri in Google Drive»: conta un'apertura (`via: google`) e dice dove andare. */
export async function openGoogleFile(db: Db, viewer: Viewer, id: string): Promise<string | null> {
  const file = await openDriveFile(db, viewer, id, "google");
  if (!file?.googleFileId) return null;
  return googleOpenUrl(file.mime, file.googleFileId);
}
