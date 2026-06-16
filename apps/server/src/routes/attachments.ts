import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import { attachments, comments, tickets } from "@stubwise/db";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Tipi MIME ammessi per gli allegati. Allowlist (non blocklist): tutto ciò che
 * non è qui esplicitamente è rifiutato con 400 `unsupported_type`. Esportata
 * perché client/UI/SDK ne hanno bisogno per filtrare prima dell'upload.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/zip",
] as const;

const allowedMimeSet = new Set<string>(ALLOWED_ATTACHMENT_MIME_TYPES);

/** Dimensione massima di un allegato: 10 MB (coerente col limite multipart). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Forma pubblica di un allegato (metadati). Il binario non passa mai per l'API:
 * si scarica via URL presigned. `downloadUrl` è presente solo nelle risposte
 * che lo generano al volo (lista), non al momento della creazione.
 */
export const attachmentSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  commentId: z.uuid().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  createdAt: z.iso.datetime(),
});

const attachmentWithUrlSchema = attachmentSchema.extend({
  downloadUrl: z.string(),
});

const ticketParamsSchema = z.object({ ticketId: z.uuid() });
const attachmentParamsSchema = z.object({ attachmentId: z.uuid() });

type AttachmentRow = typeof attachments.$inferSelect;

function toPublicAttachment(row: AttachmentRow): z.infer<typeof attachmentSchema> {
  return {
    id: row.id,
    ticketId: row.ticketId,
    commentId: row.commentId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

/** True se il ticket esiste: gli allegati di un ticket fantasma sono 404. */
async function ticketExists(db: Db, ticketId: string): Promise<boolean> {
  const [row] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId));
  return row !== undefined;
}

/**
 * Sanifica il nome file per la storage key: tiene solo l'ultimo segmento del
 * path (no traversal), rimpiazza tutto ciò che non è alfanumerico/.-_ con `_`,
 * e ripiega su un default se il risultato fosse vuoto. Il nome ORIGINALE viene
 * comunque salvato in DB e usato nel Content-Disposition; questa versione serve
 * solo a comporre una chiave S3 sicura e leggibile.
 */
function sanitizeForKey(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "file";
}

/** True se l'errore è il limite di dimensione di @fastify/multipart. */
function isFileTooLarge(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: string }).code === "FST_REQ_FILE_TOO_LARGE"
  );
}

/** Scadenza degli URL presigned: breve, sono usa-e-getta in `<img>`/`<a>`. */
const DOWNLOAD_URL_TTL_SECONDS = 300;

/**
 * Route allegati legate al ticket, sotto /api/tickets/:ticketId/attachments:
 * upload (multipart) e lista con URL presigned.
 */
