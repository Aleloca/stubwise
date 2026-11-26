import { detachedRepositorySchema, linkRepositorySchema } from "@stubwise/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import { DetachedRepositoryError, deleteDetachedRepository, linkRepository, listDetachedRepositories } from "../services/detached-repositories.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Area 9, F6 (D-8): i repository senza progetto, sotto /api/repositories.
 * Registrato PRIMA di `repositoryRoutes`: `/detached` è letterale e sta sul
 * prefisso di `/:slug` (la trappola di routing di CLAUDE.md). Le rotte sono
 * `user`: il permesso dipende dal progetto di destinazione (link) o
 * dall'istanza (delete), e lo calcola il servizio.
 */
const params = z.object({ id: z.uuid() });

async function send(reply: FastifyReply, error: unknown): Promise<FastifyReply> {
  if (error instanceof DetachedRepositoryError) return apiError(reply, error.status, error.code, error.message);
  throw error;
}

export async function detachedRepositoryRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/detached",
    { config: { mcp: { action: "repositories.detached", summary: "I repository staccati da un progetto (il progetto è stato eliminato).", effect: "read" }, access: { kind: "user" } }, schema: { response: { 200: z.array(detachedRepositorySchema), ...authErrorResponses } } },
    async (request, reply) => {
      try {
        return await listDetachedRepositories(app.db, request.user!);
      } catch (error) {
        return send(reply, error);
      }
    },
  );

  app.post(
    "/:id/link",
    {
      config: { mcp: { action: "repositories.link", summary: "Ricollega a un progetto un repository staccato.", effect: "write" }, access: { kind: "user" } },
      schema: { params, body: linkRepositorySchema, response: { 204: z.null(), 404: errorSchema, 409: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      try {
        await linkRepository(app.db, request.user!, request.params.id, request.body.projectId);
        return await reply.code(204).send(null);
      } catch (error) {
        return send(reply, error);
      }
    },
  );

  app.delete(
    "/:id",
    {
      config: { access: { kind: "user" }, reauth: true },
      schema: { params, response: { 204: z.null(), 404: errorSchema, 409: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      try {
        await deleteDetachedRepository(app.db, request.user!, request.params.id);
        return await reply.code(204).send(null);
      } catch (error) {
        return send(reply, error);
      }
    },
  );
}
