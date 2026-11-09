import { chronologyPageSchema, weeklyBriefViewSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { projectPermissionsMap, routePermissions, type RouteAccess } from "../auth/access.js";
import { fromParam } from "../auth/project-resolvers.js";
import { latestWeeklyBrief, portfolioActivity, projectChronology } from "../services/chronology.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * L'Overview e l'attività del portafoglio dell'app nuova (integrazione area
 * 2, fetta 4). La cronologia è a pagine di 28 giorni (`before`); la Roadmap
 * del web vecchio (`GET /api/projects/:id/timeline`) resta com'è.
 */

const onProject = (permission: "member" | "tickets.view_all"): RouteAccess => ({
  kind: "project",
  permission,
  project: fromParam("projectId"),
});

const beforeQuery = z.object({ before: z.iso.datetime().optional() });

export async function overviewRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/projects/:projectId/chronology",
    {
      config: { access: onProject("member") },
      schema: {
        params: z.object({ projectId: z.uuid() }),
        querystring: beforeQuery,
        response: { 200: chronologyPageSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request) =>
      projectChronology(
        app.db,
        request.params.projectId,
        { userId: request.user!.id, permissions: routePermissions(request) },
        request.query.before ? new Date(request.query.before) : undefined,
      ),
  );

  /** Il brief più recente pronto, come lo mostra l'Overview; null se non ce n'è. Come i brief: `tickets.view_all`. */
  app.get(
    "/projects/:projectId/briefs/latest",
    {
      config: { access: onProject("tickets.view_all") },
      schema: {
        params: z.object({ projectId: z.uuid() }),
        response: { 200: weeklyBriefViewSchema.nullable(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => latestWeeklyBrief(app.db, request.params.projectId),
  );

  app.get(
    "/activity/portfolio",
    {
      config: { access: { kind: "user" } },
      schema: { querystring: beforeQuery, response: { 200: chronologyPageSchema, ...authErrorResponses } },
    },
    async (request) =>
      portfolioActivity(
        app.db,
        request.user!.id,
        await projectPermissionsMap(app.db, request.user!),
        request.query.before ? new Date(request.query.before) : undefined,
      ),
  );
}
