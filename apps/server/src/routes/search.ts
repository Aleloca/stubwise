import {
  recordSearchHistoryBodySchema,
  searchHistoryItemSchema,
  searchResultsSchema,
} from "@stubwise/shared";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import {
  comments,
  docPages,
  projects,
  repositories,
  searchHistory,
  tickets,
} from "@stubwise/db";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

// Quanti risultati per gruppo restituisce la corsia veloce; ne chiediamo uno in
// più al DB per calcolare `hasMore` senza una COUNT separata.
const PER_GROUP = 8;
// Quante voci di cronologia si mostrano (recenti a query vuota).
const HISTORY_LIMIT = 8;
// Oltre quante voci di cronologia per utente si pota (le più vecchie).
const HISTORY_KEEP = 20;

const searchQuerySchema = z.object({
  q: z.string().min(1).max(300),
  // Scope Docs: se presente, RISTRINGE SOLO il gruppo docs a questo repository.
  // Gli altri gruppi (ticket/progetti/repo) restano globali.
  repositoryId: z.uuid().optional(),
});

const historyQuerySchema = z.object({
  // Scope Docs per i recenti: filtra la cronologia a quel repository.
  repositoryId: z.uuid().optional(),
});

const historyItemParamsSchema = z.object({
  type: z.enum(["ticket", "project", "repository", "doc"]),
  entityId: z.string().min(1),
});

/**
 * Ricerca globale (spotlight Cmd/K) — corsia veloce, federata full-text, e
 * cronologia unificata dei risultati cliccati. `GET /api/search` interroga in
 * parallelo ticket/progetti/repository/docs; lo scope Docs (`repositoryId`)
 * ristringe SOLO il gruppo docs, gli altri restano globali. La cronologia
 * (`/api/search/history`) è poliforma (qualsiasi tipo), con upsert+prune.
 */
