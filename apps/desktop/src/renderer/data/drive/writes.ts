import { person as mailAddressOf } from "../seed/mail/helpers";
import { copy, gate, newId, now, state } from "../store";
import type {
  DriveFile,
  DriveFileRow,
  DriveOpen,
  DriveUploadInput,
  DriveUploadResult,
  FolderLink,
  FolderLinkView,
  GoogleAccount,
  GoogleDriveFile,
} from "../types";
import { can, viewerFor, type Permission } from "../viewer";
import { driveTypeOf, isOpenCounted, uniqueName, UPLOAD_LIMIT_BYTES } from "./content";
import { driveRow } from "./reads";
import {
  canSeeDriveProject,
  driveFileFor,
  folderLinkFor,
  googleAccountOf,
  googleFileVisible,
  googleFolderVisible,
  isGoogleConnected,
} from "./visibility";
import { advanceContent, googleFileById, reading, track } from "./work";

export { driveContentHistory, whenDriveIdle } from "./work";

// Le scritture del Drive (area 5). Come le altre: `gate()` prima di tutto,
// permesso verificato come sul server, ogni controllo prima di ogni
// scrittura (dopo un rifiuto lo stato è intatto). Un file, una cartella o un
// progetto che chi agisce non vede è `not_found` (R-G5); `forbidden` solo
// per ciò che vede senza il permesso.
//
// L'estrazione simulata del contenuto sta in `work.ts`.

const forbidden = () => new Error("forbidden");
const notFound = () => new Error("not_found");
const invalid = (what: string) => new Error(`invalid: ${what}`);

function need(me: string, perm: Permission, projectId: string): void {
  if (!can(viewerFor(me), perm, projectId)) throw forbidden();
}

function fileFor(me: string, id: string): DriveFile {
  const file = driveFileFor(me, id);
  if (!file) throw notFound();
  return file;
}

function projectFor(me: string, projectId: string): void {
  if (!state.projectsById.has(projectId) || !canSeeDriveProject(me, projectId)) throw notFound();
}

function linkFor(me: string, id: string): FolderLink {
  const link = folderLinkFor(me, id);
  if (!link) throw notFound();
  return link;
}

function needGoogle(me: string): void {
  if (!isGoogleConnected(me)) throw new Error("google_not_connected");
}

/** Il prossimo codice `<PRJ>-F<n>` del progetto: un codice non si riusa. */
function nextCode(projectId: string): string {
  const n = (state.driveCodeSeq.get(projectId) ?? 0) + 1;
  state.driveCodeSeq.set(projectId, n);
  return `${state.projectsById.get(projectId)!.code}-F${n}`;
}

/** Toglie dei file dal progetto, con le loro aperture e il ricordo di chi li ha nascosti. */
function dropFiles(ids: ReadonlySet<string>): void {
  state.driveFiles = state.driveFiles.filter((f) => !ids.has(f.id));
  state.driveOpens = state.driveOpens.filter((o) => !ids.has(o.fileId));
  for (const id of ids) state.driveHidden.delete(id);
}

// --- caricare, eliminare, togliere ---------------------------------------------

/**
 * Carica dei file nel Drive di un progetto (`drive.upload`). Ogni file ha il
 * suo esito: oltre 100 MB `too_large` (gli altri si caricano); un nome già
 * nel progetto prende «(2)», «(3)»… Il contenuto parte `processing`.
 */
export async function uploadFiles(
  projectId: string,
  files: DriveUploadInput[],
): Promise<DriveUploadResult[]> {
  const me = await gate("drive.uploadFiles");
  projectFor(me, projectId);
  need(me, "drive.upload", projectId);
  const taken = new Set(
    state.driveFiles.filter((f) => f.projectId === projectId).map((f) => f.name),
  );
  const added: DriveFile[] = [];
  const results = files.map((input): DriveUploadResult => {
    if (input.sizeBytes > UPLOAD_LIMIT_BYTES)
      return { name: input.name, file: null, error: "too_large" };
    const name = uniqueName(input.name, taken);
    taken.add(name);
    const at = now();
    const file: DriveFile = {
      id: newId("drv"),
      code: nextCode(projectId),
      projectId,
      source: "upload",
      name,
      type: driveTypeOf(input.name, input.mime),
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      addedById: me,
      addedAt: at,
      modifiedAt: at,
      folderLinkId: null,
      googleFileId: null,
      googleOwner: null,
      hidden: false,
      unavailable: null,
      content: "processing",
      text: "",
      summary: null,
      ocr: false,
    };
    state.driveFiles.push(file);
    reading(file);
    added.push(file);
    return { name: input.name, file: driveRow(me, file), error: null };
  });
  if (added.length > 0) track(advanceContent(added.map((f) => f.id)));
  return results;
}

