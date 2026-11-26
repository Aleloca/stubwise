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
  instance.addContentTypeParser(
    ["image/png", "image/jpeg", "image/webp", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: AVATAR_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.put(
    "/me/avatar",
    {
      config: { access: { kind: "user" } },
      bodyLimit: AVATAR_MAX_BYTES,
      schema: { response: { 204: z.null(), ...authErrorResponses, 415: errorSchema } },
    },
    async (request, reply) => {
      const bytes = request.body as Buffer;
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
    { config: { mcp: { action: "me.deleteAvatar", summary: "Toglie la tua foto.", effect: "destructive" }, access: { kind: "user" } }, schema: { response: { 204: z.null(), ...authErrorResponses } } },
    async (request, reply) => {
      await app.db.delete(userAvatars).where(eq(userAvatars.userId, request.user!.id));
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/users/:id/avatar",
    {
      config: { mcp: { action: "users.avatar", summary: "La foto di una persona, salvata su disco.", effect: "read", tool: "download_file" }, access: { kind: "user" } },
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
