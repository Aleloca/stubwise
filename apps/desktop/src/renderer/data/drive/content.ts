import type { ContentState, DriveFile, DriveFileType, DriveOpen } from "../types";

// Le regole pure del Drive (area 5): quando un'apertura conta, le aperture
// degli ultimi 90 giorni, che cosa del file è cercabile, il tipo di un file
// caricato e il suo contenuto simulato. Nessuno stato: chi chiama passa i dati.

/** Stessa persona sullo stesso riferimento entro questa finestra = un'apertura sola. */
export const OPEN_DEDUP_MS = 30 * 60 * 1000;

/** La finestra di «Più usati» e del numero sulla riga. */
export const OPENS_WINDOW_DAYS = 90;

/** Il limite di un caricamento. */
export const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Se `next` conta come apertura, dato `prev`, l'ultima apertura contata
 * della stessa persona sullo stesso riferimento (`undefined` se non ce n'è):
 * conta se sono passati almeno 30 minuti. Persona o riferimento diversi
 * contano sempre.
 */
export function isOpenCounted(prev: DriveOpen | undefined, next: DriveOpen): boolean {
  if (!prev || prev.personId !== next.personId || prev.fileId !== next.fileId) return true;
  return Date.parse(next.at) - Date.parse(prev.at) >= OPEN_DEDUP_MS;
}

/** Le aperture di un riferimento negli ultimi 90 giorni (90 giorni esatti compresi). */
export function opens90d(
  file: Pick<DriveFile, "id">,
  now: string,
  opens: readonly DriveOpen[],
): number {
  const from = Date.parse(now) - OPENS_WINDOW_DAYS * DAY_MS;
  return opens.filter((o) => o.fileId === file.id && Date.parse(o.at) >= from).length;
}

/**
 * Il testo di un file che ricerca e Claude possono leggere: solo di un file
 * disponibile e pronto. Un file non disponibile, o non ancora pronto, si
 * trova solo per nome.
 */
export function searchableText(file: Pick<DriveFile, "unavailable" | "content" | "text">): string {
  return file.unavailable === null && file.content === "ready" ? file.text : "";
}

/** La prima riga del riassunto, per la riga dell'elenco. */
export function summaryLineOf(summary: string | null): string | null {
  const line = summary
    ?.split("\n")
    .find((l) => l.trim())
    ?.trim();
  return line || null;
}

const EXTENSION_TYPES: Record<string, DriveFileType> = {
  pdf: "pdf",
  doc: "document",
  docx: "document",
  odt: "document",
  rtf: "document",
  txt: "document",
  md: "document",
  xls: "sheet",
  xlsx: "sheet",
  ods: "sheet",
  csv: "sheet",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",
  key: "slides",
};

/** Il tipo di un file caricato, dal tipo MIME o, in mancanza, dall'estensione. */
export function driveTypeOf(name: string, mime: string): DriveFileType {
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return EXTENSION_TYPES[ext] ?? (mime.startsWith("text/") ? "document" : "other");
}

/**
 * Il nome di un caricato che non si scontra con quelli già nel progetto:
 * uguale a uno esistente → «nome (2).ext», poi (3)…
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Il contenuto finale simulato di un caricato, dal tipo: i documenti hanno
 * testo e riassunto finti, le immagini nessun testo, gli altri formati non
 * sono supportati.
 */
export function uploadedContent(
  name: string,
  type: DriveFileType,
): { content: Exclude<ContentState, "processing">; text: string; summary: string | null } {
  if (type === "image") return { content: "no_text", text: "", summary: null };
  if (type === "other") return { content: "unsupported", text: "", summary: null };
  return {
    content: "ready",
    text: `Text extracted from “${name}”.`,
    summary: `Uploaded file “${name}”: its text is ready for search and for Claude.`,
  };
}
