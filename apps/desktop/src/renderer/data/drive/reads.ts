import { copy, gate, now, state } from "../store";
import type {
  DriveFile,
  DriveFileDetail,
  DriveFilePermissions,
  DriveFileRow,
  DriveFilters,
  FolderLinkView,
  GoogleAccount,
  GoogleFileChoice,
  GoogleFolderChoice,
  GoogleOutsideFile,
} from "../types";
import { can, viewerFor } from "../viewer";
import { opens90d, searchableText, summaryLineOf } from "./content";
import {
  canSeeDriveFile,
  canSeeDriveProject,
  driveFileFor,
  googleFileVisible,
  googleFolderVisible,
  isGoogleConnected,
} from "./visibility";
import { startSeedWork } from "./work";

// Le letture del Drive (area 5). Chi vede che cosa lo decide `visibility.ts`.
// Nessuna lettura conta un'apertura: le conta solo `recordOpen` (anteprima,
// «Apri in Google Drive», download), che la superficie chiama apposta. Un
// risultato, un riassunto, il dettaglio e le letture di Claude non contano.

/** Cosa può fare chi guarda su un file che vede. */
export function drivePermissions(me: string, file: DriveFile): DriveFilePermissions {
  const manage = can(viewerFor(me), "drive.manage", file.projectId);
  const mine = file.addedById === me;
  return {
    delete: file.source === "upload" && (mine || manage),
    remove:
      file.source === "google" &&
      (mine || manage) &&
      (file.folderLinkId === null || file.unavailable !== null),
    hide: manage && file.folderLinkId !== null,
    retry: manage && file.content === "error",
  };
}

const opensOfFile = (fileId: string) => state.driveOpens.filter((o) => o.fileId === fileId);

export function driveRow(me: string, file: DriveFile): DriveFileRow {
  // La riga non porta il testo estratto: lo leggono solo ricerca e Claude.
  const rest: Omit<DriveFile, "text"> & { text?: string } = copy(file);
  delete rest.text;
  const link = state.folderLinks.find((l) => l.id === file.folderLinkId);
  const opens = opensOfFile(file.id);
  const hidden = file.hidden ? state.driveHidden.get(file.id) : undefined;
  return {
    ...rest,
    projectCode: state.projectsById.get(file.projectId)!.code,
    opens90d: opens90d(file, now(), opens),
    lastOpenedAt: opens.reduce<string | null>((m, o) => (m === null || o.at > m ? o.at : m), null),
    summaryLine: summaryLineOf(file.summary),
    folder: link ? { id: link.id, name: link.name, status: link.status } : null,
    hiddenBy: hidden ? { ...hidden } : null,
    permissions: drivePermissions(me, file),
  };
}

const byName = (a: DriveFileRow, b: DriveFileRow) =>
  a.name.localeCompare(b.name) || a.code.localeCompare(b.code, undefined, { numeric: true });

/** «Recenti»: l'ultima apertura o modifica. */
const lastActivity = (r: DriveFileRow) =>
  r.lastOpenedAt && r.lastOpenedAt > r.modifiedAt ? r.lastOpenedAt : r.modifiedAt;

const SORTS: Record<DriveFilters["sort"], (a: DriveFileRow, b: DriveFileRow) => number> = {
  most_used: (a, b) =>
    b.opens90d - a.opens90d || lastActivity(b).localeCompare(lastActivity(a)) || byName(a, b),
  recent: (a, b) => lastActivity(b).localeCompare(lastActivity(a)) || byName(a, b),
  name: byName,
};

/**
 * Il Drive: di un progetto o (senza `projectId`) di tutti i progetti che
 * chi guarda vede. `hidden: true` = solo i nascosti, e solo dei progetti in
 * cui chi guarda ha `drive.manage`; altrimenti i nascosti non ci sono.
 */
export async function listDriveFiles(filters: DriveFilters): Promise<DriveFileRow[]> {
  const me = await gate("drive.listDriveFiles");
  startSeedWork();
  const hidden = filters.hidden === true;
  return state.driveFiles
    .filter(
      (f) =>
        f.hidden === hidden &&
        canSeeDriveFile(me, f, { includeHidden: hidden }) &&
        (filters.projectId === undefined || f.projectId === filters.projectId) &&
        (filters.type === undefined || f.type === filters.type) &&
        (filters.source === undefined || f.source === filters.source) &&
        (filters.addedById === undefined || f.addedById === filters.addedById),
    )
    .map((f) => driveRow(me, f))
    .sort(SORTS[filters.sort]);
}

/**
 * Il dettaglio di un file, per id o per codice (`?file=AUD-F7`): il totale
 * da sempre e lo storico (più recenti in alto) solo con `drive.history`,
 * altrimenti `null`. Non conta un'apertura. Per codice vale la stessa regola
 * dell'id: un file che chi guarda non vede non ha codice (R-G5).
 */
export async function getDriveFile(ref: string): Promise<DriveFileDetail | null> {
  const me = await gate("drive.getDriveFile");
  startSeedWork();
  const id = state.driveFiles.find((f) => f.code === ref)?.id ?? ref;
  const file = driveFileFor(me, id);
  if (!file) return null;
  const opens = opensOfFile(file.id);
  return {
    ...driveRow(me, file),
    opensTotal: opens.length,
    history: can(viewerFor(me), "drive.history", file.projectId)
      ? [...opens].reverse().map(copy)
      : null,
  };
}

