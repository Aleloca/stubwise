import { z } from "zod";
import { GoogleApiError } from "./errors.js";
import { buildUrl, errorFromResponse, fetchWithTimeout, parseGoogleJson, requestGoogle, type GoogleClientOptions } from "./fetch.js";

/**
 * GOOGLE DRIVE, IN SOLA LETTURA (area 6, F5): i metadati di un file e il testo
 * di un Google Doc. Lo scope è `drive.readonly` (D9 = a). Nessuna scrittura.
 *
 * Drive risponde 404 sia per un file che non esiste sia per uno che chi
 * chiede non può vedere (non condiviso): qui sono lo stesso `file_not_found`,
 * e il chiamante non distingue più di quanto Drive dica.
 *
 * ⚠️ Il contenuto di un file Google è NON FIDATO (l'ha scritto chiunque
 * abbia accesso al Doc): chi lo passa a un modello lo mette fra delimitatori,
 * come dati.
 */

export const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3/files";

const NOT_FOUND = { 404: "file_not_found" };

const fileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  trashed: z.boolean().optional(),
  createdTime: z.string().optional(),
  owners: z.array(z.object({ emailAddress: z.string().optional() })).optional(),
});

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  /** Quando è nato il file (review F5a, punto 2: il Doc delle note nasce con la riunione). */
  createdTime: Date | null;
  /** Gli indirizzi dei proprietari, in minuscolo. */
  owners: string[];
}

export async function getDriveFile(input: { accessToken: string; fileId: string }, options: GoogleClientOptions = {}): Promise<DriveFileMeta> {
  const api = "drive.files.get";
  const payload = await requestGoogle(
    {
      api,
      url: buildUrl(`${DRIVE_API_BASE}/${encodeURIComponent(input.fileId)}`, { fields: "id,name,mimeType,trashed,createdTime,owners(emailAddress)", supportsAllDrives: "true" }),
      accessToken: input.accessToken,
      statusCodes: NOT_FOUND,
    },
    options,
  );
  const raw = parseGoogleJson(api, fileSchema, payload);
  const created = raw.createdTime ? new Date(raw.createdTime) : null;
  return {
    id: raw.id,
    name: raw.name ?? "",
    mimeType: raw.mimeType ?? "",
    trashed: raw.trashed === true,
    createdTime: created && !Number.isNaN(created.getTime()) ? created : null,
    owners: (raw.owners ?? []).flatMap((o) => (o.emailAddress ? [o.emailAddress.toLowerCase()] : [])),
  };
}

/** Il testo di un Google Doc (`files.export` in `text/plain`), al più `maxChars` caratteri. */
export async function exportGoogleDocText(
  input: { accessToken: string; fileId: string; maxChars: number },
  options: GoogleClientOptions = {},
): Promise<{ text: string; truncated: boolean }> {
  const text = (await requestGoogle(
    {
      api: "drive.files.export",
      url: buildUrl(`${DRIVE_API_BASE}/${encodeURIComponent(input.fileId)}/export`, { mimeType: "text/plain" }),
      accessToken: input.accessToken,
      statusCodes: NOT_FOUND,
      expectText: true,
    },
    options,
  )) as string | null;
  const full = text ?? "";
  return full.length > input.maxChars ? { text: full.slice(0, input.maxChars), truncated: true } : { text: full, truncated: false };
}

// --- Area 6, F5b: i riferimenti a Google Drive ----------------------------

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

/** Come si legge il contenuto di un file nativo di Google (che non ha byte propri). */
export const GOOGLE_EXPORT_MIME: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export interface DriveListedFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedAt: Date | null;
  /** Null per un file nativo (un Doc non ha dimensione). */
  sizeBytes: number | null;
  owner: string | null;
  ownerName: string | null;
}