export async function ticketAttachmentRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        params: ticketParamsSchema,
        // Body multipart: non descritto via Zod (consumeremo lo stream a mano).
        response: {
          201: attachmentSchema,
          400: errorSchema,
          404: errorSchema,
          413: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { ticketId } = request.params;
      if (!(await ticketExists(app.db, ticketId))) {
        return apiError(reply, 404, "ticket_not_found", "Ticket not found");
      }

      const storage = await app.storage();
      if (!storage) {
        return apiError(reply, 400, "storage_not_configured", "Object storage is not configured");
      }

      // Legge l'unico file del multipart. Se non c'è parte file → 400.
      let part;
      try {
        part = await request.file();
      } catch (error) {
        if (isFileTooLarge(error)) {
          return apiError(reply, 413, "file_too_large", "File exceeds the 10 MB limit");
        }
        throw error;
      }
      if (!part) {
        return apiError(reply, 400, "file_required", "A file is required");
      }

      if (!allowedMimeSet.has(part.mimetype)) {
        return apiError(reply, 400, "unsupported_type", "Unsupported file type");
      }

      // commentId opzionale: da campo multipart o da query.
      const commentIdField = part.fields.commentId;
      const rawCommentId =
        (commentIdField && !Array.isArray(commentIdField) && commentIdField.type === "field"
          ? String(commentIdField.value)
          : undefined) ?? (request.query as { commentId?: string }).commentId;
      let commentId: string | null = null;
      if (rawCommentId !== undefined && rawCommentId !== "") {
        if (!z.uuid().safeParse(rawCommentId).success) {
          return apiError(reply, 400, "invalid_comment", "Invalid comment id");
        }
        const [comment] = await app.db
          .select({ id: comments.id, ticketId: comments.ticketId })
          .from(comments)
          .where(eq(comments.id, rawCommentId));
        if (!comment || comment.ticketId !== ticketId) {
          return apiError(reply, 404, "comment_not_found", "Comment not found on this ticket");
        }
        commentId = comment.id;
      }

      // Bufferizza il file. toBuffer() lancia FST_REQ_FILE_TOO_LARGE se supera
      // il limite (lo stream viene troncato a fileSize).
      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch (error) {
        if (isFileTooLarge(error)) {
          return apiError(reply, 413, "file_too_large", "File exceeds the 10 MB limit");
        }
        throw error;
      }
      // Difesa ulteriore: alcune versioni segnalano il troncamento via flag.
      if (part.file.truncated || buffer.length > MAX_ATTACHMENT_BYTES) {
        return apiError(reply, 413, "file_too_large", "File exceeds the 10 MB limit");
      }

      const storageKey = `tickets/${ticketId}/${randomUUID()}/${sanitizeForKey(part.filename)}`;
      await storage.putObject(storageKey, buffer, part.mimetype);

      let created: AttachmentRow | undefined;
      try {
        [created] = await app.db
          .insert(attachments)
          .values({
            ticketId,
            commentId,
            uploaderId: request.user?.id,
            filename: part.filename,
            mimeType: part.mimetype,
            sizeBytes: buffer.length,
            storageKey,
          })
          .returning();
      } catch (error) {
        // L'oggetto è già su S3 ma il metadato non è stato scritto: rimuovi
        // l'oggetto best-effort per non lasciare orfani, poi rilancia (500).
        try {
          await storage.deleteObject(storageKey);
        } catch (cleanupError) {
          request.log.error(cleanupError, "cleanup dell'oggetto orfano fallito");
        }
        throw error;
      }
      if (!created) throw new Error("L'insert dell'allegato non ha restituito la riga creata");
      return reply.code(201).send(toPublicAttachment(created));
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        params: ticketParamsSchema,
        response: {
          200: z.array(attachmentWithUrlSchema),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { ticketId } = request.params;
      if (!(await ticketExists(app.db, ticketId))) {
        return apiError(reply, 404, "ticket_not_found", "Ticket not found");
      }
      const rows = await app.db
        .select()
        .from(attachments)
        .where(eq(attachments.ticketId, ticketId))
        .orderBy(asc(attachments.createdAt), asc(attachments.id));

      const storage = await app.storage();
      // Senza storage attivo non possiamo firmare gli URL: lo storage potrebbe
      // essere stato disattivato dopo l'upload. Restituiamo comunque i metadati
      // con downloadUrl vuoto, così la UI mostra la lista senza rompersi.
      return Promise.all(
        rows.map(async (row) => ({
          ...toPublicAttachment(row),
          downloadUrl: storage
            ? await storage.getSignedDownloadUrl(
                row.storageKey,
                row.filename,
                DOWNLOAD_URL_TTL_SECONDS,
              )
            : "",
        })),
      );
    },
  );
}

/**
 * Route allegati per id, sotto /api/attachments: download (302 verso URL
 * presigned) e delete. Slegate dal path del ticket per stare in `<a>`/`<img>`.
 */
export async function attachmentRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/:attachmentId/download",
    {
      preHandler: requireAuth,
      schema: {
        params: attachmentParamsSchema,
        response: { 302: z.null(), 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { attachmentId } = request.params;
      const [row] = await app.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, attachmentId));
      if (!row) {
        return apiError(reply, 404, "attachment_not_found", "Attachment not found");
      }
      const storage = await app.storage();
      if (!storage) {
        return apiError(reply, 400, "storage_not_configured", "Object storage is not configured");
      }
      const url = await storage.getSignedDownloadUrl(
        row.storageKey,
        row.filename,
        DOWNLOAD_URL_TTL_SECONDS,
      );
      // 302: l'URL presigned è temporaneo, il browser non deve cacharlo.
      return reply.redirect(url, 302);
    },
  );

  app.delete(
    "/:attachmentId",
    {
      preHandler: requireAuth,
      schema: {
        params: attachmentParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { attachmentId } = request.params;
      const [row] = await app.db
        .select()
        .from(attachments)
        .where(eq(attachments.id, attachmentId));
      if (!row) {
        return apiError(reply, 404, "attachment_not_found", "Attachment not found");
      }
      // Permesso: l'uploader stesso oppure un admin.
      const user = request.user;
      const isOwner = row.uploaderId !== null && row.uploaderId === user?.id;
      if (!isOwner && user?.role !== "admin") {
        return apiError(reply, 403, "forbidden", "Not allowed to delete this attachment");
      }

      // Best-effort sullo storage: se non raggiungibile/non configurato, logga
      // ma rimuovi comunque la riga, per non lasciare metadati orfani che
      // punterebbero a un oggetto inservibile. La pulizia dell'oggetto su S3
      // resta a carico di un'eventuale lifecycle policy del bucket.
      const storage = await app.storage();
      if (storage) {
        try {
          await storage.deleteObject(row.storageKey);
        } catch (error) {
          request.log.error(error, "delete dell'oggetto su storage fallita; rimuovo comunque il metadato");
        }
      }
      await app.db.delete(attachments).where(eq(attachments.id, attachmentId));
      return reply.code(204).send(null);
    },
  );
}
