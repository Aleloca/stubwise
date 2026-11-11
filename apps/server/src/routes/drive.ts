import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  DRIVE_FILE_MAX_BYTES,
  driveCodeResolutionSchema,
  driveFileDetailSchema,
  driveFileListSchema,
  driveFileRowSchema,
  driveListQuerySchema,
  driveUploadResultSchema,
  saveToDriveBodySchema,
} from "@stubwise/shared";
import { apiError } from "../errors.js";
import { isMultipartLimit } from "./multipart.js";
import { authErrorResponses, errorSchema } from "./shared.js";
import {
  assertCanUploadDrive,
  deleteDriveFile,
  DriveError,
  getDriveFile,
  inlineContentTypeFor,
  listDriveFiles,
  markPurged,
  openDriveFile,
  resolveDriveCode,
  retryDriveFile,
  saveAttachmentToDrive,
  uploadDriveFile,
} from "../drive/service.js";

/**
 * Il Drive dei progetti, i file CARICATI (area 5, fetta 2; invariante
 * `docs/invariants/drive.md`). Le regole di chi vede, carica e toglie stanno
 * nel servizio (`drive/service.ts`): le rotte sono `{ kind: "user" }` perché
 * vedere il Drive vuol dire ESSERE MEMBRI del progetto, non avere un
 * permesso, e un progetto che non si vede risponde 404 come uno che non c'è.
 */

const ACCESS = { kind: "user" } as const;
const idParams = z.object({ id: z.uuid() });
const projectParams = z.object({ projectId: z.uuid() });
const errors = { ...authErrorResponses, 400: errorSchema, 403: errorSchema, 404: errorSchema };
/** Quanto vive l'URL firmato di un download o di un'anteprima. */
const SIGNED_URL_TTL_SECONDS = 300;

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DriveError) return apiError(reply, error.status, error.code, error.message);
    throw error;
  }
}

