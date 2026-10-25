import { state, visibleProjectIds } from "../store";
import type { DriveFile, FolderLink, GoogleAccount, GoogleDriveFile, GoogleFolder } from "../types";
import { can, viewerFor } from "../viewer";

// Chi vede che cosa nel Drive (area 5): UNA regola, per ogni lettura e ogni
// scrittura. Vedere il Drive di un progetto = esserne membro (o full admin);
// un file nascosto esiste solo per chi gestisce il Drive di quel progetto, e
// solo dove lo si chiede apposta (il filtro «Nascosti», il dettaglio, le
// azioni su di lui). Un file che chi guarda non vede risponde come uno che
// non esiste (R-G5): `null`, elenchi vuoti, `not_found` — mai `forbidden`.
//
// Eccezione accettata (fix round 1): sulle strade che partono da Google un
// file di cartella nascosto CONTA anche per chi non gestisce — «Già in AUD»
// nel selettore (`listGoogleFiles`), `already_in_project` di `addGoogleFile`
// e i nomi occupati per il «(2)» di un caricamento. Non è un oracolo: chi è
// membro del progetto sa già che la cartella collegata contiene quel file
// (la vede su Google, o la vede collegata), e nasconderlo non lo toglie da
// lì. Non vale fuori dal progetto: `listGoogleOutside` conta solo i
// riferimenti che chi guarda vede.

/** Chi guarda vede il Drive del progetto: ne è membro (o full admin). */
export const canSeeDriveProject = (me: string, projectId: string): boolean =>
  visibleProjectIds(me).has(projectId);

/**
 * Chi guarda vede il file. Un nascosto lo vede solo chi ha `drive.manage` nel
 * progetto, e solo con `includeHidden` (filtro «Nascosti», dettaglio,
 * azioni); elenchi, ricerca, «#», codici e Claude lo lasciano fuori.
 */
export function canSeeDriveFile(
  me: string,
  file: DriveFile,
  { includeHidden = false }: { includeHidden?: boolean } = {},
): boolean {
  if (!canSeeDriveProject(me, file.projectId)) return false;
  if (!file.hidden) return true;
  return includeHidden && can(viewerFor(me), "drive.manage", file.projectId);
}

/** Un file per id, se chi guarda lo vede (nascosti compresi per chi gestisce). */
export function driveFileFor(me: string, id: string): DriveFile | undefined {
  const file = state.driveFiles.find((f) => f.id === id);
  return file && canSeeDriveFile(me, file, { includeHidden: true }) ? file : undefined;
}

/** Una cartella collegata, se chi guarda vede il suo progetto. */
export function folderLinkFor(me: string, id: string): FolderLink | undefined {
  const link = state.folderLinks.find((l) => l.id === id);
  return link && canSeeDriveProject(me, link.projectId) ? link : undefined;
}

/** L'account Google di una persona (collegato o scaduto), o nessuno. */
export const googleAccountOf = (personId: string): GoogleAccount | undefined =>
  state.googleAccounts.find((a) => a.personId === personId);

/** Solo un account collegato legge Google: uno scaduto no. */
export const isGoogleConnected = (personId: string): boolean =>
  googleAccountOf(personId)?.status === "connected";

/** Una cartella che l'account Google della persona vede (lato Google, simulato). */
export const googleFolderVisible = (personId: string, folder: GoogleFolder): boolean =>
  folder.visibleToPersonIds.includes(personId);

/** Un file che l'account Google della persona vede: direttamente o dalla sua cartella. */
export function googleFileVisible(personId: string, file: GoogleDriveFile): boolean {
  if (file.deleted) return false;
  if (file.visibleToPersonIds.includes(personId)) return true;
  const folder = state.googleFolders.find((f) => f.googleFolderId === file.googleFolderId);
  return !!folder && googleFolderVisible(personId, folder);
}
