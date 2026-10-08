import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  agentSessionDetailSchema,
  agentSessionEventPageSchema,
  agentSessionListQuerySchema,
  agentSessionListSchema,
} from "@stubwise/shared";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import {
  getAgentSession,
  listAgentSessionEvents,
  listAgentSessions,
} from "../services/agent-sessions.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const idParams = z.object({ id: z.uuid() });
const cursor = z.string().regex(/^\d+$/);

export async function agentSessionRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        querystring: agentSessionListQuerySchema,
        response: { 200: agentSessionListSchema, ...authErrorResponses },
      },
    },
    async (request) => listAgentSessions(app.db, request.user!, request.query),
  );

  // Rotte con una parte letterale PRIMA di `GET /:id` (trappola di routing).
  app.get(
    "/:id/events",
    {
      preHandler: requireAuth,
      schema: {
        params: idParams,
        querystring: z.object({
          after: cursor.optional(),
          before: cursor.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: { 200: agentSessionEventPageSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const page = await listAgentSessionEvents(
        app.db,
        request.user!,
        request.params.id,
        request.query,
      );
      if (!page) return apiError(reply, 404, "not_found", "Session not found");
      return page;
    },
  );

  app.get(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParams,
        response: { 200: agentSessionDetailSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const detail = await getAgentSession(app.db, request.user!, request.params.id);
      if (!detail) return apiError(reply, 404, "not_found", "Session not found");
      return detail;
    },
  );
}