/** Elimina un caricato: il proprio, o con `drive.manage`. Le sue aperture se ne vanno con lui. */
export async function deleteDriveFile(id: string): Promise<void> {
  const me = await gate("drive.deleteDriveFile");
  const file = fileFor(me, id);
  if (file.source !== "upload") throw invalid("not an uploaded file");
  if (file.addedById !== me) need(me, "drive.manage", file.projectId);
  dropFiles(new Set([file.id]));
}

/**
 * Toglie un riferimento Google dal progetto (su Google non cambia nulla):
 * chi l'ha aggiunto, o `drive.manage`. Un file di cartella disponibile non
 * si toglie, si nasconde (`use_hide`); non disponibile sì.
 */
export async function removeGoogleFile(id: string): Promise<void> {
  const me = await gate("drive.removeGoogleFile");
  const file = fileFor(me, id);
  if (file.source !== "google") throw invalid("not a Google file");
  if (file.addedById !== me) need(me, "drive.manage", file.projectId);
  if (file.folderLinkId !== null && file.unavailable === null) throw new Error("use_hide");
  dropFiles(new Set([file.id]));
}

/**
 * Nasconde (o rimostra) un file di cartella (`drive.manage`): resta nella
 * cartella, la sincronizzazione non lo rimette, e rimostrato torna col suo
 * codice e le sue aperture.
 */
export async function setHidden(id: string, hidden: boolean): Promise<DriveFileRow> {
  const me = await gate("drive.setHidden");
  const file = fileFor(me, id);
  need(me, "drive.manage", file.projectId);
  if (file.folderLinkId === null) throw invalid("not a folder file");
  file.hidden = hidden;
  if (hidden) state.driveHidden.set(file.id, { personId: me, at: now() });
  else state.driveHidden.delete(file.id);
  return driveRow(me, file);
}

/** «Riprova» l'estrazione di un contenuto in errore (`drive.manage`). */
export async function retryExtraction(id: string): Promise<DriveFileRow> {
  const me = await gate("drive.retryExtraction");
  const file = fileFor(me, id);
  need(me, "drive.manage", file.projectId);
  if (file.content !== "error") throw invalid("content not in error");
  reading(file);
  track(advanceContent([file.id]));
  return driveRow(me, file);
}

// --- aperture ----------------------------------------------------------------

/**
 * Un'apertura (anteprima di un caricato, «Apri in Google Drive», download):
 * la stessa persona sullo stesso riferimento entro 30 minuti conta una.
 * Solo la superficie la chiama, e solo per questi tre gesti: le letture
 * (elenchi, dettaglio, ricerca, Claude) non passano mai di qui.
 */
export async function recordOpen(
  fileId: string,
  via: DriveOpen["via"],
): Promise<{ counted: boolean }> {
  const me = await gate("drive.recordOpen");
  const file = fileFor(me, fileId);
  if (file.unavailable !== null) throw invalid("unavailable");
  const next: DriveOpen = { fileId: file.id, personId: me, at: now(), via };
  // L'ultima apertura contata della stessa persona sullo stesso riferimento (in ordine di tempo).
  const prev = state.driveOpens.filter((o) => o.fileId === file.id && o.personId === me).at(-1);
  const counted = isOpenCounted(prev, next);
  if (counted) state.driveOpens.push(next);
  return { counted };
}

// --- Google ------------------------------------------------------------------

/** Un riferimento nuovo a un file di Google, in elaborazione finché Stubwise non l'ha letto. */
function addReference(
  me: string,
  projectId: string,
  side: GoogleDriveFile,
  folderLinkId: string | null,
): DriveFile {
  const file: DriveFile = {
    id: newId("drv"),
    code: nextCode(projectId),
    projectId,
    source: "google",
    name: side.name,
    type: side.type,
    mime: side.mime,
    sizeBytes: side.sizeBytes,
    addedById: me,
    addedAt: now(),
    modifiedAt: side.modifiedAt,
    folderLinkId,
    googleFileId: side.googleFileId,
    googleOwner: side.owner,
    hidden: false,
    unavailable: null,
    content: "processing",
    text: "",
    summary: null,
    ocr: false,
  };
  state.driveFiles.push(file);
  reading(file);
  return file;
}

const inProject = (projectId: string, googleFileId: string) =>
  state.driveFiles.some((f) => f.projectId === projectId && f.googleFileId === googleFileId);