/** Le cartelle collegate a un progetto, coi file (non nascosti) che portano. */
export async function listFolderLinks(projectId: string): Promise<FolderLinkView[]> {
  const me = await gate("drive.listFolderLinks");
  if (!canSeeDriveProject(me, projectId)) return [];
  return state.folderLinks
    .filter((l) => l.projectId === projectId)
    .map((l) => ({
      ...copy(l),
      fileCount: state.driveFiles.filter((f) => f.folderLinkId === l.id && !f.hidden).length,
    }));
}

/**
 * Le cartelle collegate da chi guarda, nei progetti che vede: quelle che
 * smettono di aggiornarsi se scollega il suo account Google.
 */
export async function listMyFolderLinks(): Promise<FolderLinkView[]> {
  const me = await gate("drive.listMyFolderLinks");
  return state.folderLinks
    .filter((l) => l.linkedById === me && canSeeDriveProject(me, l.projectId))
    .map((l) => ({
      ...copy(l),
      fileCount: state.driveFiles.filter((f) => f.folderLinkId === l.id && !f.hidden).length,
    }));
}

/** L'account Google personale di chi guarda (collegato o scaduto), o `null`. */
export async function getGoogleAccount(): Promise<GoogleAccount | null> {
  const me = await gate("drive.getGoogleAccount");
  const account = state.googleAccounts.find((a) => a.personId === me);
  return account ? copy(account) : null;
}

/**
 * Il file Google ha già un riferimento: in un progetto dato o, senza, in
 * uno che chi guarda vede (R-G5: un progetto invisibile non deve togliere un
 * file da «fuori dai progetti», o direbbe che esiste).
 */
const referenced = (me: string, googleFileId: string, projectId?: string) =>
  state.driveFiles.some(
    (f) =>
      f.googleFileId === googleFileId &&
      (projectId === undefined ? canSeeDriveFile(me, f) : f.projectId === projectId),
  );

/**
 * I file Google in nessun progetto che chi guarda vede su Google, per nome o
 * contenuto: solo con l'account collegato (scaduto o assente → vuoto).
 */
export async function listGoogleOutside(q: string): Promise<GoogleOutsideFile[]> {
  const me = await gate("drive.listGoogleOutside");
  if (!isGoogleConnected(me)) return [];
  const needle = q.trim().toLowerCase();
  return state.googleOutside
    .filter(
      (f) =>
        f.visibleToPersonIds.includes(me) &&
        !referenced(me, f.googleFileId) &&
        (!needle || [f.name, f.text].some((s) => s.toLowerCase().includes(needle))),
    )
    .map(copy);
}

/**
 * Il selettore di «Collega una cartella»: le cartelle che l'account di chi
 * guarda vede, con quelle già collegate al progetto segnate. Senza account
 * collegato, o senza il progetto, vuoto.
 */
export async function listGoogleFolders(projectId: string): Promise<GoogleFolderChoice[]> {
  const me = await gate("drive.listGoogleFolders");
  if (!canSeeDriveProject(me, projectId) || !isGoogleConnected(me)) return [];
  return state.googleFolders
    .filter((f) => googleFolderVisible(me, f))
    .map((f) => ({
      googleFolderId: f.googleFolderId,
      name: f.name,
      path: [...f.path],
      fileCount: state.googleFiles.filter(
        (g) => g.googleFolderId === f.googleFolderId && !g.deleted,
      ).length,
      alreadyLinked: state.folderLinks.some(
        (l) => l.projectId === projectId && l.googleFolderId === f.googleFolderId,
      ),
    }));
}

/**
 * Il selettore di «Aggiungi da Google Drive»: i file che l'account di chi
 * guarda vede, per nome, con quelli già nel progetto segnati.
 */
export async function listGoogleFiles(projectId: string, q: string): Promise<GoogleFileChoice[]> {
  const me = await gate("drive.listGoogleFiles");
  if (!canSeeDriveProject(me, projectId) || !isGoogleConnected(me)) return [];
  const needle = q.trim().toLowerCase();
  return state.googleFiles
    .filter((f) => googleFileVisible(me, f) && (!needle || f.name.toLowerCase().includes(needle)))
    .map((f) => ({
      googleFileId: f.googleFileId,
      name: f.name,
      type: f.type,
      owner: f.owner,
      modifiedAt: f.modifiedAt,
      alreadyInProject: referenced(me, f.googleFileId, projectId),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- Claude ------------------------------------------------------------------

/**
 * I file del Drive che Claude può leggere per chi chiede: visibili, non
 * nascosti, disponibili e pronti. Sincrono e senza `gate()`: lo chiamano le
 * risposte di Claude, che hanno già fatto il loro. **Non conta aperture**:
 * Claude legge da qui, mai da `recordOpen`.
 */
export function driveFilesForClaude(me: string): DriveFile[] {
  return state.driveFiles
    .filter((f) => canSeeDriveFile(me, f) && searchableText(f) !== "")
    .map(copy);
}

/** Un file per Claude (vedi `driveFilesForClaude`), o `null`: nascosto e inesistente identici. */
export function readDriveFileForClaude(me: string, id: string): DriveFile | null {
  const file = state.driveFiles.find((f) => f.id === id);
  return file && canSeeDriveFile(me, file) && searchableText(file) !== "" ? copy(file) : null;
}
