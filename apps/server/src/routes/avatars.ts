import { userAvatars } from "@stubwise/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import { AVATAR_MAX_BYTES, detectAvatarType } from "../services/avatars.js";
import { canSeePerson } from "../services/people-visibility.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Area 9, F1 (D-13; docs/invariants/identity.md, «La foto è un'immagine, mai un
 * documento»). `PUT /api/me/avatar` col corpo binario (al più 512 KB, il tipo
 * dedotto dai byte), `DELETE /api/me/avatar`, `GET /api/users/:id/avatar` alla
 * visibilità di `/api/people`, servita col tipo dedotto, `nosniff` e una CSP
 * che non esegue niente.
 */
export async function avatarRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  // Il corpo arriva come Buffer, qualunque tipo dichiari fra questi: il tipo vero lo dicono i byte.
  // Il tetto esatto dei 512 KB lo controlla l'handler, uguale per il corpo nudo e per il multipart.
  const bodyLimit = AVATAR_MAX_BYTES + 64 * 1024;
  instance.addContentTypeParser(
    ["image/png", "image/jpeg", "image/webp", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit },
    (_request, body, done) => done(null, body),
  );

  app.put(
    "/me/avatar",
    {
      config: {
        access: { kind: "user" },
        mcp: { action: "me.setAvatar", summary: "Cambia la tua foto del profilo con un'immagine locale (PNG, JPEG o WebP, al più 512 KB).", effect: "write", tool: "upload_file" },
      },
      // Un margine per la busta del multipart (parità MCP, `upload_file`); il tetto vero è sotto.
      bodyLimit,
      schema: { response: { 204: z.null(), ...authErrorResponses, 400: errorSchema, 413: errorSchema, 415: errorSchema } },
    },
    async (request, reply) => {
      let bytes: Buffer;
      if (request.isMultipart()) {
        // Parità MCP (lotto 4): lo stesso file anche come multipart, un file e
        // nient'altro, con le stesse regole sui byte.
        let part;
        try {
          part = await request.file({ limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 0, parts: 1 } });
          if (!part) return apiError(reply, 400, "file_required", "A file is required");
          bytes = await part.toBuffer();
        } catch (error) {
          if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return apiError(reply, 413, "file_too_large", "The image exceeds 512 KB");
          throw error;
        }
      } else {
        bytes = request.body as Buffer;
      }
      if (Buffer.isBuffer(bytes) && bytes.length > AVATAR_MAX_BYTES) return apiError(reply, 413, "file_too_large", "The image exceeds 512 KB");
      const type = Buffer.isBuffer(bytes) ? detectAvatarType(bytes) : null;
      if (!type) return apiError(reply, 415, "unsupported_image", "Only PNG, JPEG or WebP images");
      await app.db
        .insert(userAvatars)
        .values({ userId: request.user!.id, contentType: type, bytes })
        .onConflictDoUpdate({ target: userAvatars.userId, set: { contentType: type, bytes, updatedAt: sql`now()` } });
      return reply.code(204).send(null);
    },
  );

  app.delete(
    "/me/avatar",
    { config: { access: { kind: "user" } }, schema: { response: { 204: z.null(), ...authErrorResponses } } },
    async (request, reply) => {
      await app.db.delete(userAvatars).where(eq(userAvatars.userId, request.user!.id));
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/users/:id/avatar",
    {
      config: { access: { kind: "user" } },
      schema: { params: z.object({ id: z.uuid() }), response: { 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const { id } = request.params;
      // Una persona invisibile è come una senza foto: lo stesso 404.
      if (!(await canSeePerson(app.db, request.user!, id))) return apiError(reply, 404, "not_found", "Not found");
      const [row] = await app.db.select().from(userAvatars).where(eq(userAvatars.userId, id));
      if (!row) return apiError(reply, 404, "not_found", "Not found");
      return reply
        .header("content-type", row.contentType)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("content-disposition", "inline")
        .header("cache-control", "private, max-age=300")
        // Byte grezzi, non JSON: nessuno schema 200 da serializzare.
        .send(row.bytes as never);
    },
  );
}
