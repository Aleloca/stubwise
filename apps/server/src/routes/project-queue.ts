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
  /** Le voci del catalogo dell'MCP (lotto 5 della parità). */
  const PAUSE_MCP = {
    action: "projects.pauseQueue",
    summary: "Mette in pausa la coda AI di un progetto: i lavori nuovi aspettano, quelli partiti finiscono.",
    effect: "write",
    note: "Ferma i run di TUTTI nel progetto finché non si riprende.",
  } as const;
  const RESUME_MCP = { action: "projects.resumeQueue", summary: "Riprende la coda AI di un progetto in pausa.", effect: "write" } as const;
  for (const [path, run, mcp] of [
    ["/:projectId/queue/pause", pauseProjectQueue, PAUSE_MCP],
    ["/:projectId/queue/resume", resumeProjectQueue, RESUME_MCP],
  ] as const) {
    app.post(
      path,
      { config: { access: MANAGE, mcp }, schema: { params, response: { 204: z.null(), 409: roleRuleErrorSchema, ...authErrorResponses } } },
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
