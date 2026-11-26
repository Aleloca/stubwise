import { pluginRegistrySchema } from "@stubwise/shared";
import {
  pluginInventorySchema,
  pluginSchema,
  createPluginSchema,
  updatePluginRefSchema,
  RECOMMENDED_DISABLED_SKILLS,
  type Plugin,
} from "@stubwise/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import {
  createPlugin,
  deletePlugin,
  getPlugin,
  listPlugins,
  requestSmoke,
  requestUpdate,
  type PluginWithPendingJob,
} from "../services/plugins.js";
import { authErrorResponses, errorSchema } from "./shared.js";
import { users, type Db } from "@stubwise/db";
import { inArray } from "drizzle-orm";
import { registerPersonMask } from "../services/people-known.js";

const idParamsSchema = z.object({ id: z.uuid() });

/** Elenco del registro + i preset consigliati (statici, li usa la UI). */

/**
 * Proiezione pubblica di un plugin: campi elencati esplicitamente (mai spread
 * della riga) e date in ISO.
 *
 * `inventory` viene ri-validato invece di essere passato così com'è: è un jsonb
 * scritto dal worker, potenzialmente da una versione precedente del formato, e
 * un inventario illeggibile deve degradare a `null` — non far fallire in
 * serializzazione l'INTERA lista del registro.
 */
/** I nomi di chi ha registrato e aggiornato i plugin dati, in una query (rimandi, lotto 5). */
async function peopleNames(db: Db, rows: readonly PluginWithPendingJob[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((r) => [r.registeredByUserId, r.updatedByUserId]).filter((x): x is string => x !== null))];
  if (ids.length === 0) return new Map();
  const people = await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(inArray(users.id, ids));
  return new Map(people.map((p) => [p.id, p.displayName?.trim() || p.email.split("@")[0]!]));
}

function toPublicPlugin(row: PluginWithPendingJob, names: ReadonlyMap<string, string> = new Map()): Plugin {
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
    pendingJobKind: row.pendingJobKind,
    registeredById: row.registeredByUserId,
    registeredByName: row.registeredByUserId ? (names.get(row.registeredByUserId) ?? null) : null,
    updatedById: row.updatedByUserId,
    updatedByName: row.updatedByUserId ? (names.get(row.updatedByUserId) ?? null) : null,
    materializedAt: row.materializedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Area 9, F3 ([IN 2]): registrare un plugin o cambiarne il ref ne ESEGUE il
 * codice (lo smoke run parte da solo), quindi il corpo dice «Mi fido»
 * (`trust: true`). Senza: 422, e niente registrato.
 */
function trustRequired(reply: FastifyReply) {
  return apiError(reply, 422, "trust_required", "Registering a plugin runs its code: confirm you trust it");
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
  // Chi ha registrato o aggiornato (rimandi, lotto 5): un segnaposto, e il nome null, a chi non lo conosce (r.1414).
  registerPersonMask(app, new Set(["registeredById", "updatedById"]));

  app.get(
    "/",
    {
      config: { access: { kind: "instance", permission: "plugins.manage" } },
      schema: { response: { 200: pluginRegistrySchema, ...authErrorResponses } },
    },
    async () => {
      const rows = await listPlugins(app.db);
      const names = await peopleNames(app.db, rows);
      return { plugins: rows.map((r) => toPublicPlugin(r, names)), recommendations: RECOMMENDED_DISABLED_SKILLS };
    },
  );

  app.post(
    "/",
    {
      config: { access: { kind: "instance", permission: "plugins.manage" }, reauth: true },
      schema: {
        // Validazione dallo schema condiviso: un URL malformato o con
        // credenziali è un 400 di Fastify, mai un 500 di un `parse` a mano.
        // Area 9, F3 ([IN 2]): «Mi fido» — registrare ne ESEGUE il codice.
        body: createPluginSchema.extend({ trust: z.boolean().optional() }),
        response: {
          201: pluginSchema,
          400: errorSchema,
          409: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      if (request.body.trust !== true) return trustRequired(reply);
      const { sourceUrl, ref, sourceSubdir } = request.body;
      const result = await createPlugin(app.db, { sourceUrl, ref, ...(sourceSubdir !== undefined ? { sourceSubdir } : {}) }, request.user!);
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
      return reply.code(201).send(toPublicPlugin(result.plugin, await peopleNames(app.db, [result.plugin])));
    },
  );

  app.get(
    "/:id",
    {
      config: { access: { kind: "instance", permission: "plugins.manage" } },
      schema: {
        params: idParamsSchema,
        response: { 200: pluginSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const row = await getPlugin(app.db, request.params.id);
      if (!row) return apiError(reply, 404, "plugin_not_found", "Plugin not found");
      return toPublicPlugin(row, await peopleNames(app.db, [row]));
    },
  );

  // Aggiornamento al ref indicato: cambia il pin richiesto e riaccoda la
  // materializzazione. 202 perché il lavoro vero lo fa il worker.
  app.post(
    "/:id/update",
    {
      config: { access: { kind: "instance", permission: "plugins.manage" }, reauth: true },
      schema: {
        params: idParamsSchema,
        body: updatePluginRefSchema.extend({ trust: z.boolean().optional() }),
        response: {
          202: z.object({ queued: z.literal(true) }),
          404: errorSchema,
          409: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      // Un ref nuovo è codice nuovo che il worker eseguirà: «Mi fido» anche qui.
      if (request.body.trust !== true) return trustRequired(reply);
      const result = await requestUpdate(app.db, request.params.id, request.body.ref, request.user!);
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
      config: { access: { kind: "instance", permission: "plugins.manage" } },
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
      const result = await requestSmoke(app.db, request.params.id, request.user!);
      if (!result.ok) {
        if (result.error === "not_found") {
          return apiError(reply, 404, "plugin_not_found", "Plugin not found");
        }
        if (result.error === "not_ready") {
          return apiError(
            reply,
            409,
            "plugin_not_ready",
            "The plugin is not currently ready: there is no materialized revision to smoke-test",
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
      config: { access: { kind: "instance", permission: "plugins.manage" } },
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await deletePlugin(app.db, request.params.id, request.user!);
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