/** L'origine di un URL, o null se non è un URL. */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export async function driveRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  // La ricerca per contenuto (F3.4) usa l'embedder del server per la corsia semantica, fail-open.
  const searchOpts = (request: FastifyRequest) => ({ embeddings: app.embeddingClient, log: (m: string) => request.log.warn(m) });

  app.get(
    "/projects/:projectId/drive/files",
    { config: { access: ACCESS }, schema: { params: projectParams, querystring: driveListQuerySchema, response: { 200: driveFileListSchema, ...errors } } },
    async (request, reply) =>
      handle(reply, async () => ({ items: await listDriveFiles(app.db, request.user!, request.query, { projectId: request.params.projectId }, searchOpts(request)) })),
  );

  // Il caricamento: multipart, un file, al più 100 MB (D4 = a), in STREAMING
  // verso lo storage. Chi può caricare si controlla PRIMA di leggere il file.
  app.post(
    "/projects/:projectId/drive/files",
    {
      config: {
        access: ACCESS,
        rateLimit: { max: 30, timeWindow: "1 minute", hook: "preHandler", keyGenerator: (request: FastifyRequest) => request.user?.id ?? request.ip },
      },
      schema: { params: projectParams, response: { 201: driveUploadResultSchema, 413: errorSchema, ...errors } },
    },
    async (request, reply) =>
      handle(reply, async () => {
        await assertCanUploadDrive(app.db, request.user!, request.params.projectId);
        const storage = await app.storage();
        if (!storage) return apiError(reply, 400, "storage_not_configured", "Object storage is not configured");
        let part;
        try {
          // UN file e nient'altro (review della fetta 2): nessun campo, una parte.
          part = await request.file({ limits: { fileSize: DRIVE_FILE_MAX_BYTES, files: 1, fields: 0, parts: 1 } });
        } catch (error) {
          if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return apiError(reply, 413, "file_too_large", "File exceeds the 100 MB limit");
          if (isMultipartLimit(error)) return apiError(reply, 400, "invalid_multipart", "Send one file and nothing else");
          throw error;
        }
        if (!part) return apiError(reply, 400, "file_required", "A file is required");
        const file = part.file;
        const created = await uploadDriveFile(app.db, storage, request.user!, request.params.projectId, {
          filename: part.filename,
          mime: part.mimetype,
          stream: file,
          truncated: () => file.truncated,
        });
        return reply.code(201).send(created);
      }),
  );

  // «Save to Drive» da un allegato della Chat (F2.4): una COPIA dell'oggetto.
  app.post(
    "/chat/attachments/:id/save-to-drive",
    {
      config: {
        access: ACCESS,
        rateLimit: { max: 30, timeWindow: "1 minute", hook: "preHandler", keyGenerator: (request: FastifyRequest) => request.user?.id ?? request.ip },
      },
      schema: { params: idParams, body: saveToDriveBodySchema, response: { 201: driveUploadResultSchema, ...errors } },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const storage = await app.storage();
        if (!storage) return apiError(reply, 400, "storage_not_configured", "Object storage is not configured");
        const saved = await saveAttachmentToDrive(app.db, storage, request.user!, request.params.id, { projectId: request.body.projectId });
        return reply.code(201).send(saved);
      }),
  );

  // L'elenco globale: i file dei progetti di cui si è membri.
  app.get(
    "/drive/files",
    { config: { access: ACCESS }, schema: { querystring: driveListQuerySchema, response: { 200: driveFileListSchema, ...errors } } },
    async (request, reply) => handle(reply, async () => ({ items: await listDriveFiles(app.db, request.user!, request.query, {}, searchOpts(request)) })),
  );

  // «Riprova» (F3.4): rimette in coda l'estrazione di un file `no_text` o `error`.
  app.post(
    "/drive/files/:id/retry",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 200: driveFileRowSchema, 409: errorSchema, ...errors } } },
    async (request, reply) => handle(reply, () => retryDriveFile(app.db, request.user!, request.params.id)),
  );

  app.get(
    "/drive/files/:id",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 200: driveFileDetailSchema, ...errors } } },
    async (request, reply) => handle(reply, () => getDriveFile(app.db, request.user!, request.params.id)),
  );

  app.delete(
    "/drive/files/:id",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 204: z.null(), ...errors } } },
    async (request, reply) =>
      handle(reply, async () => {
        const gone = await deleteDriveFile(app.db, request.user!, request.params.id);
        // L'oggetto si toglie DOPO la lapide; se lo storage è giù lo ritenta
        // la pulizia oraria (`purgeDeletedDriveObjects`).
        try {
          const storage = await app.storage();
          if (storage) {
            await storage.deleteObject(gone.storageKey);
            await markPurged(app.db, gone.id);
          }
        } catch (error) {
          request.log.warn({ err: error, fileId: gone.id }, "oggetto del Drive non tolto dallo storage: lo ritenta la pulizia");
        }
        return reply.code(204).send(null);
      }),
  );

  // Il download: 302 verso l'URL firmato, sempre `attachment`.
  app.get(
    "/drive/files/:id/download",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 302: z.null(), ...errors } } },
    async (request, reply) => {
      const storage = await app.storage();
      if (!storage) return apiError(reply, 400, "storage_not_configured", "Object storage is not configured");
      const file = await openDriveFile(app.db, request.user!, request.params.id, "download");
      if (!file) return apiError(reply, 404, "not_found", "Not found");
      return reply.redirect(await storage.getSignedDownloadUrl(file.storageKey, file.name, SIGNED_URL_TTL_SECONDS), 302);
    },
  );

  // L'anteprima: INLINE solo per un tipo sicuro (`inlineContentTypeFor`, col
  // Content-Type deciso qui: il testo come `text/plain; charset=utf-8`) E solo
  // se gli URL firmati stanno su un'origine DIVERSA dall'istanza: servito
  // inline dalla stessa origine, un file caricato girerebbe coi cookie della
  // sessione. Altrimenti è un download.
  app.get(
    "/drive/files/:id/preview",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 302: z.null(), ...errors } } },
    async (request, reply) => {
      const storage = await app.storage();
      if (!storage) return apiError(reply, 400, "storage_not_configured", "Object storage is not configured");
      const file = await openDriveFile(app.db, request.user!, request.params.id, "preview");
      if (!file) return apiError(reply, 404, "not_found", "Not found");
      const storageOrigin = originOf(storage.origin);
      const crossOrigin = storageOrigin !== null && storageOrigin !== originOf(app.publicUrl);
      const inline = crossOrigin ? inlineContentTypeFor(file.mime) : null;
      return reply.redirect(
        await storage.getSignedDownloadUrl(file.storageKey, file.name, SIGNED_URL_TTL_SECONDS, inline ? { inlineContentType: inline } : undefined),
        302,
      );
    },
  );

  // Dove sta il file di un codice `<PRJ>-F<n>`, per chi è membro; 404 altrimenti.
  app.get(
    "/drive/codes/:code",
    { config: { access: ACCESS }, schema: { params: z.object({ code: z.string().min(1).max(40) }), response: { 200: driveCodeResolutionSchema, ...errors } } },
    async (request, reply) => {
      const found = await resolveDriveCode(app.db, request.user!, request.params.code);
      if (!found) return apiError(reply, 404, "not_found", "Not found");
      return found;
    },
  );
}
