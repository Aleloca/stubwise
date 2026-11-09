import type { DriveFile, DriveFileType, DriveOpen, FolderLink } from "../../types";
import { at } from "../conversations/helpers";

export { at };

/** I tipi MIME dei documenti nativi di Google (senza dimensione). */
const GOOGLE_MIME: Partial<Record<DriveFileType, string>> = {
  document: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
};

/** Il contenuto di un file: pronto con testo e riassunto, o uno stato senza testo. */
export type Content =
  | { content: "ready"; text: string; summary: string; ocr?: boolean }
  | { content: "processing" | "no_text" | "unsupported" | "error" };

/** Pronto, con testo e riassunto. */
export const ready = (text: string, summary: string, ocr = false): Content => ({
  content: "ready",
  text,
  summary,
  ocr,
});

function contentOf(c: Content): Pick<DriveFile, "content" | "text" | "summary" | "ocr"> {
  return c.content === "ready"
    ? { content: "ready", text: c.text, summary: c.summary, ocr: c.ocr ?? false }
    : { content: c.content, text: "", summary: null, ocr: false };
}

/** L'id e il codice del file `n` di un progetto: `drv-aud-7`, `AUD-F7`. */
function ids(code: string, n: number): Pick<DriveFile, "id" | "code" | "projectId"> {
  const lower = code.toLowerCase();
  return { id: `drv-${lower}-${n}`, code: `${code}-F${n}`, projectId: `prj-${lower}` };
}

/** Un file caricato in Stubwise. */
export function upload(
  code: string,
  n: number,
  spec: {
    name: string;
    type: DriveFileType;
    mime: string;
    sizeBytes: number;
    by: string;
    at: string;
  },
  content: Content,
): DriveFile {
  return {
    ...ids(code, n),
    source: "upload",
    name: spec.name,
    type: spec.type,
    mime: spec.mime,
    sizeBytes: spec.sizeBytes,
    addedById: spec.by,
    addedAt: spec.at,
    modifiedAt: spec.at,
    folderLinkId: null,
    googleFileId: null,
    googleOwner: null,
    hidden: false,
    unavailable: null,
    ...contentOf(content),
  };
}

/**
 * Un riferimento a un file di Google Drive: dentro una cartella collegata
 * (risulta aggiunto da chi l'ha collegata, quando l'ha collegata) o aggiunto
 * a mano (`{ by, at }`). `mime` e `sizeBytes` servono solo ai file non nativi.
 */
export function google(
  code: string,
  n: number,
  from: FolderLink | { by: string; at: string },
  spec: {
    name: string;
    type: DriveFileType;
    googleFileId: string;
    owner: string;
    modified: string;
    mime?: string;
    sizeBytes?: number;
    hidden?: boolean;
    unavailable?: DriveFile["unavailable"];
  },
  content: Content,
): DriveFile {
  const folder = "linkedById" in from ? from : null;
  const manual = "by" in from ? from : null;
  return {
    ...ids(code, n),
    source: "google",
    name: spec.name,
    type: spec.type,
    mime: spec.mime ?? GOOGLE_MIME[spec.type]!,
    sizeBytes: spec.sizeBytes ?? null,
    addedById: folder?.linkedById ?? manual!.by,
    addedAt: folder?.linkedAt ?? manual!.at,
    modifiedAt: spec.modified,
    folderLinkId: folder?.id ?? null,
    googleFileId: spec.googleFileId,
    googleOwner: spec.owner,
    hidden: spec.hidden ?? false,
    unavailable: spec.unavailable ?? null,
    ...contentOf(content),
  };
}

const HOURS = ["09:12", "10:47", "11:58", "14:21", "15:36", "16:54", "17:40"];

/**
 * `n` aperture di un file distribuite fra `fromDays` e `toDays` giorni fa,
 * a rotazione fra `people`, fra le ore del giorno e fra i modi (`via`): mai
 * due della stessa persona sullo stesso file entro 30 minuti.
 */
export function spread(
  fileId: string,
  people: string[],
  n: number,
  fromDays: number,
  toDays: number,
  via: DriveOpen["via"] | DriveOpen["via"][],
): DriveOpen[] {
  const vias = Array.isArray(via) ? via : [via];
  return Array.from({ length: n }, (_, i) => ({
    fileId,
    personId: people[i % people.length]!,
    at: at(
      n === 1 ? fromDays : fromDays - Math.round((i * (fromDays - toDays)) / (n - 1)),
      HOURS[i % HOURS.length]!,
    ),
    via: vias[i % vias.length]!,
  }));
}
