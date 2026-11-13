import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import type {
  DriveFileRow,
  FolderLinkView,
  GoogleFileChoice,
  GoogleFolderChoice,
  GoogleOutsideFile,
} from "../../types";
import { appClient } from "./client";
import { googleRowOf } from "./drive";

// Google Drive nel Drive dei progetti nella build app (area 6, F5; il rimando
// dell'area 5, D9 = `drive.readonly`). Le rotte sono quelle della BOZZA del
// piano (`docs/plans/2026-11-12-integrazione-area6-fetta5-plan.md`) più due
// letture che servono al prototipo (le cartelle da collegare e quelle
// collegate): finché 72 non le fissa e non mette i metodi, `request`.
// I selettori leggono il MIO Drive, col mio account; le cartelle collegate le
// legge l'account di chi le ha collegate (Q3 = a: le collega chi ha
// `drive.manage`). `google` resta spento nella build app finché il server non
// c'è.

type Drive = typeof Fake.drive;

const projectPath = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/drive/google`;
const filePath = (id: string) => `/api/drive/files/${encodeURIComponent(id)}`;
const folderPath = (id: string) => `/api/drive/google/folders/${encodeURIComponent(id)}`;

/** I rifiuti del server nelle parole del prototipo. */
const ERRORS: Readonly<Record<string, string>> = {
  already_in_project: "already_in_project",
  use_hide: "invalid: use_hide",
  forbidden: "forbidden",
  google_scope_missing: "google_scope_missing",
  account_disabled: "google_not_connected",
  token_expired: "google_not_connected",
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
async function listOrEmpty<T>(path: string): Promise<T[]> {
  try {
    return ((await appClient().request("GET", path)) as T[] | null) ?? [];
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw driveError(error);
  }
}

/** «Aggiungi da Google Drive»: un elenco piatto con la ricerca (R-H3), dal mio Drive. */
const listGoogleFiles: Drive["listGoogleFiles"] = async (projectId, q) => {
  const query = new URLSearchParams({ q: q.trim() });
  return listOrEmpty<GoogleFileChoice>(`${projectPath(projectId)}/files?${query.toString()}`);
};

/** La ricerca nel mio Google Drive fuori dai progetti: solo il mio account. */
const listGoogleOutside: Drive["listGoogleOutside"] = async (q) => {
  const query = new URLSearchParams({ q: q.trim() });
  return listOrEmpty<GoogleOutsideFile>(`/api/drive/google/outside?${query.toString()}`);
};

/** Le cartelle del mio Drive che si possono collegare al progetto. */
const listGoogleFolders: Drive["listGoogleFolders"] = async (projectId) =>
  listOrEmpty<GoogleFolderChoice>(`${projectPath(projectId)}/folders`);

/** Le cartelle che ho collegato io, in tutti i progetti (il cassetto, scollegando l'account). */
const listMyFolderLinks: Drive["listMyFolderLinks"] = async () =>
  listOrEmpty<FolderLinkView>("/api/drive/google/links");

/** Le cartelle collegate al progetto. */
const listFolderLinks: Drive["listFolderLinks"] = async (projectId) =>
  listOrEmpty<FolderLinkView>(`${projectPath(projectId)}/links`);

const addGoogleFile: Drive["addGoogleFile"] = async (projectId, googleFileId) =>
  call(async () =>
    googleRowOf(
      await appClient().request("POST", `${projectPath(projectId)}/files`, { googleFileId }),
    ),
  );

const linkFolder: Drive["linkFolder"] = async (projectId, googleFolderId) =>
  call(
    async () =>
      (await appClient().request("POST", `${projectPath(projectId)}/folders`, {
        googleFolderId,
      })) as FolderLinkView,
  );

const syncFolder: Drive["syncFolder"] = async (linkId) =>
  call(
    async () => (await appClient().request("POST", `${folderPath(linkId)}/sync`)) as FolderLinkView,
  );

const unlinkFolder: Drive["unlinkFolder"] = async (linkId) =>
  call(async () => {
    await appClient().request("DELETE", folderPath(linkId));
  });

/** «Togli» un riferimento (chi l'ha aggiunto o `drive.manage`); uno di una cartella si nasconde. */
const removeGoogleFile: Drive["removeGoogleFile"] = async (id) =>
  call(async () => {
    await appClient().request("DELETE", filePath(id));
  });

/** «Nascondi» / «Mostra» un file di una cartella collegata (`drive.manage`). */
const setHidden: Drive["setHidden"] = async (id, hidden): Promise<DriveFileRow> =>
  call(async () =>
    googleRowOf(await appClient().request("PUT", `${filePath(id)}/hidden`, { hidden })),
  );

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
