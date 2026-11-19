import { archivedProjectRowSchema, archivedProjectViewSchema, archivePreviewSchema, archiveBusyErrorSchema, deletionPreviewSchema } from "@stubwise/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { routePermissions, type RouteAccess } from "../auth/access.js";
import { fromParam } from "../auth/project-resolvers.js";
import { ArchiveError, archivedProjectView, archivePreview, archiveProject, deletionPreview, listArchivedProjects, reopenProject } from "../services/project-archive.js";
import { apiError } from "../errors.js";
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

  // Letterale: registrata prima di ogni rotta `/:projectId` di questo plugin
  // (la trappola di routing di CLAUDE.md). Per i membri di allora e i full
  // admin, dal più recente; un estraneo riceve la lista vuota.
  app.get(
    "/archived",
    { config: { access: { kind: "user" } }, schema: { response: { 200: z.array(archivedProjectRowSchema), ...authErrorResponses } } },
    async (request) => listArchivedProjects(app.db, request.user!),
  );

  // La pagina dell'archiviato: passa su un archiviato (`config.archived:
  // "read"`), per chi ne era membro e per i full admin; un progetto aperto è
  // 404 come uno che non c'è.
  app.get(
    "/:projectId/archived-view",
    {
      config: { access: { kind: "project", permission: "member", project: fromParam("projectId") }, archived: "read" },
      schema: { params, response: { 200: archivedProjectViewSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const view = await archivedProjectView(app.db, request.user!, request.params.projectId);
      if (!view) return apiError(reply, 404, "not_found", "Not found");
      return view;
    },
  );

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

  // Cosa toglie Delete: solo un full admin, solo su un archiviato (409
  // `not_archived` su un aperto).
  app.get(
    "/:projectId/deletion-preview",
    {
      config: { access: { kind: "project", permission: "member", project: fromParam("projectId") }, archived: "read" },
      schema: { params, response: { 200: deletionPreviewSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      if (!request.user!.instancePermissions.has("instance.full_admin")) return apiError(reply, 403, "forbidden", "Only a full admin can delete a project");
      try {
        return await deletionPreview(app.db, request.params.projectId);
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
