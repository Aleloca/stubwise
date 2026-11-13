import { ApiError } from "@stubwise/api-client";
import { DRIVE_FILE_TYPES } from "@stubwise/shared";
import type * as Fake from "../../api";
import type {
  DriveFileRow,
  DriveFileType,
  FolderLinkView,
  GoogleFileChoice,
  GoogleFolderChoice,
  GoogleOutsideFile,
  GoogleOutsideHit,
} from "../../types";
import { appClient, session } from "./client";
import { googleRowOf } from "./drive";

// Google Drive nel Drive dei progetti nella build app (area 6, F5b; il
// rimando dell'area 5, D9 = `drive.readonly`), sopra i metodi di
// `client.drive` di 72 (le liste in `{ items }`). I selettori leggono il MIO
// Drive, col mio account; le cartelle collegate le legge l'account di chi le
// ha collegate (B3; Q3 = a: le collega chi ha `drive.manage`); «scaduta» e
// «accesso perso» li deriva il server (B4).

type Drive = typeof Fake.drive;

/**
 * Una cartella collegata come la dice il server (le scelte di 72 per la F5b):
 * «scaduta» e «accesso perso» li DERIVA lui a lettura (B4), l'ultima
 * sincronizzazione è di QB1 = b. Un server di prima non li manda: i default
 * non dicono mai «scaduta» per sbaglio.
 */
export function folderLinkOf(raw: unknown): FolderLinkView {
  const l = raw as Partial<FolderLinkView> & { status?: string };
  const view: FolderLinkView = {
    id: l.id ?? "",
    projectId: l.projectId ?? "",
    name: l.name ?? "",
    googleFolderId: l.googleFolderId ?? "",
    linkedById: l.linkedById ?? "",
    linkedAt: l.linkedAt ?? "",
    status: l.status === "expired" ? "expired" : "ok",
    expiredAt: l.expiredAt ?? null,
    lastSyncedAt: l.lastSyncedAt ?? null,
    fileCount: l.fileCount ?? 0,
    accessLost: l.accessLost === true,
  };
  return { ...view, syncing: stillSyncing(view) };
}

/**
 * Review F5b (4): collegare e «Sync now» li fa il worker, dopo. Si ricorda
 * quando è stata chiesta la sincronizzazione di ogni cartella (per client), e
 * la cartella è «in sincronizzazione» finché il server non dice un
 * `lastSyncedAt` più nuovo; oltre il tetto si smette di aspettare.
 */
export const SYNC_WAIT_MS = 120_000;
const syncRequests = new WeakMap<object, Map<string, number>>();
function requestsOf(): Map<string, number> {
  const client = appClient();
  let map = syncRequests.get(client);
  if (!map) syncRequests.set(client, (map = new Map()));
  return map;
}
function stillSyncing(l: FolderLinkView): boolean {
  const map = requestsOf();
  const at = map.get(l.id);
  if (at === undefined) return false;
  const done = l.lastSyncedAt !== null && Date.parse(l.lastSyncedAt) >= at;
  if (done || Date.now() - at > SYNC_WAIT_MS || l.status === "expired") {
    map.delete(l.id);
    return false;
  }
  return true;
}
const requestSync = (linkId: string) => requestsOf().set(linkId, Date.now());

/** I rifiuti del server nelle parole del prototipo. */
const ERRORS: Readonly<Record<string, string>> = {
  already_in_project: "already_in_project",
  use_hide: "invalid: use_hide",
  forbidden: "forbidden",
  google_scope_missing: "google_scope_missing",
  account_disabled: "google_not_connected",
  token_expired: "google_not_connected",
  google_not_connected: "google_not_connected",
  already_linked: "already_linked",
  link_expired: "link_expired",
  unavailable: "invalid: unavailable",
  google_unavailable: "google_unavailable",
};
function driveError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.code && ERRORS[error.code]) return new Error(ERRORS[error.code]);
  if (error.status === 403) return new Error("forbidden");
  if (error.status === 404) return new Error("not_found");
  return error;
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw driveError(error);
  }
}

/** Una lettura che un server di prima non ha (404): vuota, non un errore. */
async function itemsOrEmpty<T>(read: () => Promise<{ items: T[] }>): Promise<T[]> {
  try {
    return (await read()).items;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw driveError(error);
  }
}

const query = (q: string) => q.trim() || undefined;
/** Un tipo che questa app non conosce (lettore: `UNKNOWN`) si mostra come «altro». */
const typeOf = (t: string): DriveFileType =>
  (DRIVE_FILE_TYPES as readonly string[]).includes(t) ? (t as DriveFileType) : "other";

