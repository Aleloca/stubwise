import {
  driveCodeResolutionSchema,
  driveFileDetailSchema,
  driveFileRowSchema,
  driveFileListSchema,
  driveUploadResultSchema,
} from "@stubwise/shared";
import type { DriveFileType, SaveToDriveInput } from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/** I filtri dell'elenco del Drive (`driveListQuerySchema`). */
export interface DriveListOptions {
  type?: DriveFileType;
  addedById?: string;
  /** Nome o codice F, mai il contenuto. */
  q?: string;
  sort?: "most_used" | "recent" | "name";
  limit?: number;
}

/**
 * Il Drive dei progetti, i file CARICATI (area 5, fetta 2). Vedere vuol dire
 * essere membri del progetto: un file di un progetto che non si vede è 404,
 * come uno che non esiste. I permessi di una riga (`permissions`) li calcola
 * il server. Download e anteprima sono 302 verso un URL firmato: qui ci sono i
 * percorsi, li segue chi li apre.
 */
export function createDriveEndpoints(request: ApiRequest) {
  const listQuery = (o: DriveListOptions & { projectId?: string }) =>
    toQuery({ projectId: o.projectId, type: o.type, addedById: o.addedById, q: o.q, sort: o.sort, limit: o.limit });
  return {
    /** L'elenco del Drive di un progetto; 404 a chi non è membro. */
    list(projectId: string, opts: DriveListOptions = {}) {
      return request("GET", `/api/projects/${seg(projectId)}/drive/files${listQuery(opts)}`, undefined, driveFileListSchema);
    },
    /** L'elenco globale: i file dei progetti di cui si è membri. */
    listAll(opts: DriveListOptions & { projectId?: string } = {}) {
      return request("GET", `/api/drive/files${listQuery(opts)}`, undefined, driveFileListSchema);
    },
    /** Il dettaglio: aperture totali e storia (null senza `drive.history`). */
    get(id: string) {
      return request("GET", `/api/drive/files/${seg(id)}`, undefined, driveFileDetailSchema);
    },
    /**
     * Carica un file nel Drive del progetto (multipart, campo `file`, al più
     * 100 MB). 201 col file, `keptBoth` se il nome c'era già. 413
     * `file_too_large`, 400 `unsupported_type` / `invalid_filename` /
     * `file_required` / `storage_not_configured`, 403 senza `drive.upload`.
     */
    upload(projectId: string, file: Blob, filename: string) {
      const form = new FormData();
      form.append("file", file, filename);
      return request("POST", `/api/projects/${seg(projectId)}/drive/files`, form, driveUploadResultSchema);
    },
    /** Elimina: il proprio file, o qualunque con `drive.manage` (403 altrimenti). */
    remove(id: string): Promise<void> {
      return request("DELETE", `/api/drive/files/${seg(id)}`);
    },
    /** Il download: 302 verso l'URL firmato, sempre come allegato. Conta un'apertura. */
    downloadPath(id: string): string {
      return `/api/drive/files/${seg(id)}/download`;
    },
    /** L'anteprima: 302, inline solo per i tipi sicuri e da un'altra origine. Conta un'apertura. */
    previewPath(id: string): string {
      return `/api/drive/files/${seg(id)}/preview`;
    },
    /** Dove sta il file di un codice `<PRJ>-F<n>`; 404 se non lo si vede. */
    resolveCode(code: string) {
      return request("GET", `/api/drive/codes/${seg(code)}`, undefined, driveCodeResolutionSchema);
    },
    /**
     * «Save to Drive» da un allegato della Chat: una COPIA. In un DM o in un
     * generale serve `projectId` (400 `project_required`); in un canale di
     * progetto il progetto è il suo (un altro: 400 `project_mismatch`).
     */
    saveFromChat(attachmentId: string, input: SaveToDriveInput = {}) {
      return request("POST", `/api/chat/attachments/${seg(attachmentId)}/save-to-drive`, input, driveUploadResultSchema);
    },
    /**
     * «Riprova» (F3.4): rimette in coda l'estrazione del contenuto di un file
     * `no_text` o `error`. Risponde con la riga, già `pending`. 403 senza
     * `drive.manage`, 409 `not_retryable` in un altro stato.
     */
    retry(id: string) {
      return request("POST", `/api/drive/files/${seg(id)}/retry`, {}, driveFileRowSchema);
    },
  };
}
