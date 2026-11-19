import { archivePreviewSchema, archiveBusyErrorSchema } from "@stubwise/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { routePermissions, type RouteAccess } from "../auth/access.js";
import { fromParam } from "../auth/project-resolvers.js";
import { ArchiveError, archivePreview, archiveProject, reopenProject } from "../services/project-archive.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Area 9, F6 (D-8): archivia e riapri, per chi gestisce il progetto
 * (`project.settings.manage`), senza riconferma come nel prototipo (si
 * tornano indietro). Archivia e riapri dichiarano `config.archived:
 * "write"`: passano anche su un archiviato, così un'archiviazione doppia
 * risponde `already_archived` e la riapertura trova il progetto.
 */
const MANAGE: RouteAccess = { kind: "project", permission: "project.settings.manage", project: fromParam("projectId") };
const params = z.object({ projectId: z.uuid() });

async function sendArchiveError(reply: FastifyReply, error: unknown): Promise<FastifyReply> {
  if (error instanceof ArchiveError) {
    return reply.code(error.status).send(error.code === "busy" ? { code: error.code, message: error.message, reasons: error.reasons } : { code: error.code, message: error.message });
  }
  throw error;
}

export async function projectArchiveRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/:projectId/archive-preview",
    { config: { access: MANAGE }, schema: { params, response: { 200: archivePreviewSchema, 404: errorSchema, ...authErrorResponses } } },
    async (request) => archivePreview(app.db, request.params.projectId, request.user!, routePermissions(request)),
  );

  app.post(
    "/:projectId/archive",
    { config: { access: MANAGE, archived: "write" }, schema: { params, response: { 204: z.null(), 404: errorSchema, 409: archiveBusyErrorSchema, ...authErrorResponses } } },
    async (request, reply) => {
      try {
        await archiveProject(app.db, request.user!, request.params.projectId, routePermissions(request));
        return await reply.code(204).send(null);
      } catch (error) {
        return sendArchiveError(reply, error);
      }
    },
  );

  app.post(
    "/:projectId/reopen",
    { config: { access: MANAGE, archived: "write" }, schema: { params, response: { 204: z.null(), 404: errorSchema, 409: errorSchema, ...authErrorResponses } } },
    async (request, reply) => {
      try {
        await reopenProject(app.db, request.user!, request.params.projectId);
        return await reply.code(204).send(null);
      } catch (error) {
        return sendArchiveError(reply, error);
      }
    },
  );
}