/**
 * «Aggiungi da Google Drive» (o «a quale progetto?»): un riferimento nuovo,
 * col suo codice, anche se lo stesso file è già in un altro progetto
 * (`drive.upload`, account collegato, file che l'account vede).
 */
export async function addGoogleFile(
  projectId: string,
  googleFileId: string,
): Promise<DriveFileRow> {
  const me = await gate("drive.addGoogleFile");
  projectFor(me, projectId);
  need(me, "drive.upload", projectId);
  needGoogle(me);
  const side = googleFileById(googleFileId);
  if (!side || !googleFileVisible(me, side)) throw notFound();
  if (inProject(projectId, googleFileId)) throw new Error("already_in_project");
  const file = addReference(me, projectId, side, null);
  track(advanceContent([file.id]));
  return driveRow(me, file);
}

const linkView = (link: FolderLink): FolderLinkView => ({
  ...copy(link),
  fileCount: state.driveFiles.filter((f) => f.folderLinkId === link.id && !f.hidden).length,
  accessLost: state.driveFiles.some(
    (f) => f.folderLinkId === link.id && f.unavailable === "access_lost",
  ),
});

/**
 * Collega una cartella Google al progetto (`drive.manage`, account
 * collegato, cartella che l'account vede, una volta per progetto): tutti i
 * suoi file entrano, aggiunti da chi collega, in elaborazione. I file già nel
 * progetto (aggiunti a mano) restano come sono.
 */
export async function linkFolder(
  projectId: string,
  googleFolderId: string,
): Promise<FolderLinkView> {
  const me = await gate("drive.linkFolder");
  projectFor(me, projectId);
  need(me, "drive.manage", projectId);
  needGoogle(me);
  const folder = state.googleFolders.find((f) => f.googleFolderId === googleFolderId);
  if (!folder || !googleFolderVisible(me, folder)) throw notFound();
  const linked = state.folderLinks.some(
    (l) => l.projectId === projectId && l.googleFolderId === googleFolderId,
  );
  if (linked) throw new Error("already_linked");
  const link: FolderLink = {
    id: newId("fl"),
    projectId,
    name: folder.name,
    googleFolderId,
    linkedById: me,
    linkedAt: now(),
    status: "ok",
    expiredAt: null,
  };
  state.folderLinks.push(link);
  const added = state.googleFiles
    .filter((g) => g.googleFolderId === googleFolderId && !g.deleted)
    .filter((g) => !inProject(projectId, g.googleFileId))
    .map((g) => addReference(me, projectId, g, link.id));
  if (added.length > 0) track(advanceContent(added.map((f) => f.id)));
  return linkView(link);
}

/**
 * Scollega una cartella (`drive.manage`): i suoi file escono dal progetto
 * con le loro aperture (ricollegarla li fa ripartire da zero, con codici
 * nuovi); i caricati e i Google aggiunti a mano restano. Su Google nulla.
 */
export async function unlinkFolder(linkId: string): Promise<void> {
  const me = await gate("drive.unlinkFolder");
  const link = linkFor(me, linkId);
  need(me, "drive.manage", link.projectId);
  dropFiles(new Set(state.driveFiles.filter((f) => f.folderLinkId === link.id).map((f) => f.id)));
  state.folderLinks = state.folderLinks.filter((l) => l.id !== link.id);
}

/**
 * «Sincronizza ora» (`drive.manage`): rilegge la cartella da Google. Un file
 * nuovo entra; uno cambiato su Google (o ancora da leggere) torna in
 * elaborazione, col riassunto in rielaborazione, poi pronto; uno cancellato
 * diventa non disponibile. I nascosti restano nascosti (il riferimento c'è
 * già: non si rimette). Una cartella scaduta non si sincronizza; una il cui
 * account (di chi l'ha collegata) non è più collegato diventa scaduta, senza
 * leggerla: Stubwise la legge solo con quell'account.
 */
export async function syncFolder(linkId: string): Promise<FolderLinkView> {
  const me = await gate("drive.syncFolder");
  const link = linkFor(me, linkId);
  need(me, "drive.manage", link.projectId);
  if (link.status === "expired") throw new Error("link_expired");
  if (!isGoogleConnected(link.linkedById)) {
    link.status = "expired";
    link.expiredAt = now();
    return linkView(link);
  }
  const touched: string[] = [];
  for (const side of state.googleFiles.filter((g) => g.googleFolderId === link.googleFolderId)) {
    const ref = state.driveFiles.find(
      (f) => f.projectId === link.projectId && f.googleFileId === side.googleFileId,
    );
    if (!ref) {
      if (!side.deleted)
        touched.push(addReference(link.linkedById, link.projectId, side, link.id).id);
      continue;
    }
    if (ref.folderLinkId !== link.id || ref.unavailable !== null) continue;
    if (side.deleted) {
      ref.unavailable = "deleted";
    } else if (side.modifiedAt > ref.modifiedAt || ref.content === "processing") {
      reading(ref);
      touched.push(ref.id);
    }
  }
  if (touched.length > 0) track(advanceContent(touched));
  return linkView(link);
}