export async function searchRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        querystring: searchQuerySchema,
        response: { 200: searchResultsSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const q = request.query.q.trim();
      // `q` di soli spazi passa il min(1) di Zod ma è semanticamente vuota.
      if (q.length === 0) {
        return apiError(reply, 400, "empty_query", "Search query must not be empty");
      }
      const scopeRepositoryId = request.query.repositoryId;

      // websearch_to_tsquery tollera input utente arbitrario (&, :, !, virgolette)
      // senza errori di sintassi → niente escaping. Config 'english' per convenzione
      // di progetto (condivisa da tickets/doc_pages).
      const tsq = sql`websearch_to_tsquery('english', ${q})`;
      // Pattern ILIKE per progetti/repo (pochi record): escape dei metacaratteri
      // LIKE (%, _, \) così l'input utente non li interpreta.
      const likePattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

      // Esecuzione in PARALLELO delle quattro gambe.
      const [ticketRows, projectRows, repositoryRows, docRows] = await Promise.all([
        // --- Ticket (globale): titolo+body (searchTsv) OPPURE un commento. ------
        app.db
          .select({
            id: tickets.id,
            number: tickets.number,
            title: tickets.title,
            status: tickets.status,
            projectId: tickets.projectId,
            projectName: projects.name,
            snippet: sql<string>`ts_headline('english', coalesce(${tickets.title}, '') || ' — ' || coalesce(${tickets.body}, ''), ${tsq}, 'MaxFragments=1,MaxWords=40,MinWords=15')`,
            rank: sql<number>`ts_rank(${tickets.searchTsv}, ${tsq})`,
          })
          .from(tickets)
          .innerJoin(projects, eq(tickets.projectId, projects.id))
          .where(
            sql`(
              ${tickets.searchTsv} @@ ${tsq}
              OR EXISTS (
                SELECT 1 FROM ${comments} c
                WHERE c.ticket_id = ${tickets.id}
                  AND to_tsvector('english', c.body) @@ ${tsq}
              )
            )`,
          )
          .orderBy(sql`ts_rank(${tickets.searchTsv}, ${tsq}) DESC`, desc(tickets.createdAt))
          .limit(PER_GROUP + 1),

        // --- Progetti (globale): ILIKE su nome/slug/descrizione. ---------------
        app.db
          .select({
            id: projects.id,
            name: projects.name,
            slug: projects.slug,
            description: projects.description,
          })
          .from(projects)
          .where(
            or(
              ilike(projects.name, likePattern),
              ilike(projects.slug, likePattern),
              ilike(projects.description, likePattern),
            ),
          )
          .orderBy(projects.name)
          .limit(PER_GROUP + 1),

        // --- Repository (globale): ILIKE su nome/slug/repoUrl. -----------------
        app.db
          .select({
            id: repositories.id,
            name: repositories.name,
            slug: repositories.slug,
            projectId: repositories.projectId,
            repoUrl: repositories.repoUrl,
          })
          .from(repositories)
          .where(
            or(
              ilike(repositories.name, likePattern),
              ilike(repositories.slug, likePattern),
              ilike(repositories.repoUrl, likePattern),
            ),
          )
          .orderBy(repositories.name)
          .limit(PER_GROUP + 1),

        // --- Docs (full-text): doc_pages.searchTsv sui repo con generazione
        // corrente. In scope Docs SOLO quel repository; altrimenti TUTTI (il
        // filtro di generazione corrente/manuale è per-repo, come in Fase 2).
        app.db
          .select({
            slug: docPages.slug,
            title: docPages.title,
            kind: docPages.kind,
            repositoryId: repositories.id,
            repositorySlug: repositories.slug,
            repositoryName: repositories.name,
            snippet: sql<string>`ts_headline('english', ${docPages.body}, ${tsq}, 'MaxFragments=1,MaxWords=40,MinWords=15')`,
            rank: sql<number>`ts_rank_cd(${docPages.searchTsv}, ${tsq}, 32)`,
          })
          .from(docPages)
          .innerJoin(repositories, eq(docPages.repositoryId, repositories.id))
          .where(
            and(
              sql`${docPages.searchTsv} @@ ${tsq}`,
              // Solo la generazione corrente del repo (o le pagine manuali,
              // generation_id null): le generazioni stale non compaiono.
              or(
                eq(docPages.generationId, repositories.currentDocGenerationId),
                isNull(docPages.generationId),
              ),
              scopeRepositoryId ? eq(repositories.id, scopeRepositoryId) : undefined,
            ),
          )
          .orderBy(sql`ts_rank_cd(${docPages.searchTsv}, ${tsq}, 32) DESC`)
          .limit(PER_GROUP + 1),
      ]);

      return {
        tickets: {
          items: ticketRows.slice(0, PER_GROUP).map((r) => ({
            id: r.id,
            number: r.number,
            title: r.title,
            status: r.status,
            snippet: r.snippet,
            projectId: r.projectId,
            projectName: r.projectName,
          })),
          hasMore: ticketRows.length > PER_GROUP,
        },
        projects: {
          items: projectRows.slice(0, PER_GROUP).map((r) => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            snippet: r.description,
          })),
          hasMore: projectRows.length > PER_GROUP,
        },
        repositories: {
          items: repositoryRows.slice(0, PER_GROUP).map((r) => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            projectId: r.projectId,
            repoUrl: r.repoUrl,
          })),
          hasMore: repositoryRows.length > PER_GROUP,
        },
        docs: {
          items: docRows.slice(0, PER_GROUP).map((r) => ({
            slug: r.slug,
            title: r.title,
            kind: r.kind,
            snippet: r.snippet,
            repositoryId: r.repositoryId,
            repositorySlug: r.repositorySlug,
            repositoryName: r.repositoryName,
          })),
          hasMore: docRows.length > PER_GROUP,
        },
      };
    },
  );

  // --- Cronologia unificata dei risultati cliccati -----------------------

  /**
   * Recenti dell'utente corrente: le ultime N voci, dal click più recente. In
   * scope Docs (`repositoryId`) filtra a quel repository (comportamento della
   * palette Docs), altrimenti globale.
   */
  app.get(
    "/history",
    {
      preHandler: requireAuth,
      schema: {
        querystring: historyQuerySchema,
        response: { 200: z.array(searchHistoryItemSchema), ...authErrorResponses },
      },
    },
    async (request) => {
      const { repositoryId } = request.query;
      const rows = await app.db
        .select({
          type: searchHistory.type,
          entityId: searchHistory.entityId,
          title: searchHistory.title,
          subtitle: searchHistory.subtitle,
          route: searchHistory.route,
          repositoryId: searchHistory.repositoryId,
          clickedAt: searchHistory.clickedAt,
        })
        .from(searchHistory)
        .where(
          and(
            eq(searchHistory.userId, request.user!.id),
            repositoryId ? eq(searchHistory.repositoryId, repositoryId) : undefined,
          ),
        )
        .orderBy(desc(searchHistory.clickedAt))
        .limit(HISTORY_LIMIT);

      return rows.map((r) => ({
        type: r.type,
        entityId: r.entityId,
        title: r.title,
        subtitle: r.subtitle,
        route: r.route,
        repositoryId: r.repositoryId,
        clickedAt: r.clickedAt.toISOString(),
      }));
    },
  );

  /**
   * Registra (upsert) un risultato cliccato. Una sola voce per (utente, tipo,
   * entità): un re-click aggiorna `clickedAt` e i campi denormalizzati. Dopo
   * l'insert pota le righe oltre le N più recenti dell'utente. 204 senza corpo.
   */
  app.post(
    "/history",
    {
      preHandler: requireAuth,
      schema: {
        body: recordSearchHistoryBodySchema,
        response: { 204: z.null(), ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { type, entityId, title, subtitle, route, repositoryId } = request.body;
      const userId = request.user!.id;

      await app.db
        .insert(searchHistory)
        .values({
          userId,
          type,
          entityId,
          title,
          subtitle: subtitle ?? null,
          route,
          repositoryId: repositoryId ?? null,
        })
        .onConflictDoUpdate({
          target: [searchHistory.userId, searchHistory.type, searchHistory.entityId],
          set: {
            clickedAt: new Date(),
            title,
            subtitle: subtitle ?? null,
            route,
            repositoryId: repositoryId ?? null,
          },
        });

      // Poda: tieni solo le N voci più recenti dell'utente (cronologia globale).
      const keep = app.db
        .select({ id: searchHistory.id })
        .from(searchHistory)
        .where(eq(searchHistory.userId, userId))
        .orderBy(desc(searchHistory.clickedAt))
        .limit(HISTORY_KEEP);
      await app.db
        .delete(searchHistory)
        .where(
          and(
            eq(searchHistory.userId, userId),
            sql`${searchHistory.id} NOT IN ${keep}`,
          ),
        );

      return reply.code(204).send(null);
    },
  );

  /**
   * Rimuove una singola voce (per tipo+entità) dell'utente corrente. 204 anche
   * se la voce non esiste (idempotente).
   */
  app.delete(
    "/history/:type/:entityId",
    {
      preHandler: requireAuth,
      schema: {
        params: historyItemParamsSchema,
        response: { 204: z.null(), ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { type, entityId } = request.params;
      await app.db
        .delete(searchHistory)
        .where(
          and(
            eq(searchHistory.userId, request.user!.id),
            eq(searchHistory.type, type),
            eq(searchHistory.entityId, entityId),
          ),
        );
      return reply.code(204).send(null);
    },
  );

  /**
   * Svuota tutta la cronologia dell'utente corrente. 204.
   */
  app.delete(
    "/history",
    {
      preHandler: requireAuth,
      schema: { response: { 204: z.null(), ...authErrorResponses } },
    },
    async (request, reply) => {
      await app.db
        .delete(searchHistory)
        .where(eq(searchHistory.userId, request.user!.id));
      return reply.code(204).send(null);
    },
  );
}
