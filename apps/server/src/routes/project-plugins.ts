import { projectPluginSchema, putProjectPluginsSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteAccess } from "../auth/access.js";
import { fromParam } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import { getProjectPlugins, putProjectPlugins } from "../services/plugins.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const paramsSchema = z.object({ projectId: z.uuid() });

/** Risposta di GET e PUT: la stessa forma del body del PUT, così fa round-trip. */
const projectPluginsSchema = z.object({ plugins: z.array(projectPluginSchema) });

/**
 * Abilitazioni dei plugin su un progetto, sotto /api/projects/:projectId/plugins.
 *
 * `project.settings.manage` nel progetto (lettura inclusa): decidere quali
 * skill di terze parti girano nei run di un progetto è una scelta da
 * maintainer.
 *
 * Il PUT sostituisce l'INSIEME COMPLETO (i plugin assenti dal body risultano
 * non abilitati): la UI ha davanti tutto il registro e salva la foto intera,
 * quindi un PATCH per-plugin inviterebbe solo a stati parziali incoerenti.
 */
const ACCESS: RouteAccess = {
  kind: "project",
  permission: "project.settings.manage",
  project: fromParam("projectId"),
};

export async function projectPluginRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/:projectId/plugins",
    {
      config: { access: ACCESS },
      schema: {
        params: paramsSchema,
        response: { 200: projectPluginsSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      return { plugins: await getProjectPlugins(app.db, projectId) };
    },
  );

  app.put(
    "/:projectId/plugins",
    {
      config: { access: ACCESS },
      schema: {
        params: paramsSchema,
        body: putProjectPluginsSchema,
        response: {
          200: projectPluginsSchema,
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const result = await putProjectPlugins(app.db, projectId, request.body.plugins);
      if (!result.ok) {
        // 400 e non tolleranza: uno spegnimento che cita una voce inesistente è
        // un refuso che, salvato in silenzio, lascerebbe accesa una skill che
        // l'admin crede spenta.
        const message =
          result.error === "unknown_plugin"
            ? `Unknown plugin: ${result.detail}`
            : result.error === "unknown_plugin_skill"
              ? `Unknown skill in the plugin inventory (${result.detail})`
              : `Unknown hook in the plugin inventory (${result.detail})`;
        return apiError(reply, 400, result.error, message);
      }
      return { plugins: result.plugins };
    },
  );
}