// --- l'account Google personale: UN solo scrittore ---------------------------
//
// L'account Google di una persona è anche la sua casella (area 6: posta e
// calendario la leggono). Lo collegano e scollegano il Drive (area 5) e le
// Preferenze → Account (area 9a, `me/google.ts`) passando da queste due
// funzioni, così lo stato che Drive, Posta e Calendario leggono cambia
// insieme.

/**
 * Collega (o ricollega, se scaduto) l'account Google di `personId`, senza
 * cancello: lo chiamano le scritture che l'hanno già passato. Le cartelle
 * collegate da lei riprendono ad aggiornarsi; la sua casella e il suo
 * calendario ci sono («Proposals» com'era prima di scollegarla, accese per
 * una casella mai collegata) e, se
 * l'allineamento era fallito per l'accesso perso, torna `ok`.
 */
export function linkGoogleAccount(personId: string): GoogleAccount {
  let account = googleAccountOf(personId);
  if (!account) {
    account = {
      personId,
      email: mailAddressOf(personId).email,
      status: "connected",
      since: now(),
    };
    state.googleAccounts.push(account);
  }
  if (account.status !== "connected") account.since = now();
  account.status = "connected";
  const box = state.mailboxes.find((b) => b.personId === personId);
  if (!box)
    state.mailboxes.push({
      personId,
      email: account.email,
      // La scelta di prima dello scollegamento, se c'era: ricollegare non riaccende le proposte.
      proposalsEnabled: state.proposalsBeforeUnlink.get(personId) ?? true,
      syncedAt: now(),
      sync: "ok",
    });
  else if (box.sync === "failed") box.sync = "ok";
  // Lo stesso per il suo calendario.
  const cal = state.calendarSync.find((c) => c.personId === personId);
  if (!cal)
    state.calendarSync.push({ personId, email: account.email, syncedAt: now(), sync: "ok" });
  else if (cal.sync === "failed") cal.sync = "ok";
  for (const link of state.folderLinks.filter((l) => l.linkedById === personId)) {
    link.status = "ok";
    link.expiredAt = null;
    for (const file of state.driveFiles) {
      if (file.folderLinkId !== link.id || file.unavailable !== "access_lost") continue;
      if (!googleFileById(file.googleFileId)?.deleted) file.unavailable = null;
    }
  }
  return account;
}

/**
 * Scollega l'account Google di `personId`, senza cancello: le cartelle
 * collegate da lei smettono di aggiornarsi e i loro file diventano non
 * disponibili (accesso perso); la sua casella e il suo calendario spariscono
 * da Posta e Calendario. La posta già arrivata, gli eventi e le proposte già
 * fatte restano.
 */
export function unlinkGoogleAccount(personId: string): void {
  state.googleAccounts = state.googleAccounts.filter((a) => a.personId !== personId);
  const box = state.mailboxes.find((b) => b.personId === personId);
  if (box) state.proposalsBeforeUnlink.set(personId, box.proposalsEnabled);
  state.mailboxes = state.mailboxes.filter((b) => b.personId !== personId);
  state.calendarSync = state.calendarSync.filter((c) => c.personId !== personId);
  for (const link of state.folderLinks.filter((l) => l.linkedById === personId)) {
    if (link.status !== "expired") link.expiredAt = now();
    link.status = "expired";
    for (const file of state.driveFiles) {
      if (file.folderLinkId === link.id && file.unavailable === null)
        file.unavailable = "access_lost";
    }
  }
}

/**
 * Collega (o ricollega, se scaduto) l'account Google personale, simulato. Le
 * cartelle collegate da me riprendono ad aggiornarsi, e i loro file non più
 * disponibili per l'accesso perso tornano disponibili.
 */
export async function connectGoogle(): Promise<GoogleAccount> {
  const me = await gate("drive.connectGoogle");
  return copy(linkGoogleAccount(me));
}

/**
 * Scollega l'account Google personale: le cartelle collegate da me smettono
 * di aggiornarsi e i loro file diventano non disponibili (accesso perso)
 * finché non le si ricollega.
 */
export async function disconnectGoogle(): Promise<void> {
  const me = await gate("drive.disconnectGoogle");
  if (!googleAccountOf(me)) return;
  unlinkGoogleAccount(me);
}
