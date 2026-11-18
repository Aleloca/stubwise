import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ingestionKeyResultSchema, webhookSecretResultSchema } from "@stubwise/shared";
import { z } from "zod";
import { fromParam, repositoryAccess } from "../auth/project-resolvers.js";
import { regenerateIngestionKey, regenerateWebhookSecret } from "../services/project-secrets.js";
import { roleRuleErrorSchema, sendRoleRuleError } from "./roles.js";
import { authErrorResponses } from "./shared.js";

/**
 * Area 9, F5: le rigenerazioni (riconferma; il valore nuovo nella risposta,
 * UNA volta). Le regole in `services/project-secrets.ts`.
 */
export async function projectSecretRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/projects/:projectId/ingestion-key",
    {
      config: { access: { kind: "project", permission: "project.settings.manage", project: fromParam("projectId") }, reauth: true },
      schema: { params: z.object({ projectId: z.uuid() }), response: { 200: ingestionKeyResultSchema, 404: roleRuleErrorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      try {
        return await regenerateIngestionKey(app.db, request.user!, request.params.projectId);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  app.post(
    "/repositories/:slug/webhook-secret",
    {
      config: { access: repositoryAccess("slug", "repos.manage"), reauth: true },
      schema: {
        params: z.object({ slug: z.string().min(1) }),
        response: {
          200: webhookSecretResultSchema,
          400: roleRuleErrorSchema,
          404: roleRuleErrorSchema,
          422: roleRuleErrorSchema,
          502: roleRuleErrorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      try {
        return await regenerateWebhookSecret(app.db, app.encryptionKey, request.user!, request.params.slug, app.publicUrl);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );
}
