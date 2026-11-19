import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ingestionKeyResultSchema, projectIntegrationSchema, webhookSecretResultSchema } from "@stubwise/shared";
import { z } from "zod";
import { fromParam, repositoryAccess } from "../auth/project-resolvers.js";
import { projectIntegration, regenerateIngestionKey, regenerateWebhookSecret } from "../services/project-secrets.js";
import { routePermissions } from "../auth/access.js";
import { roleRuleErrorSchema, sendRoleRuleError } from "./roles.js";
import { authErrorResponses } from "./shared.js";

/**
 * Area 9, F5: le rigenerazioni (riconferma; il valore nuovo nella risposta,
 * UNA volta). Le regole in `services/project-secrets.ts`.
 */
export async function projectSecretRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // L'Integrazione in lettura (I2): chi vede il progetto, come la sezione del
  // web vecchio; nessun valore intero.
  app.get(
    "/projects/:projectId/integration",
    {
      config: { access: { kind: "project", permission: "member", project: fromParam("projectId") } },
      schema: { params: z.object({ projectId: z.uuid() }), response: { 200: projectIntegrationSchema, 404: roleRuleErrorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      try {
        return await projectIntegration(app.db, request.params.projectId, routePermissions(request), app.publicUrl);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  app.post(
    "/projects/:projectId/ingestion-key",
    {
      config: { access: { kind: "project", permission: "project.settings.manage", project: fromParam("projectId") }, reauth: true },
      schema: { params: z.object({ projectId: z.uuid() }), response: { 200: ingestionKeyResultSchema, 404: roleRuleErrorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      try {
        // Il valore nuovo non resta in nessuna cache intermedia.
        reply.header("cache-control", "no-store");
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
        reply.header("cache-control", "no-store");
        return await regenerateWebhookSecret(app.db, app.encryptionKey, request.user!, request.params.slug, app.publicUrl, (error) =>
          // Il messaggio dell'errore del DB, mai il segreto (non ci passa).
          request.log.error({ err: error }, "webhook secret: la scrittura nel DB è fallita dopo l'aggiornamento della piattaforma"),
        );
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );
}
