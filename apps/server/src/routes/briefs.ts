import { projectBriefWeeklySchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { fromBrief } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import { getBrief } from "../services/project-briefs.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * `GET /api/briefs/:briefId` — UN brief settimanale per id (Fase 5).
 *
 * Rotta di primo livello e non `/api/projects/:id/briefs/:briefId` perché il
 * brief ha un LINK PROPRIO: la notifica `project.brief`, il separatore della
 * roadmap e il tool MCP lo indirizzano per id, e chiedere a ognuno di portarsi
 * dietro anche il progetto sarebbe un id in più da tenere allineato per niente.
 *
 * L'ACL resta quella del PROGETTO, letto dal brief (`fromBrief`), con
 * `tickets.view_all` come la rotta dell'elenco (ruling R49: il brief racconta
 * i ticket di tutti). Un brief inesistente e uno di un progetto non
 * visibile rispondono entrambi 404 `not_found` — non si distingue "non esiste"
 * da "non è tuo" contando i codici di stato, come per la timeline.
 */
export async function briefRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/:briefId",
    {
      config: {
        access: { kind: "project", permission: "tickets.view_all", project: fromBrief("briefId") },
      },
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
      // Sparito fra l'hook e la lettura.
      if (!brief) return apiError(reply, 404, "brief_not_found", "Brief not found");
      return brief;
    },
  );
}
