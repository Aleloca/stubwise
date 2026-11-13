import { z } from "zod";

/**
 * Il Drive dei progetti (area 5, fetta 2; prototipo `data/drive/`, `data/model.ts`).
 * Oggi solo i file CARICATI: i riferimenti Google arrivano con l'area 6 (D1 = a).
 * VEDERE il Drive di un progetto vuol dire esserne membri; caricare vuole
 * `drive.upload`, togliere i file altrui `drive.manage`, la storia delle
 * aperture `drive.history`. I permessi di una riga li calcola il server.
 */

/** Fino a 100 MB per file (D4 = a, maintainer); i tipi sono quelli della Chat (`chatAttachmentAllowed`). */
export const DRIVE_FILE_MAX_BYTES = 100 * 1024 * 1024;

export const DRIVE_FILE_TYPES = ["document", "sheet", "slides", "pdf", "image", "other"] as const;
export const driveFileTypeSchema = z.enum(DRIVE_FILE_TYPES);
export type DriveFileType = z.infer<typeof driveFileTypeSchema>;

/** Il tipo mostrato di un file, dal suo MIME (il filtro «tipo» del prototipo). */
export function driveFileTypeOf(mime: string): DriveFileType {
  const m = mime.toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m === "text/csv" || m.includes("spreadsheet") || m === "application/vnd.ms-excel") return "sheet";
  if (m.includes("presentation") || m === "application/vnd.ms-powerpoint") return "slides";
  // F5b: un Google Doc (i Fogli e le Presentazioni li prendono le righe sopra).
  if (m === "application/vnd.google-apps.document") return "document";
  if (m.startsWith("text/") || m.includes("wordprocessing") || m === "application/msword" || m === "application/rtf" || m.includes("opendocument.text")) {
    return "document";
  }
  return "other";
}

/**
 * Il contenuto di un file (area 5, fetta 3): il worker ne estrae il testo, il
 * riassunto e gli embedding. `no_text` ha sempre un motivo; `error` è per i
 * guasti NOSTRI (storage, database), che il job ritenta. Un tipo senza
 * estrazione nasce `unsupported`, senza job.
 */
export const DRIVE_CONTENT_STATUSES = ["pending", "processing", "ready", "no_text", "unsupported", "error"] as const;
export const driveContentStatusSchema = z.enum(DRIVE_CONTENT_STATUSES);
export type DriveContentStatus = z.infer<typeof driveContentStatusSchema>;
export const DRIVE_CONTENT_REASONS = ["no_text_found", "ocr_timeout", "ocr_unavailable", "unreadable", "too_large", "limits"] as const;
export const driveContentReasonSchema = z.enum(DRIVE_CONTENT_REASONS);
export type DriveContentReason = z.infer<typeof driveContentReasonSchema>;
export const DRIVE_CONTENT_OCR = ["none", "full", "partial"] as const;
export const driveContentOcrSchema = z.enum(DRIVE_CONTENT_OCR);
export type DriveContentOcr = z.infer<typeof driveContentOcrSchema>;

/** Come si estrae il testo di un tipo; null = `unsupported` (D Office/ODF = a: doc, xls, ppt vecchi no). */
export type DriveContentKind = "text" | "pdf" | "image" | "heic" | "office";
const CONTENT_KINDS: Readonly<Record<string, DriveContentKind>> = {
  "text/plain": "text",
  "text/csv": "text",
  "text/markdown": "text",
  "application/pdf": "pdf",
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/heic": "heic",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "office",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "office",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "office",
  "application/vnd.oasis.opendocument.text": "office",
  "application/vnd.oasis.opendocument.spreadsheet": "office",
  "application/vnd.oasis.opendocument.presentation": "office",
};
export function driveContentKindOf(mime: string): DriveContentKind | null {
  return CONTENT_KINDS[mime.toLowerCase()] ?? null;
}

/** I permessi di chi guarda su un file, calcolati dal server e letti dal client. */
export const driveFilePermissionsSchema = z.object({
  /** Eliminare un file caricato: il proprio, o qualunque con `drive.manage`. */
  delete: z.boolean().default(false),
  /** Togliere un riferimento Google dal progetto (area 6). */
  remove: z.boolean().default(false),
  /** Nascondere un file di una cartella collegata (area 6). */
  hide: z.boolean().default(false),
  /** Rifare l'estrazione del contenuto (F3). */
  retry: z.boolean().default(false),
});

