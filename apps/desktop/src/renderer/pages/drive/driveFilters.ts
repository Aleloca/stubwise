import type { DriveFile, DriveFileType, DriveFilters, DriveSort } from "../../data/types";

// Il Drive nell'indirizzo (shape drive.md §9): ordinamento e filtri stanno
// nella ricerca (`?sort=name&type=pdf`), validati qui e riletti dalla pagina.
// «Più usati» è il default e non si scrive. `prj` (il filtro Project) vale
// solo nella destinazione `#/drive`: nella sezione il progetto è il percorso.
// `hidden=1` (il filtro «Hidden», Task 7) mostra solo i nascosti: la pagina
// lo passa all'elenco solo a chi gestisce il Drive (per gli altri non c'è).
// `file` (il dettaglio aperto) vale ovunque, come `task`. Nessun import da
// `data/routes.ts`: è lui a leggere da qui.

export const DRIVE_SORTS = ["most_used", "recent", "name"] as const satisfies readonly DriveSort[];
export const DRIVE_TYPES = [
  "document",
  "sheet",
  "slides",
  "pdf",
  "image",
  "other",
] as const satisfies readonly DriveFileType[];
export const DRIVE_SOURCES = ["upload", "google"] as const satisfies readonly DriveFile["source"][];

/** Le chiavi della ricerca del Drive (oltre a `file`). */
export const DRIVE_SEARCH_KEYS = ["sort", "type", "source", "addedBy", "prj", "hidden"] as const;
export type DriveSearchKey = (typeof DRIVE_SEARCH_KEYS)[number];
export type DriveSearch = Partial<Record<DriveSearchKey, string>>;

/** Il codice di un file del Drive: `AUD-F7`. */
export const FILE_CODE_RE = /^[A-Z]{2,4}-F\d+$/;

const includes = (list: readonly string[], value: string) => list.includes(value);

/** La forma di un valore della ricerca del Drive (il percorso lo decide `isDrivePath`). */
export function isDriveSearchValue(key: string, value: string): boolean {
  switch (key) {
    case "sort":
      return includes(DRIVE_SORTS, value);
    case "type":
      return includes(DRIVE_TYPES, value);
    case "source":
      return includes(DRIVE_SOURCES, value);
    case "addedBy":
      return /^[\w-]+$/.test(value);
    case "prj":
      return /^[A-Z]{2,4}$/.test(value);
    case "hidden":
      return value === "1";
    default:
      return false;
  }
}

/** Il Drive: la destinazione (`drive`) o la sezione di un progetto (`p/AUD/drive`). */
export function isDrivePath(path: string): boolean {
  return path === "drive" || /^p\/[A-Z]{2,4}\/drive$/.test(path);
}

const valid = (search: DriveSearch, key: DriveSearchKey): string | undefined => {
  const v = search[key];
  return v !== undefined && isDriveSearchValue(key, v) ? v : undefined;
};

/**
 * Dalla ricerca ai filtri dell'elenco. Nella sezione di un progetto
 * (`projectId`) il progetto è quello; nella destinazione lo dice `prj`
 * (per codice). Un valore malformato si scarta.
 */
export function driveFiltersFrom(
  search: DriveSearch,
  { projectId, codeToId }: { projectId?: string; codeToId: (code: string) => string | undefined },
): DriveFilters {
  const out: DriveFilters = { sort: (valid(search, "sort") as DriveSort) ?? "most_used" };
  const prj = valid(search, "prj");
  const pid = projectId ?? (prj ? codeToId(prj) : undefined);
  if (pid) out.projectId = pid;
  const type = valid(search, "type");
  if (type) out.type = type as DriveFileType;
  const source = valid(search, "source");
  if (source) out.source = source as DriveFile["source"];
  const addedBy = valid(search, "addedBy");
  if (addedBy) out.addedById = addedBy;
  if (valid(search, "hidden")) out.hidden = true;
  return out;
}

/** C'è almeno un filtro (l'ordinamento non è un filtro): «Clear filters» compare. */
export function hasDriveFilter(search: DriveSearch): boolean {
  return (["type", "source", "addedBy", "prj", "hidden"] as const).some((k) => valid(search, k) !== undefined);
}

/**
 * Il nome diviso per l'ellissi a metà: la testa si accorcia, l'estensione
 * resta visibile («Specifiche funzionali dia… .pdf»). Un nome senza punto
 * (o che comincia col punto) non ha estensione.
 */
export function middleEllipsis(name: string): { head: string; tail: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > 8) return { head: name, tail: "" };
  return { head: name.slice(0, dot), tail: name.slice(dot) };
}

export type PreviewKind = "image" | "pdf" | "text";

const TEXT_NAME = /\.(md|markdown|txt|csv|json|log)$/i;

/**
 * Che anteprima ha un file: solo i caricati, e solo immagine, PDF o testo.
 * Un Google si apre su Google; gli altri formati non hanno anteprima
 * (l'azione primaria è «Download»).
 */
export function previewKind(
  file: Pick<DriveFile, "source" | "type" | "mime" | "name">,
): PreviewKind | null {
  if (file.source !== "upload") return null;
  if (file.type === "image") return "image";
  if (file.type === "pdf") return "pdf";
  if (file.mime.startsWith("text/") || TEXT_NAME.test(file.name)) return "text";
  return null;
}
