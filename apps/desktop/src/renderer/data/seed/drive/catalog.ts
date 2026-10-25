import type { DriveFile, GoogleDriveFile, GoogleFolder } from "../../types";
import { AUD_FILES } from "./aud";
import { FOLDER_LINKS, GOOGLE_OUTSIDE_FILES } from "./google";
import { at } from "./helpers";
import { MKX_FILES } from "./mkx";
import { STW_FILES } from "./stw";

// Il lato Google, simulato: le cartelle e i file come li vede Google. È la
// fonte da cui si collega una cartella, si aggiunge un file e si
// risincronizza. Le cartelle già collegate e i file già nei progetti vengono
// dal seme dei riferimenti (un file Google in due progetti è un file solo
// qui); in più una cartella non collegata da nessuno, i file fuori dai
// progetti e gli aggiornamenti fatti su Google dopo l'ultima lettura.

/** Le briciole e chi vede ogni cartella su Google. */
const FOLDER_SIDE: Record<string, Pick<GoogleFolder, "path" | "visibleToPersonIds">> = {
  "gfolder-aud-cliente": {
    path: ["My Drive", "Clienti", "Audin"],
    visibleToPersonIds: ["p-matteo", "p-laura", "p-giulia"],
  },
  "gfolder-mkx-primavera": {
    path: ["My Drive", "Marketing", "Mix Cucine"],
    visibleToPersonIds: ["p-giulia", "p-matteo"],
  },
  "gfolder-stw-brand": {
    path: ["My Drive", "Stubwise"],
    visibleToPersonIds: ["p-laura", "p-giulia"],
  },
};

/** Una cartella che nessun progetto ha collegato: si prova «Collega una cartella». */
const BELLAVISTA_FOLDER: GoogleFolder = {
  googleFolderId: "gfolder-bellavista",
  name: "Cantina Bellavista – materiali",
  path: ["My Drive", "Clienti"],
  visibleToPersonIds: ["p-giulia", "p-matteo"],
};

export const GOOGLE_FOLDERS: GoogleFolder[] = [
  ...FOLDER_LINKS.map((link) => ({
    googleFolderId: link.googleFolderId,
    name: link.name,
    ...FOLDER_SIDE[link.googleFolderId]!,
  })),
  BELLAVISTA_FOLDER,
];

/**
 * Il contenuto finale dei file che nel seme sono ancora in elaborazione
 * (Stubwise li sta leggendo): è quello che trovano alla fine.
 */
const FINAL_CONTENT: Record<string, Pick<GoogleDriveFile, "content" | "text" | "summary">> = {
  "gfile-aud-calendario": {
    content: "ready",
    text: "Delivery calendar, updated. Release 1 (dialer): 14 November. Release 2 (CRM import): 19 December. Release 3 (billing): 6 February. Go-live: 31 March 2027.",
    summary: "Updated delivery calendar: three releases, go-live on 31 March 2027.",
  },
};

/**
 * I file aggiornati su Google dopo l'ultima lettura di Stubwise: «Sincronizza
 * ora» li riporta in elaborazione, col riassunto in rielaborazione, poi
 * pronti con il testo nuovo.
 */
export const GOOGLE_UPDATES: Pick<
  GoogleDriveFile,
  "googleFileId" | "modifiedAt" | "text" | "summary"
>[] = [
  {
    googleFileId: "gfile-aud-preventivo-2026",
    modifiedAt: at(0, "11:20"),
    text: "Quote for 45 seats with yearly billing: Team tier 45 × €29/month, onboarding €2,400 one-off, discount 12% on yearly payment. Updated after the 12 October meeting.",
    summary: "Updated quote: 45 seats, yearly billing, 12% discount, onboarding.",
  },
];

