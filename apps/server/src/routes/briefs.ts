import { projectBriefWeeklySchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { getBrief } from "../services/project-briefs.js";
import { canViewProject } from "../services/project-timeline.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * `GET /api/briefs/:briefId` — UN brief settimanale per id (Fase 5).
 *
 * Rotta di primo livello e non `/api/projects/:id/briefs/:briefId` perché il
 * brief ha un LINK PROPRIO: la notifica `project.brief`, il separatore della
 * roadmap e il tool MCP lo indirizzano per id, e chiedere a ognuno di portarsi
 * dietro anche il progetto sarebbe un id in più da tenere allineato per niente.
 *
 * L'ACL resta quella del PROGETTO (`canViewProject`), letta dal brief: un
 * member vede solo i progetti che segue. Un brief inesistente e uno di un
 * progetto non visibile rispondono entrambi 404 — non si distingue "non esiste"
 * da "non è tuo" contando i codici di stato, come per la timeline.
 */
export async function briefRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/:briefId",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ briefId: z.uuid() }),
        response: {
          200: projectBriefWeeklySchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const brief = await getBrief(app.db, request.params.briefId);
      if (!brief) return apiError(reply, 404, "brief_not_found", "Brief not found");
      const viewer = { userId: request.user!.id, role: request.user!.role };
      if (!(await canViewProject(app.db, brief.projectId, viewer))) {
        return apiError(reply, 404, "brief_not_found", "Brief not found");
      }
      return brief;
    },
  );
}
