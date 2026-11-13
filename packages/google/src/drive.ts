import { z } from "zod";
import { buildUrl, parseGoogleJson, requestGoogle, type GoogleClientOptions } from "./fetch.js";

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
