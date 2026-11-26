import { CHANGE_LOG_KINDS, changeLogFiltersSchema, changeLogPageSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { changeLogFilters, listChanges, listProjectChanges } from "../services/change-log-read.js";
import { fromParam } from "../auth/project-resolvers.js";
import { sendRoleRuleError } from "./roles.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Area 9, F2: leggere il registro delle modifiche. Le regole stanno in
 * `services/change-log-read.ts`, nella WHERE.
 */
const filterSchema = z.object({
  person: z.uuid().optional(),
  type: z.enum(CHANGE_LOG_KINDS).optional(),
  group: z.string().max(40).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  withinDays: z.coerce.number().int().min(1).max(3650).optional(),
  cursor: z.string().max(200).optional(),
  // Area 9, F7: le sole voci scritte da Claude («By Claude»).
  via: z.literal("claude").optional(),
});

export async function changeLogRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/change-log",
    {
      config: { access: { kind: "user" }, mcp: { action: "changeLog.list", summary: "Il registro delle modifiche dell'istanza, con filtri per chi, cosa e quando.", effect: "read" } },
      schema: {
        querystring: filterSchema.extend({ project: z.union([z.uuid(), z.literal("instance")]).optional() }),
        response: { 200: changeLogPageSchema, ...authErrorResponses, 400: errorSchema },
      },
    },
    async (request, reply) => {
      try {
        return await listChanges(app.db, request.user!, request.query);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  app.get(
    "/change-log/filters",
    {
      config: { access: { kind: "user" }, mcp: { action: "changeLog.filters", summary: "Le scelte possibili per i filtri del registro delle modifiche.", effect: "read" } },
      schema: { querystring: z.object({ project: z.uuid().optional() }), response: { 200: changeLogFiltersSchema, ...authErrorResponses, 404: errorSchema } },
    },
    async (request, reply) => {
      try {
        return await changeLogFilters(app.db, request.user!, request.query.project);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  app.get(
    "/projects/:projectId/change-log",
    {
      config: { access: { kind: "project", permission: "member", project: fromParam("projectId") }, mcp: { action: "changeLog.project", summary: "Il registro delle modifiche di un progetto.", effect: "read" } },
      schema: {
        params: z.object({ projectId: z.uuid() }),
        querystring: filterSchema,
        response: { 200: changeLogPageSchema, ...authErrorResponses, 400: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      try {
        return await listProjectChanges(app.db, request.user!, request.params.projectId, request.query);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );
}