/** Una riga del Drive come la legge chi guarda. */
export const driveFileRowSchema = z.object({
  id: z.uuid(),
  /** `<PRJ>-F<n>`, per progetto e mai riusato. */
  code: z.string(),
  projectId: z.uuid(),
  /** Il codice del progetto (per l'elenco globale). */
  projectCode: z.string().nullable().default(null),
  source: z.enum(["upload", "google"]).default("upload"),
  name: z.string(),
  mime: z.string(),
  type: driveFileTypeSchema,
  /** Null per un riferimento Google nativo (un Doc non ha byte) — area 6, F5b. */
  sizeBytes: z.number().int().nullable(),
  addedById: z.uuid().nullable(),
  addedAt: z.iso.datetime(),
  /** Le aperture degli ultimi 90 giorni («Più usati»), di tutti. */
  opens90d: z.number().int().default(0),
  lastOpenedAt: z.iso.datetime().nullable().default(null),
  /** La prima riga del riassunto AI (F3); null finché non c'è. */
  summaryLine: z.string().nullable().default(null),
  /**
   * Lo stato del contenuto (F3). Null = un server SENZA la F3 (rollback, istanza
   * non aggiornata), che non lo manda: il client lo mostra come oggi, non come
   * «in elaborazione» per sempre. Un server F3 lo manda sempre.
   */
  contentStatus: driveContentStatusSchema.nullable().default(null),
  /** Perché non c'è testo (solo `no_text`). */
  contentReason: driveContentReasonSchema.nullable().default(null),
  /** Quanto è passato dall'OCR; null finché non si è estratto. */
  contentOcr: driveContentOcrSchema.nullable().default(null),
  /** Il passaggio trovato, solo nelle righe di una ricerca per contenuto (al più 300 caratteri). */
  snippet: z.string().nullable().default(null),
  permissions: driveFilePermissionsSchema.default({ delete: false, remove: false, hide: false, retry: false }),
  // --- Area 6, F5b: i riferimenti a Google Drive (tutti con default) -------
  googleFileId: z.string().nullable().default(null),
  /** Il proprietario su Google (un indirizzo). */
  googleOwner: z.string().nullable().default(null),
  /** L'ultima modifica su Google (un riferimento) o il caricamento. */
  modifiedAt: z.iso.datetime().nullable().default(null),
  /** La cartella collegata da cui viene, se viene da una cartella. */
  folder: z.object({ id: z.uuid(), name: z.string(), status: z.enum(["ok", "expired"]) }).nullable().default(null),
  hidden: z.boolean().default(false),
  hiddenBy: z.object({ personId: z.uuid().nullable(), at: z.iso.datetime() }).nullable().default(null),
  /**
   * `deleted`: sparito da Google (lo dice la sincronizzazione). `access_lost`:
   * la casella di chi ha collegato la cartella non legge più (si DERIVA).
   * Un file non disponibile non si apre.
   */
  unavailable: z.enum(["deleted", "access_lost"]).nullable().default(null),
});
export type DriveFileRow = z.infer<typeof driveFileRowSchema>;

/** Il dettaglio: la riga, le aperture totali e la storia (solo con `drive.history`, altrimenti null). */
export const driveFileDetailSchema = driveFileRowSchema.extend({
  opensTotal: z.number().int().default(0),
  /** Il riassunto AI intero (F3), solo nel dettaglio; l'elenco ha `summaryLine`. Narrativa generata. */
  summary: z.string().nullable().default(null),
  history: z
    .array(z.object({ personId: z.uuid(), at: z.iso.datetime(), via: z.enum(["preview", "download", "google"]) }))
    .nullable()
    .default(null),
});
export type DriveFileDetail = z.infer<typeof driveFileDetailSchema>;

export const driveFileListSchema = z.object({ items: z.array(driveFileRowSchema) });

/**
 * La risposta 201 del caricamento. `keptBoth`: il nome c'era già fra i file
 * vivi del progetto, e il server ha salvato «Nome (2).ext» (l'avviso «Kept
 * both» del prototipo); `requestedName` è il nome mandato.
 */
export const driveUploadResultSchema = z.object({
  file: driveFileRowSchema,
  keptBoth: z.boolean().default(false),
  requestedName: z.string(),
});
export type DriveUploadResult = z.infer<typeof driveUploadResultSchema>;

/** I filtri dell'elenco (nella URL nel prototipo). `q` cerca nel nome e nel codice. */
export const driveListQuerySchema = z.object({
  projectId: z.uuid().optional(),
  type: driveFileTypeSchema.optional(),
  addedById: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(["most_used", "recent", "name"]).default("most_used"),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  /** F5b: `upload` o `google`. */
  source: z.enum(["upload", "google"]).optional(),
  /** F5b: solo i NASCOSTI (e solo dei progetti in cui chi guarda ha `drive.manage`). */
  hidden: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});
export type DriveListQuery = z.input<typeof driveListQuerySchema>;

/** `GET /api/drive/codes/:code`: dove sta il file di un codice. */
export const driveCodeResolutionSchema = z.object({ code: z.string(), projectId: z.uuid(), fileId: z.uuid() });
export type DriveCodeResolution = z.infer<typeof driveCodeResolutionSchema>;