const listSchema = z.object({
  files: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        mimeType: z.string().optional(),
        modifiedTime: z.string().optional(),
        size: z.string().optional(),
        owners: z.array(z.object({ emailAddress: z.string().optional(), displayName: z.string().optional() })).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

/** Un valore in una query di Drive: fra apici, con apici e barre protetti. */
function quoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

async function listPage(
  input: { accessToken: string; q: string; pageToken?: string; pageSize?: number },
  options: GoogleClientOptions,
): Promise<{ files: DriveListedFile[]; nextPageToken: string | null }> {
  const api = "drive.files.list";
  const payload = await requestGoogle(
    {
      api,
      url: buildUrl(DRIVE_API_BASE, {
        q: input.q,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size,owners(emailAddress,displayName))",
        pageSize: input.pageSize ?? 100,
        pageToken: input.pageToken,
        orderBy: "modifiedTime desc",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      }),
      accessToken: input.accessToken,
    },
    options,
  );
  const raw = parseGoogleJson(api, listSchema, payload);
  return {
    files: (raw.files ?? []).map((f) => {
      const modified = f.modifiedTime ? new Date(f.modifiedTime) : null;
      const size = f.size !== undefined ? Number(f.size) : NaN;
      return {
        id: f.id,
        name: f.name ?? "",
        mimeType: f.mimeType ?? "",
        modifiedAt: modified && !Number.isNaN(modified.getTime()) ? modified : null,
        sizeBytes: Number.isFinite(size) ? size : null,
        owner: f.owners?.[0]?.emailAddress?.toLowerCase() ?? null,
        ownerName: f.owners?.[0]?.displayName ?? null,
      };
    }),
    nextPageToken: raw.nextPageToken ?? null,
  };
}

/** I file che chi chiede vede nel SUO Drive (il picker «Aggiungi da Google Drive»), cercati per nome. */
export async function listDriveFiles(
  input: { accessToken: string; query?: string; pageToken?: string; pageSize?: number },
  options: GoogleClientOptions = {},
): Promise<{ files: DriveListedFile[]; nextPageToken: string | null }> {
  const name = input.query?.trim();
  const q = [`trashed = false`, `mimeType != '${DRIVE_FOLDER_MIME}'`, ...(name ? [`name contains ${quoted(name)}`] : [])].join(" and ");
  return listPage({ accessToken: input.accessToken, q, ...(input.pageToken ? { pageToken: input.pageToken } : {}), ...(input.pageSize ? { pageSize: input.pageSize } : {}) }, options);
}

/** Le cartelle che chi chiede vede («Collega una cartella»). */
export async function listDriveFolders(
  input: { accessToken: string; query?: string; pageToken?: string },
  options: GoogleClientOptions = {},
): Promise<{ files: DriveListedFile[]; nextPageToken: string | null }> {
  const name = input.query?.trim();
  const q = [`trashed = false`, `mimeType = '${DRIVE_FOLDER_MIME}'`, ...(name ? [`name contains ${quoted(name)}`] : [])].join(" and ");
  return listPage({ accessToken: input.accessToken, q, ...(input.pageToken ? { pageToken: input.pageToken } : {}) }, options);
}

/** I file (non le sottocartelle) di UNA cartella, tutte le pagine fino a `max`. */
export async function listFolderFiles(
  input: { accessToken: string; folderId: string; max: number },
  options: GoogleClientOptions = {},
): Promise<DriveListedFile[]> {
  const q = [`trashed = false`, `mimeType != '${DRIVE_FOLDER_MIME}'`, `${quoted(input.folderId)} in parents`].join(" and ");
  const out: DriveListedFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listPage({ accessToken: input.accessToken, q, ...(pageToken ? { pageToken } : {}) }, options);
    out.push(...page.files);
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken && out.length < input.max);
  return out.slice(0, input.max);
}

/**
 * Il contenuto di un file come stream: un file nativo di Google si ESPORTA
 * (`GOOGLE_EXPORT_MIME`), un altro si scarica (`alt=media`). Il tetto dei byte
 * lo applica chi legge lo stream.
 */
export async function openDriveFileStream(
  input: { accessToken: string; fileId: string; mimeType: string },
  options: GoogleClientOptions = {},
): Promise<{ body: ReadableStream<Uint8Array>; mime: string }> {
  const exportMime = GOOGLE_EXPORT_MIME[input.mimeType];
  const api = exportMime ? "drive.files.export" : "drive.files.get_media";
  const url = exportMime
    ? buildUrl(`${DRIVE_API_BASE}/${encodeURIComponent(input.fileId)}/export`, { mimeType: exportMime })
    : buildUrl(`${DRIVE_API_BASE}/${encodeURIComponent(input.fileId)}`, { alt: "media", supportsAllDrives: "true" });
  const response = await fetchWithTimeout(url, { method: "GET", headers: { authorization: `Bearer ${input.accessToken}` } }, options);
  if (!response.ok) throw await errorFromResponse(response, { api, url, statusCodes: NOT_FOUND });
  if (!response.body) throw new GoogleApiError({ api, status: response.status, code: "invalid_response", reason: "nessun corpo" });
  return { body: response.body, mime: exportMime ?? input.mimeType };
}
