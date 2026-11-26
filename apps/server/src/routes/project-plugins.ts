import { projectPluginRegistryRowSchema, projectPluginSchema, putProjectPluginsSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteAccess } from "../auth/access.js";
import { fromParam } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import { getProjectPlugins, projectPluginRegistry, projectPluginsVersion, putProjectPlugins } from "../services/plugins.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const paramsSchema = z.object({ projectId: z.uuid() });

/** Risposta di GET e PUT: la stessa forma del body del PUT, così fa round-trip. */
const projectPluginsSchema = z.object({
  plugins: z.array(projectPluginSchema),
  version: z.string(),
  registry: z.array(projectPluginRegistryRowSchema),
  /** Dalla review di F5: chi la legge può salvarla (`project.settings.manage`), lo calcola il server. */
  canEdit: z.boolean(),
});
/** Area 9, F5: `ifMatch` facoltativo (il web vecchio non lo manda: per lui resta l'ultima scrittura che vince). */
const putBodySchema = putProjectPluginsSchema.extend({ ifMatch: z.string().min(1).optional() });
const staleSchema = errorSchema.extend({ version: z.string(), plugins: z.array(projectPluginSchema) });

/**
 * Abilitazioni dei plugin su un progetto, sotto /api/projects/:projectId/plugins.
 *
 * Il PUT vuole `project.settings.manage` nel progetto: decidere quali skill
 * di terze parti girano nei run di un progetto è una scelta da maintainer.
 * La LETTURA (dalla review di F5) è di chi vede il progetto, in sola lettura
 * con `canEdit: false`: il registro gli arriva con nome, skill, gruppi di
 * hook e stato, senza il preset consigliato (serve solo a chi salva).
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

const READ_ACCESS: RouteAccess = { kind: "project", permission: "member", project: fromParam("projectId") };

export async function projectPluginRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/:projectId/plugins",
    {
      config: { access: READ_ACCESS },
      schema: {
        params: paramsSchema,
        response: { 200: projectPluginsSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      const plugins = await getProjectPlugins(app.db, projectId);
      const canEdit = request.access!.permissions.has("project.settings.manage");
      // Area 9, F5: anche il registro, per chi non ha `plugins.manage` d'istanza.
      const registry = await projectPluginRegistry(app.db, { withHookCommands: canEdit });
      return {
        plugins,
        version: projectPluginsVersion(plugins),
        registry: canEdit ? registry : registry.map((row) => ({ ...row, recommendedDisabledSkills: [] })),
        canEdit,
      };
    },
  );

  app.put(
    "/:projectId/plugins",
    {
      config: { access: ACCESS },
      schema: {
        params: paramsSchema,
        body: putBodySchema,
        response: {
          200: projectPluginsSchema,
          400: errorSchema,
          409: staleSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const result = await putProjectPlugins(app.db, projectId, request.body.plugins, { actor: request.user!, ifMatch: request.body.ifMatch });
      if (!result.ok && result.error === "stale") {
        return reply.code(409).send({ code: "stale", message: "The plugin choices changed since you loaded them", version: result.version, plugins: result.plugins });
      }
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
      return { plugins: result.plugins, version: projectPluginsVersion(result.plugins), registry: await projectPluginRegistry(app.db, { withHookCommands: true }), canEdit: true };
    },
  );
}
