import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteAccess } from "../auth/access.js";
import { fromParam } from "../auth/project-resolvers.js";
import { pauseProjectQueue, resumeProjectQueue } from "../services/project-queue.js";
import { roleRuleErrorSchema, sendRoleRuleError } from "./roles.js";
import { authErrorResponses } from "./shared.js";

/**
 * Area 9, F4: la pausa della coda di un progetto, per chi gestisce il progetto
 * (J-1 = a). Solo la coda di Stubwise (`services/project-queue.ts`).
 */
const MANAGE: RouteAccess = { kind: "project", permission: "project.settings.manage", project: fromParam("projectId") };
const params = z.object({ projectId: z.uuid() });

export async function projectQueueRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  for (const [path, run] of [
    ["/:projectId/queue/pause", pauseProjectQueue],
    ["/:projectId/queue/resume", resumeProjectQueue],
  ] as const) {
    app.post(
      path,
      { config: { access: MANAGE }, schema: { params, response: { 204: z.null(), 409: roleRuleErrorSchema, ...authErrorResponses } } },
      async (request, reply) => {
        try {
          await run(app.db, request.user!, request.params.projectId);
          return reply.code(204).send(null);
        } catch (error) {
          return sendRoleRuleError(reply, error);
        }
      },
    );
  }
}
