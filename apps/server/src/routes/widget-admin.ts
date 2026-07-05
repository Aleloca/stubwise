import { widgetUpsertBodySchema } from "@stubwise/shared";
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
  widgets,
} from "@stubwise/db";
import { authErrorResponses, errorSchema, generateIngestionKey } from "./shared.js";
import { apiError } from "../errors.js";

const idParamsSchema = z.object({ projectId: z.uuid() });
const widgetParamsSchema = z.object({ projectId: z.uuid(), widgetId: z.uuid() });

/** Default e tetto del `limit` dell'elenco conversazioni del viewer interno. */
const CONVERSATIONS_LIMIT_DEFAULT = 50;
const CONVERSATIONS_LIMIT_MAX = 200;

/**
 * Proiezione pubblica (superficie SPA interna) di un widget. La `key` È esposta:
 * serve allo snippet di embed, e questa superficie è autenticata (sessione
 * cookie). Campi elencati esplicitamente, mai spread della riga (che porterebbe
 * `projectId`, interno all'API).
 */
const widgetSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  key: z.string(),
  enabled: z.boolean(),
  enabledRepositoryIds: z.array(z.uuid()),
  title: z.string(),
  welcomeMessage: z.string(),
  accentColor: z.string(),
  language: z.string(),
  dailyMessageCap: z.number().int().nullable(),
  dailyTicketCap: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  conversationCount: z.number().int(),
});

type WidgetRow = typeof widgets.$inferSelect;

/** Proiezione di una riga widget + conteggio conversazioni verso lo schema pubblico. */
function toPublicWidget(row: WidgetRow, conversationCount: number): z.infer<typeof widgetSchema> {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    enabled: row.enabled,
    enabledRepositoryIds: row.enabledRepositoryIds,
    title: row.title,
    welcomeMessage: row.welcomeMessage,
    accentColor: row.accentColor,
    language: row.language,
    dailyMessageCap: row.dailyMessageCap,
    dailyTicketCap: row.dailyTicketCap,
    createdAt: row.createdAt.toISOString(),
    conversationCount,
  };
}

/**
 * API INTERNA di amministrazione dei widget di assistenza, sotto
 * /api/projects/:projectId/widgets. Superficie della SPA (sessione cookie),
 * distinta dalla superficie pubblica /widget. Lettura per ogni utente
 * autenticato; scrittura (create/update/delete) solo admin, come le altre
 * impostazioni di progetto. Include anche il viewer read-only delle
 * conversazioni (superficie SPA), sotto /widget/conversations.
 */
