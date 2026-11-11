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
  if (m.startsWith("text/") || m.includes("wordprocessing") || m === "application/msword" || m === "application/rtf" || m.includes("opendocument.text")) {
    return "document";
  }
  return "other";
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
  sizeBytes: z.number().int(),
  addedById: z.uuid().nullable(),
  addedAt: z.iso.datetime(),
  /** Le aperture degli ultimi 90 giorni («Più usati»), di tutti. */
  opens90d: z.number().int().default(0),
  lastOpenedAt: z.iso.datetime().nullable().default(null),
  /** La prima riga del riassunto AI (F3); null finché non c'è. */
  summaryLine: z.string().nullable().default(null),
  permissions: driveFilePermissionsSchema.default({ delete: false, remove: false, hide: false, retry: false }),
});
export type DriveFileRow = z.infer<typeof driveFileRowSchema>;

/** Il dettaglio: la riga, le aperture totali e la storia (solo con `drive.history`, altrimenti null). */
export const driveFileDetailSchema = driveFileRowSchema.extend({
  opensTotal: z.number().int().default(0),
  history: z
    .array(z.object({ personId: z.uuid(), at: z.iso.datetime(), via: z.enum(["preview", "download"]) }))
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
});
export type DriveListQuery = z.input<typeof driveListQuerySchema>;

/** `GET /api/drive/codes/:code`: dove sta il file di un codice. */
export const driveCodeResolutionSchema = z.object({ code: z.string(), projectId: z.uuid(), fileId: z.uuid() });
export type DriveCodeResolution = z.infer<typeof driveCodeResolutionSchema>;

/** «Save to Drive» da un allegato della Chat: in un DM o in un generale serve il progetto. */
export const saveToDriveBodySchema = z.object({ projectId: z.uuid().optional() });
export type SaveToDriveInput = z.input<typeof saveToDriveBodySchema>;

/** Il codice di un file, `<PRJ>-F<n>`. */
export const DRIVE_CODE_RE = /^([A-Z][A-Z0-9]{1,5})-F(\d{1,9})$/;
export const driveCode = (projectCode: string, number: number): string => `${projectCode}-F${number}`;