/** Il tetto del testo che Claude legge di un file (come `read_doc_page`). */
export const DRIVE_CLAUDE_TEXT_MAX = 30_000;

/**
 * `GET /api/drive/files/by-code/:code/content` (F3.5): ciò che Claude legge di
 * un file, coi permessi di chi parla. Il testo è contenuto NON fidato: il
 * ponte del worker lo consegna come `untrusted_document`. Leggerlo non conta
 * un'apertura.
 */
export const driveFileContentSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  projectId: z.uuid(),
  name: z.string(),
  type: driveFileTypeSchema,
  contentStatus: driveContentStatusSchema,
  contentReason: driveContentReasonSchema.nullable().default(null),
  summary: z.string().nullable().default(null),
  /** Al più `DRIVE_CLAUDE_TEXT_MAX` caratteri; vuoto se non c'è testo. */
  text: z.string().default(""),
  /** Il testo è più lungo di quanto restituito (o era già troncato all'estrazione). */
  truncated: z.boolean().default(false),
});
export type DriveFileContent = z.infer<typeof driveFileContentSchema>;

/** «Save to Drive» da un allegato della Chat: in un DM o in un generale serve il progetto. */
export const saveToDriveBodySchema = z.object({ projectId: z.uuid().optional() });
export type SaveToDriveInput = z.input<typeof saveToDriveBodySchema>;

/** Il codice di un file, `<PRJ>-F<n>`. */
export const DRIVE_CODE_RE = /^([A-Z][A-Z0-9]{1,5})-F(\d{1,9})$/;
export const driveCode = (projectCode: string, number: number): string => `${projectCode}-F${number}`;

// --- Area 6, F5b: Google Drive nel Drive dei progetti ----------------------

/** Una cartella Google collegata a un progetto (`status`/`accessLost` derivati dal server). */
export const driveFolderLinkSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  googleFolderId: z.string(),
  linkedById: z.uuid().nullable().default(null),
  linkedAt: z.iso.datetime(),
  status: z.enum(["ok", "expired"]).default("ok"),
  expiredAt: z.iso.datetime().nullable().default(null),
  /** L'ultima sincronizzazione riuscita; null se non ce n'è ancora stata una. */
  lastSyncedAt: z.iso.datetime().nullable().default(null),
  /** I file (non nascosti) che porta. */
  fileCount: z.number().int().default(0),
  accessLost: z.boolean().default(false),
});
export type DriveFolderLink = z.infer<typeof driveFolderLinkSchema>;
export const driveFolderLinkListSchema = z.object({ items: z.array(driveFolderLinkSchema).default([]) });

/** Un file del MIO Drive nel picker («Aggiungi da Google Drive»). */
export const googleFileChoiceSchema = z.object({
  googleFileId: z.string(),
  name: z.string(),
  type: driveFileTypeSchema,
  mime: z.string(),
  owner: z.string().nullable().default(null),
  modifiedAt: z.iso.datetime().nullable().default(null),
  alreadyInProject: z.boolean().default(false),
});
export type GoogleFileChoice = z.infer<typeof googleFileChoiceSchema>;
export const googleFileChoiceListSchema = z.object({ items: z.array(googleFileChoiceSchema).default([]) });

/** Una cartella del MIO Drive («Collega una cartella»). `path` e `fileCount` non si leggono da Google senza una chiamata per cartella: vuoti/null. */
export const googleFolderChoiceSchema = z.object({
  googleFolderId: z.string(),
  name: z.string(),
  path: z.array(z.string()).default([]),
  fileCount: z.number().int().nullable().default(null),
  alreadyLinked: z.boolean().default(false),
});
export type GoogleFolderChoice = z.infer<typeof googleFolderChoiceSchema>;
export const googleFolderChoiceListSchema = z.object({ items: z.array(googleFolderChoiceSchema).default([]) });

export const addGoogleFileBodySchema = z.object({ googleFileId: z.string().min(1).max(200) });
export const linkGoogleFolderBodySchema = z.object({ googleFolderId: z.string().min(1).max(200) });
export const setDriveHiddenBodySchema = z.object({ hidden: z.boolean() });

/**
 * Dove si apre un file di Google (F5b: «Apri in Google Drive», e il link in
 * un'email): i permessi li applica Google a chi apre. UN posto, letto da
 * server e client.
 */
export function googleOpenUrl(mime: string, googleFileId: string): string {
  const id = encodeURIComponent(googleFileId);
  switch (mime) {
    case "application/vnd.google-apps.document":
      return `https://docs.google.com/document/d/${id}/edit`;
    case "application/vnd.google-apps.spreadsheet":
      return `https://docs.google.com/spreadsheets/d/${id}/edit`;
    case "application/vnd.google-apps.presentation":
      return `https://docs.google.com/presentation/d/${id}/edit`;
    default:
      return `https://drive.google.com/file/d/${id}/view`;
  }
}