function sideOf(file: DriveFile, folderId: string | null): GoogleDriveFile {
  const final = FINAL_CONTENT[file.googleFileId!];
  const update = GOOGLE_UPDATES.find((u) => u.googleFileId === file.googleFileId);
  const content = final?.content ?? (file.content === "processing" ? "ready" : file.content);
  return {
    googleFileId: file.googleFileId!,
    googleFolderId: folderId,
    name: file.name,
    type: file.type,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
    owner: file.googleOwner!,
    modifiedAt: update?.modifiedAt ?? file.modifiedAt,
    deleted: file.unavailable === "deleted",
    content,
    text: update?.text ?? final?.text ?? file.text,
    summary: update?.summary ?? final?.summary ?? file.summary,
    ocr: file.ocr,
    // Un file aggiunto a mano lo vede chi l'ha aggiunto (finché ha accesso);
    // uno di cartella chi vede la cartella.
    visibleToPersonIds: folderId !== null || file.unavailable !== null ? [] : [file.addedById],
  };
}

const folderIdOf = (linkId: string | null) =>
  FOLDER_LINKS.find((l) => l.id === linkId)?.googleFolderId ?? null;

const fromReferences = (): GoogleDriveFile[] => {
  const seen = new Map<string, GoogleDriveFile>();
  for (const file of [...AUD_FILES, ...MKX_FILES, ...STW_FILES]) {
    if (file.source !== "google" || seen.has(file.googleFileId!)) continue;
    seen.set(file.googleFileId!, sideOf(file, folderIdOf(file.folderLinkId)));
  }
  return [...seen.values()];
};

const BELLAVISTA_FILES: GoogleDriveFile[] = [
  {
    googleFileId: "gfile-bellavista-logo",
    googleFolderId: BELLAVISTA_FOLDER.googleFolderId,
    name: "Logo Cantina Bellavista.png",
    type: "image",
    mime: "image/png",
    sizeBytes: 182_400,
    owner: "giulia.ferri@example.com",
    modifiedAt: at(16, "10:00"),
    deleted: false,
    content: "no_text",
    text: "",
    summary: null,
    ocr: false,
    visibleToPersonIds: [],
  },
  {
    googleFileId: "gfile-bellavista-catalogo",
    googleFolderId: BELLAVISTA_FOLDER.googleFolderId,
    name: "Catalogo vini 2026",
    type: "sheet",
    mime: "application/vnd.google-apps.spreadsheet",
    sizeBytes: null,
    owner: "giulia.ferri@example.com",
    modifiedAt: at(9, "15:10"),
    deleted: false,
    content: "ready",
    text: "Wine catalogue 2026: 38 labels, prices by bottle and by case, wine club discounts 10–15%.",
    summary: "Wine catalogue 2026: 38 labels with prices and wine club discounts.",
    ocr: false,
    visibleToPersonIds: [],
  },
  {
    googleFileId: "gfile-bellavista-brief",
    googleFolderId: BELLAVISTA_FOLDER.googleFolderId,
    name: "Brief sito Cantina Bellavista",
    type: "document",
    mime: "application/vnd.google-apps.document",
    sizeBytes: null,
    owner: "matteo.conti@example.com",
    modifiedAt: at(7, "09:40"),
    deleted: false,
    content: "ready",
    text: "Website brief: online store, wine club subscriptions, tasting-room bookings, shipping by region.",
    summary: "Website brief: store, wine club, tasting bookings, shipping by region.",
    ocr: false,
    visibleToPersonIds: [],
  },
];

/** I file fuori dai progetti sono anche file di Google, aggiungibili a mano. */
const OUTSIDE: GoogleDriveFile[] = GOOGLE_OUTSIDE_FILES.map((f) => ({
  googleFileId: f.googleFileId,
  googleFolderId: null,
  name: f.name,
  type: f.type,
  mime:
    f.type === "slides"
      ? "application/vnd.google-apps.presentation"
      : "application/vnd.google-apps.document",
  sizeBytes: null,
  owner: "giulia.ferri@example.com",
  modifiedAt: at(6, "14:00"),
  deleted: false,
  content: "ready",
  text: f.text,
  summary: f.summary,
  ocr: false,
  visibleToPersonIds: [...f.visibleToPersonIds],
}));

export const GOOGLE_DRIVE_FILES: GoogleDriveFile[] = [
  ...fromReferences(),
  ...BELLAVISTA_FILES,
  ...OUTSIDE,
];

/** Chi ha nascosto i file nascosti del seme, e quando. */
export const DRIVE_HIDDEN: { fileId: string; personId: string; at: string }[] = [
  { fileId: "drv-aud-8", personId: "p-laura", at: at(19, "09:20") },
];
