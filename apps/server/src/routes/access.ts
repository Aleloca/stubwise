import { INSTANCE_PERMISSIONS, PROJECT_PERMISSIONS, whatCanResponseSchema, whoCanResponseSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { whatCan, whoCan } from "../services/access-query.js";
import { sendRoleRuleError } from "./roles.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Area 9, F1 (design 1.7, D-11): «Chi può farlo?» e «Cosa può fare?», sotto
 * `/api/access`. Le regole: `services/access-query.ts`.
 */
const permissionSchema = z.enum([...INSTANCE_PERMISSIONS, ...PROJECT_PERMISSIONS]);

export async function accessRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/who-can",
    {
      config: { access: { kind: "user" } },
      schema: {
        querystring: z.object({ permission: permissionSchema, projectId: z.uuid().optional() }),
        response: { 200: whoCanResponseSchema, ...authErrorResponses, 404: errorSchema, 422: errorSchema },
      },
    },
    async (request, reply) => {
      try {
        return await whoCan(app.db, request.user!, request.query.permission, request.query.projectId ?? null);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  app.get(
    "/what-can",
    {
      config: { access: { kind: "user" } },
      schema: {
        querystring: z.object({ userId: z.uuid(), projectId: z.uuid().optional() }),
        response: { 200: whatCanResponseSchema, ...authErrorResponses, 404: errorSchema },
      },
    },
    async (request, reply) => {
      try {
        return await whatCan(app.db, request.user!, request.query.userId, request.query.projectId ?? null);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );
}
