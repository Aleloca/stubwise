import { widgetSettingsSchema } from "@stubwise/shared";
import { and, asc, desc, eq, exists, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import {
  projects,
  repositories,
  widgetConversations,
  widgetMessages,
  widgetSettings,
} from "@stubwise/db";
import { authErrorResponses, errorSchema } from "./shared.js";
import { apiError } from "../errors.js";

const idParamsSchema = z.object({ projectId: z.uuid() });

/** Default e tetto del `limit` dell'elenco conversazioni del viewer interno. */
const CONVERSATIONS_LIMIT_DEFAULT = 50;
const CONVERSATIONS_LIMIT_MAX = 200;

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

  // ── Viewer read-only delle conversazioni del widget (superficie SPA) ──────

  const conversationSummarySchema = z.object({
    id: z.uuid(),
    externalUserId: z.string(),
    externalUserEmail: z.string().nullable(),
    externalUserName: z.string().nullable(),
    createdAt: z.iso.datetime(),
    lastMessageAt: z.iso.datetime(),
    messageCount: z.number().int(),
    ticketCount: z.number().int(),
  });

  /**
   * Elenco delle conversazioni widget di un progetto per il viewer interno,
   * ordinato per lastMessageAt desc. messageCount/ticketCount sono aggregati IN
   * UNA query (LEFT JOIN + GROUP BY, niente N+1): ticketCount conta i messaggi
   * con ticketId non nullo via `count(...) filter (where ...)`. Con `ticketId`
   * in query si restringe alla sola conversazione che contiene un messaggio con
   * quel ticket (link "Vedi conversazione" dal ticket).
   */
  app.get(
    "/:projectId/widget/conversations",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        querystring: z.object({
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(CONVERSATIONS_LIMIT_MAX)
            .default(CONVERSATIONS_LIMIT_DEFAULT),
          ticketId: z.uuid().optional(),
        }),
        response: {
          200: z.object({ conversations: z.array(conversationSummarySchema) }),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const { limit, ticketId } = request.query;

      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      // Con `ticketId`: solo la conversazione che contiene un messaggio con quel
      // ticket, tramite subquery EXISTS (il messaggio col ticket determina la
      // conversazione; i conteggi restano sull'intero filo).
      const ticketFilter = ticketId
        ? exists(
            app.db
              .select({ one: sql`1` })
              .from(widgetMessages)
              .where(
                and(
                  eq(widgetMessages.conversationId, widgetConversations.id),
                  eq(widgetMessages.ticketId, ticketId),
                ),
              ),
          )
        : undefined;

      const rows = await app.db
        .select({
          id: widgetConversations.id,
          externalUserId: widgetConversations.externalUserId,
          externalUserEmail: widgetConversations.externalUserEmail,
          externalUserName: widgetConversations.externalUserName,
          createdAt: widgetConversations.createdAt,
          lastMessageAt: widgetConversations.lastMessageAt,
          messageCount: sql<number>`count(${widgetMessages.id})::int`,
          ticketCount: sql<number>`(count(${widgetMessages.id}) filter (where ${widgetMessages.ticketId} is not null))::int`,
        })
        .from(widgetConversations)
        // LEFT JOIN: le conversazioni senza messaggi restano in elenco (count 0).
        .leftJoin(widgetMessages, eq(widgetMessages.conversationId, widgetConversations.id))
        .where(and(eq(widgetConversations.projectId, projectId), ticketFilter))
        .groupBy(widgetConversations.id)
        // Tiebreaker sull'id: ordine stabile al bordo del limit a parità di lastMessageAt.
        .orderBy(desc(widgetConversations.lastMessageAt), desc(widgetConversations.id))
        .limit(limit);

      return {
        conversations: rows.map((r) => ({
          id: r.id,
          externalUserId: r.externalUserId,
          externalUserEmail: r.externalUserEmail,
          externalUserName: r.externalUserName,
          createdAt: r.createdAt.toISOString(),
          lastMessageAt: r.lastMessageAt.toISOString(),
          messageCount: r.messageCount,
          ticketCount: r.ticketCount,
        })),
      };
    },
  );

  const conversationMessageSchema = z.object({
    id: z.uuid(),
    role: z.string(),
    content: z.string(),
    // Riferimenti Docs della risposta RAG: forma libera (jsonb), può essere null.
    citations: z.unknown().nullable(),
    ticketId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  });

  /**
   * Filo completo di una conversazione per il viewer interno, in ordine
   * cronologico (tiebreaker asc(id) come la superficie pubblica: due messaggi
   * ravvicinati con lo stesso createdAt hanno un ordine stabile). 404 se la
   * conversazione non appartiene al progetto (isolamento cross-progetto).
   */
  app.get(
    "/:projectId/widget/conversations/:conversationId/messages",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ projectId: z.uuid(), conversationId: z.uuid() }),
        response: {
          200: z.object({
            conversation: z.object({
              id: z.uuid(),
              externalUserId: z.string(),
              externalUserEmail: z.string().nullable(),
              externalUserName: z.string().nullable(),
              createdAt: z.iso.datetime(),
            }),
            messages: z.array(conversationMessageSchema),
          }),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, conversationId } = request.params;

      const [conversation] = await app.db
        .select({
          id: widgetConversations.id,
          externalUserId: widgetConversations.externalUserId,
          externalUserEmail: widgetConversations.externalUserEmail,
          externalUserName: widgetConversations.externalUserName,
          createdAt: widgetConversations.createdAt,
        })
        .from(widgetConversations)
        .where(
          and(
            eq(widgetConversations.id, conversationId),
            eq(widgetConversations.projectId, projectId),
          ),
        );
      // Conversazione inesistente o di un altro progetto: 404 (isolamento).
      if (!conversation) {
        return apiError(reply, 404, "conversation_not_found", "Conversation not found");
      }

      const rows = await app.db
        .select({
          id: widgetMessages.id,
          role: widgetMessages.role,
          content: widgetMessages.content,
          citations: widgetMessages.citations,
          ticketId: widgetMessages.ticketId,
          createdAt: widgetMessages.createdAt,
        })
        .from(widgetMessages)
        .where(eq(widgetMessages.conversationId, conversationId))
        // Tiebreaker su `id` come la superficie pubblica: ordine deterministico
        // per messaggi con lo stesso createdAt (user+assistant ravvicinati).
        .orderBy(asc(widgetMessages.createdAt), asc(widgetMessages.id));

      return {
        conversation: {
          id: conversation.id,
          externalUserId: conversation.externalUserId,
          externalUserEmail: conversation.externalUserEmail,
          externalUserName: conversation.externalUserName,
          createdAt: conversation.createdAt.toISOString(),
        },
        messages: rows.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          citations: m.citations ?? null,
          ticketId: m.ticketId,
          createdAt: m.createdAt.toISOString(),
        })),
      };
    },
  );
}
