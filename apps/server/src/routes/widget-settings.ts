import { widgetSettingsSchema } from "@stubwise/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { projects, repositories, widgetSettings } from "@stubwise/db";
import { authErrorResponses, errorSchema } from "./shared.js";
import { apiError } from "../errors.js";

const idParamsSchema = z.object({ projectId: z.uuid() });

type WidgetSettingsRow = typeof widgetSettings.$inferSelect;

/**
 * Proiezione delle impostazioni widget: campi elencati esplicitamente, mai
 * spread della riga (che porta `projectId`, interno all'API). Combacia con
 * `widgetSettingsSchema` di @stubwise/shared, la forma attesa dal form della SPA.
 */
function toPublicSettings(row: WidgetSettingsRow): z.infer<typeof widgetSettingsSchema> {
  return {
    enabled: row.enabled,
    enabledRepositoryIds: row.enabledRepositoryIds,
    title: row.title,
    welcomeMessage: row.welcomeMessage,
    accentColor: row.accentColor,
    language: widgetSettingsSchema.shape.language.parse(row.language),
  };
}

/**
 * API INTERNA delle impostazioni del widget di assistenza, sotto
 * /api/projects/:projectId/widget-settings. Superficie della SPA (sessione
 * cookie), distinta dalla superficie pubblica /widget. Lettura per ogni utente
 * autenticato; scrittura solo admin, come le altre impostazioni di progetto.
 */
export async function widgetSettingsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/:projectId/widget-settings",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: {
          200: widgetSettingsSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      const [row] = await app.db
        .select()
        .from(widgetSettings)
        .where(eq(widgetSettings.projectId, projectId));
      // Nessuna riga = mai configurato: si restituiscono i default dello schema
      // shared senza materializzare la riga (lo fa la prima PUT).
      if (!row) return widgetSettingsSchema.parse({});
      return toPublicSettings(row);
    },
  );

  app.put(
    "/:projectId/widget-settings",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: widgetSettingsSchema,
        response: {
          200: widgetSettingsSchema,
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const settings = request.body;

      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      // Ogni id in enabledRepositoryIds deve essere un repository DI QUESTO
      // progetto: un id esistente ma di un altro progetto (o inesistente) è un
      // 422, non un salvataggio silenzioso di un filtro che non retrieverà mai.
      if (settings.enabledRepositoryIds.length > 0) {
        const rows = await app.db
          .select({ id: repositories.id })
          .from(repositories)
          .where(
            and(
              eq(repositories.projectId, projectId),
              inArray(repositories.id, settings.enabledRepositoryIds),
            ),
          );
        const valid = new Set(rows.map((r) => r.id));
        const foreign = settings.enabledRepositoryIds.filter((id) => !valid.has(id));
        if (foreign.length > 0) {
          return apiError(
            reply,
            422,
            "invalid_repository",
            "enabledRepositoryIds must reference repositories of this project",
          );
        }
      }

      const [row] = await app.db
        .insert(widgetSettings)
        .values({ projectId, ...settings })
        .onConflictDoUpdate({ target: widgetSettings.projectId, set: settings })
        .returning();
      if (!row) throw new Error("upsert delle impostazioni widget non ha restituito la riga");
      return toPublicSettings(row);
    },
  );
}
