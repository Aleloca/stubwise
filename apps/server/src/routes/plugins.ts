import {
  pluginInventorySchema,
  pluginSchema,
  createPluginSchema,
  pluginRecommendationsSchema,
  updatePluginRefSchema,
  RECOMMENDED_DISABLED_SKILLS,
  type Plugin,
} from "@stubwise/shared";
import type { PluginRow } from "@stubwise/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin } from "../auth/session.js";
import { apiError } from "../errors.js";
import {
  createPlugin,
  deletePlugin,
  getPlugin,
  listPlugins,
  requestSmoke,
  requestUpdate,
} from "../services/plugins.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const idParamsSchema = z.object({ id: z.uuid() });

/** Elenco del registro + i preset consigliati (statici, li usa la UI). */
const registrySchema = z.object({
  plugins: z.array(pluginSchema),
  /**
   * Raccomandazioni per plugin noti, indicizzate per `inventory.name`. Viaggiano
   * col GET invece di stare in un endpoint suo: sono poche righe statiche e la
   * pagina che le usa è la stessa che carica il registro.
   */
  recommendations: pluginRecommendationsSchema,
});

/**
 * Proiezione pubblica di un plugin: campi elencati esplicitamente (mai spread
 * della riga) e date in ISO.
 *
 * `inventory` viene ri-validato invece di essere passato così com'è: è un jsonb
 * scritto dal worker, potenzialmente da una versione precedente del formato, e
 * un inventario illeggibile deve degradare a `null` — non far fallire in
 * serializzazione l'INTERA lista del registro.
 */
function toPublicPlugin(row: PluginRow): Plugin {
  const inventory = pluginInventorySchema.safeParse(row.inventory);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    sourceUrl: row.sourceUrl,
    sourceSubdir: row.sourceSubdir,
    ref: row.ref,
    resolvedSha: row.resolvedSha,
    status: row.status,
    inventory: inventory.success ? inventory.data : null,
    error: row.error,
    smokeStatus: row.smokeStatus,
    smokeError: row.smokeError,
    materializedAt: row.materializedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Route del REGISTRO PLUGIN d'istanza, sotto /api/plugins. Tutte solo admin:
 * un plugin è codice di terze parti che finisce nei run dell'agente, quindi
 * anche solo LEGGERE il registro (che mostra i comandi degli hook) è
 * un'operazione da maintainer.
 *
 * Le azioni non fanno nulla in linea: il server non monta il volume dei plugin,
 * accoda un job in `plugin_jobs` e risponde 202 — è il poller del worker a
 * fare fetch, validate, inventario e smoke. Il 409 sui job in volo arriva
 * dall'indice unico parziale `plugin_jobs_active_unique`, non da una select
 * preventiva che avrebbe una corsa.
 */
export async function pluginRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAdmin,
      schema: { response: { 200: registrySchema, ...authErrorResponses } },
    },
    async () => ({
      plugins: (await listPlugins(app.db)).map(toPublicPlugin),
      recommendations: RECOMMENDED_DISABLED_SKILLS,
    }),
  );

  app.post(
    "/",
    {
      preHandler: requireAdmin,
      schema: {
        // Validazione dallo schema condiviso: un URL malformato o con
        // credenziali è un 400 di Fastify, mai un 500 di un `parse` a mano.
        body: createPluginSchema,
        response: {
          201: pluginSchema,
          400: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await createPlugin(app.db, request.body);
      if (!result.ok) {
        if (result.error === "invalid_slug") {
          return apiError(
            reply,
            400,
            "invalid_plugin_slug",
            "Cannot derive a valid plugin slug from this source URL or subdirectory",
          );
        }
        return apiError(
          reply,
          409,
          "plugin_slug_taken",
          `A plugin with slug "${result.slug}" is already registered`,
        );
      }
      return reply.code(201).send(toPublicPlugin(result.plugin));
    },
  );

  app.get(
    "/:id",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: { 200: pluginSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const row = await getPlugin(app.db, request.params.id);
      if (!row) return apiError(reply, 404, "plugin_not_found", "Plugin not found");
      return toPublicPlugin(row);
    },
  );

  // Aggiornamento al ref indicato: cambia il pin richiesto e riaccoda la
  // materializzazione. 202 perché il lavoro vero lo fa il worker.
  app.post(
    "/:id/update",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: updatePluginRefSchema,
        response: {
          202: z.object({ queued: z.literal(true) }),
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await requestUpdate(app.db, request.params.id, request.body.ref);
      if (!result.ok) {
        if (result.error === "not_found") {
          return apiError(reply, 404, "plugin_not_found", "Plugin not found");
        }
        return apiError(
          reply,
          409,
          "plugin_job_pending",
          "A materialize job is already queued or running for this plugin",
        );
      }
      return reply.code(202).send({ queued: true as const });
    },
  );

  app.post(
    "/:id/smoke",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: {
          202: z.object({ queued: z.literal(true) }),
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await requestSmoke(app.db, request.params.id);
      if (!result.ok) {
        if (result.error === "not_found") {
          return apiError(reply, 404, "plugin_not_found", "Plugin not found");
        }
        if (result.error === "not_ready") {
          return apiError(
            reply,
            409,
            "plugin_not_ready",
            "The plugin has never been materialized: there is no revision to smoke-test",
          );
        }
        return apiError(
          reply,
          409,
          "plugin_job_pending",
          "A smoke job is already queued or running for this plugin",
        );
      }
      return reply.code(202).send({ queued: true as const });
    },
  );

  app.delete(
    "/:id",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await deletePlugin(app.db, request.params.id);
      if (!result.ok) {
        if (result.error === "not_found") {
          return apiError(reply, 404, "plugin_not_found", "Plugin not found");
        }
        return apiError(
          reply,
          409,
          "plugin_in_use",
          "The plugin is enabled on at least one project: disable it there first",
        );
      }
      return reply.code(204).send(null);
    },
  );
}