/** «Aggiungi da Google Drive»: un elenco piatto con la ricerca (R-H3), dal mio Drive. */
const listGoogleFiles: Drive["listGoogleFiles"] = async (projectId, q) =>
  (await itemsOrEmpty(() => appClient().drive.googleFiles(projectId, query(q)))).map(
    (f): GoogleFileChoice => ({
      googleFileId: f.googleFileId,
      name: f.name,
      type: typeOf(f.type),
      owner: f.owner ?? "",
      modifiedAt: f.modifiedAt ?? "",
      alreadyInProject: f.alreadyInProject,
    }),
  );

/** La ricerca nel mio Google Drive fuori dai progetti: solo il mio account. */
const listGoogleOutside: Drive["listGoogleOutside"] = async (q) =>
  (await itemsOrEmpty(() => appClient().drive.googleOutside(query(q)))).map(
    (f): GoogleOutsideFile => ({
      googleFileId: f.googleFileId,
      name: f.name,
      type: typeOf(f.type),
      // Il mio Drive, letto col mio account: lo vedo io. Il testo non c'è (non è in un progetto).
      visibleToPersonIds: session.personId ? [session.personId] : [],
      text: "",
      summary: "",
    }),
  );

/**
 * I risultati della ricerca del Drive fuori dai progetti (F5b, review 3): i
 * file del MIO Google Drive in nessun progetto che vedo. Il testo non c'è (non
 * sono in un progetto): nessun passaggio, nessun riassunto.
 */
export async function googleOutsideHits(q: string): Promise<GoogleOutsideHit[]> {
  return (await itemsOrEmpty(() => appClient().drive.googleOutside(query(q)))).map((f) => ({
    googleFileId: f.googleFileId,
    name: f.name,
    type: typeOf(f.type),
    owner: f.owner ?? "",
    modifiedAt: f.modifiedAt ?? "",
    summary: "",
    passage: null,
  }));
}

/** Le cartelle del mio Drive che si possono collegare al progetto. */
const listGoogleFolders: Drive["listGoogleFolders"] = async (projectId) =>
  (await itemsOrEmpty(() => appClient().drive.googleFolders(projectId))).map(
    (f): GoogleFolderChoice => ({
      googleFolderId: f.googleFolderId,
      name: f.name,
      // Google non li dà senza una chiamata per cartella (72, F5b): vuoti.
      path: [...f.path],
      fileCount: f.fileCount ?? null,
      alreadyLinked: f.alreadyLinked,
    }),
  );

/** Le cartelle che ho collegato io, in tutti i progetti (il cassetto, scollegando l'account). */
const listMyFolderLinks: Drive["listMyFolderLinks"] = async () =>
  (await itemsOrEmpty(() => appClient().drive.myFolderLinks())).map(folderLinkOf);

/** Le cartelle collegate al progetto. */
const listFolderLinks: Drive["listFolderLinks"] = async (projectId) =>
  (await itemsOrEmpty(() => appClient().drive.folderLinks(projectId))).map(folderLinkOf);

const addGoogleFile: Drive["addGoogleFile"] = async (projectId, googleFileId) =>
  call(async () => googleRowOf(await appClient().drive.addGoogleFile(projectId, googleFileId)));

const linkFolder: Drive["linkFolder"] = async (projectId, googleFolderId) =>
  call(async () => {
    const raw = await appClient().drive.linkFolder(projectId, googleFolderId);
    requestSync(raw.id);
    return folderLinkOf(raw);
  });

const syncFolder: Drive["syncFolder"] = async (linkId) =>
  call(async () => {
    requestSync(linkId);
    return folderLinkOf(await appClient().drive.syncFolder(linkId));
  });

const unlinkFolder: Drive["unlinkFolder"] = async (linkId) =>
  call(() => appClient().drive.unlinkFolder(linkId));

/** «Togli» un riferimento (chi l'ha aggiunto o `drive.manage`); uno di una cartella si nasconde (409 `use_hide`). */
const removeGoogleFile: Drive["removeGoogleFile"] = async (id) =>
  call(() => appClient().drive.remove(id));

/** «Nascondi» / «Mostra» un file di una cartella collegata (`drive.manage`). */
const setHidden: Drive["setHidden"] = async (id, hidden): Promise<DriveFileRow> =>
  call(async () => googleRowOf(await appClient().drive.setHidden(id, hidden)));

export const driveGoogleFunctions: Partial<Drive> = {
  listGoogleFiles,
  listGoogleOutside,
  listGoogleFolders,
  listFolderLinks,
  listMyFolderLinks,
  addGoogleFile,
  linkFolder,
  syncFolder,
  unlinkFolder,
  removeGoogleFile,
  setHidden,
};