export async function widgetAdminRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * Assicura che ogni id in `enabledRepositoryIds` sia un repository DI QUESTO
   * progetto: un id esistente ma di un altro progetto (o inesistente) è un 422,
   * non un salvataggio silenzioso di un filtro che non retrieverà mai. Restituisce
   * `true` se tutti validi (o lista vuota).
   */
  async function repositoriesBelongToProject(
    projectId: string,
    enabledRepositoryIds: string[],
  ): Promise<boolean> {
    if (enabledRepositoryIds.length === 0) return true;
    const rows = await app.db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(eq(repositories.projectId, projectId), inArray(repositories.id, enabledRepositoryIds)),
      );
    const valid = new Set(rows.map((r) => r.id));
    return enabledRepositoryIds.every((id) => valid.has(id));
  }

  app.get(
    "/:projectId/widgets",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: {
          200: z.object({ widgets: z.array(widgetSchema) }),
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

      // conversationCount aggregato IN UNA query (LEFT JOIN + GROUP BY, niente
      // N+1): i widget senza conversazioni restano in elenco con count 0.
      const rows = await app.db
        .select({
          widget: widgets,
          conversationCount: sql<number>`count(${widgetConversations.id})::int`,
        })
        .from(widgets)
        .leftJoin(widgetConversations, eq(widgetConversations.widgetId, widgets.id))
        .where(eq(widgets.projectId, projectId))
        .groupBy(widgets.id)
        // Ordine stabile: createdAt asc, tiebreaker sull'id al bordo del limit.
        .orderBy(asc(widgets.createdAt), asc(widgets.id));

      return { widgets: rows.map((r) => toPublicWidget(r.widget, r.conversationCount)) };
    },
  );

  app.post(
    "/:projectId/widgets",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: widgetUpsertBodySchema,
        response: {
          200: z.object({ widget: widgetSchema }),
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const body = request.body;

      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      if (!(await repositoriesBelongToProject(projectId, body.enabledRepositoryIds))) {
        return apiError(
          reply,
          422,
          "invalid_repository",
          "enabledRepositoryIds must reference repositories of this project",
        );
      }

      const [row] = await app.db
        .insert(widgets)
        // body per primo: projectId e key non devono mai essere sovrascrivibili
        // dal client, nemmeno se lo schema diventasse passthrough.
        .values({ ...body, projectId, key: generateIngestionKey() })
        .returning();
      if (!row) throw new Error("insert del widget non ha restituito la riga");
      // Widget appena creato: nessuna conversazione ancora collegata.
      return { widget: toPublicWidget(row, 0) };
    },
  );

  app.put(
    "/:projectId/widgets/:widgetId",
    {
      preHandler: requireAdmin,
      schema: {
        params: widgetParamsSchema,
        // `key` NON è nel body: immutabile dopo la creazione.
        body: widgetUpsertBodySchema,
        response: {
          200: z.object({ widget: widgetSchema }),
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, widgetId } = request.params;
      const body = request.body;

      const [existing] = await app.db
        .select({ id: widgets.id })
        .from(widgets)
        .where(and(eq(widgets.id, widgetId), eq(widgets.projectId, projectId)));
      // Widget inesistente o di un altro progetto: 404 (isolamento).
      if (!existing) return apiError(reply, 404, "widget_not_found", "Widget not found");

      if (!(await repositoriesBelongToProject(projectId, body.enabledRepositoryIds))) {
        return apiError(
          reply,
          422,
          "invalid_repository",
          "enabledRepositoryIds must reference repositories of this project",
        );
      }

      const [row] = await app.db
        .update(widgets)
        .set(body)
        .where(and(eq(widgets.id, widgetId), eq(widgets.projectId, projectId)))
        .returning();
      if (!row) throw new Error("update del widget non ha restituito la riga");

      const [count] = await app.db
        .select({ conversationCount: sql<number>`count(*)::int` })
        .from(widgetConversations)
        .where(eq(widgetConversations.widgetId, widgetId));
      return { widget: toPublicWidget(row, count?.conversationCount ?? 0) };
    },
  );

  app.delete(
    "/:projectId/widgets/:widgetId",
    {
      preHandler: requireAdmin,
      schema: {
        params: widgetParamsSchema,
        response: {
          204: z.null(),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, widgetId } = request.params;
      // La FK widget_conversations.widget_id fa SET NULL: lo storico resta
      // consultabile come "widget eliminato".
      const deleted = await app.db
        .delete(widgets)
        .where(and(eq(widgets.id, widgetId), eq(widgets.projectId, projectId)))
        .returning({ id: widgets.id });
      if (deleted.length === 0) {
        return apiError(reply, 404, "widget_not_found", "Widget not found");
      }
      return reply.code(204).send(null);
    },
  );

  // ── Viewer read-only delle conversazioni del widget (superficie SPA) ──────

  const conversationSummarySchema = z.object({
    id: z.uuid(),
    externalUserId: z.string(),
    externalUserEmail: z.string().nullable(),
    externalUserName: z.string().nullable(),
    // Widget di origine; null se il widget è stato eliminato (FK SET NULL).
    widgetId: z.uuid().nullable(),
    widgetName: z.string().nullable(),
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
          widgetId: z.uuid().optional(),
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
      const { limit, ticketId, widgetId } = request.query;

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

      // Filtro per widget: conversazioni con quel `widgetId` (uno inesistente
      // dà semplicemente lista vuota). Componibile con `ticketFilter`.
      const widgetFilter = widgetId ? eq(widgetConversations.widgetId, widgetId) : undefined;

      const rows = await app.db
        .select({
          id: widgetConversations.id,
          externalUserId: widgetConversations.externalUserId,
          externalUserEmail: widgetConversations.externalUserEmail,
          externalUserName: widgetConversations.externalUserName,
          // LEFT JOIN sul widget: conversazione orfana (widget eliminato) → null.
          widgetId: widgets.id,
          widgetName: widgets.name,
          createdAt: widgetConversations.createdAt,
          lastMessageAt: widgetConversations.lastMessageAt,
          messageCount: sql<number>`count(${widgetMessages.id})::int`,
          ticketCount: sql<number>`(count(${widgetMessages.id}) filter (where ${widgetMessages.ticketId} is not null))::int`,
        })
        .from(widgetConversations)
        // LEFT JOIN: le conversazioni senza messaggi restano in elenco (count 0).
        .leftJoin(widgetMessages, eq(widgetMessages.conversationId, widgetConversations.id))
        // LEFT JOIN sul widget di origine (orfana → widgetId/widgetName null).
        .leftJoin(widgets, eq(widgets.id, widgetConversations.widgetId))
        .where(and(eq(widgetConversations.projectId, projectId), ticketFilter, widgetFilter))
        // GROUP BY anche su widgets.id: le colonne del widget joinate sono
        // funzionalmente dipendenti dalla sua PK (widgets.name è determinata).
        .groupBy(widgetConversations.id, widgets.id)
        // Tiebreaker sull'id: ordine stabile al bordo del limit a parità di lastMessageAt.
        .orderBy(desc(widgetConversations.lastMessageAt), desc(widgetConversations.id))
        .limit(limit);

      return {
        conversations: rows.map((r) => ({
          id: r.id,
          externalUserId: r.externalUserId,
          externalUserEmail: r.externalUserEmail,
          externalUserName: r.externalUserName,
          widgetId: r.widgetId,
          widgetName: r.widgetName,
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
              // null se il widget di origine è stato eliminato (FK SET NULL).
              widgetName: z.string().nullable(),
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
          // LEFT JOIN sul widget: orfana (widget eliminato) → widgetName null.
          widgetName: widgets.name,
          createdAt: widgetConversations.createdAt,
        })
        .from(widgetConversations)
        .leftJoin(widgets, eq(widgets.id, widgetConversations.widgetId))
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
          widgetName: conversation.widgetName,
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
