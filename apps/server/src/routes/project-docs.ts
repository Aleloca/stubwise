/**
 * Documentazione a livello di PROGETTO (Fase 2 multi-repo).
 *
 * Layer di sola lettura/scoping che AGGREGA i repository di un progetto:
 *  - `GET /spaces` — gli spazi-doc dei repo del progetto in un'unica vista;
 *  - `GET /search?q=` — ricerca cross-repo (semantica + full-text), NESSUNA
 *    persistenza di cronologia (D5);
 *  - `POST /chat` — chat RAG streaming SSE cross-repo, su sessione project-level;
 *  - `GET /chat/sessions` e `.../:id/messages` — storico scoped a (progetto, utente).
 *
 * Montato sotto `/api/projects/:projectId/docs` (vedi app.ts). Il retrieval
 * cross-repo e l'arricchimento delle citazioni col repository vivono in
 * {@link ./docs-retrieval.ts}; il system prompt/le citazioni in
 * {@link ./docs-rag.ts}; il loop SSE/persistenza in {@link ./docs-chat-core.ts} —
 * tutto condiviso con le route per-repository, senza duplicazione.
 */

import { docPageKindSchema } from "@stubwise/shared";
import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import {
  docChatMessages,
  docChatSessions,
  docGenerations,
  docPages,
  projects,
  repositories,
} from "@stubwise/db";
import { apiError } from "../errors.js";
import { loadHistory, streamChatResponse } from "./docs-chat-core.js";
import {
  emptyCountsByKind,
  HIGHLIGHT_LIMITS,
  projectHighlightsSchema,
} from "./docs-highlights.js";
import { buildCitations, buildDocsSystemPrompt } from "./docs-rag.js";
import { retrieveChunksForProject } from "./docs-retrieval.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const projectIdParamsSchema = z.object({ projectId: z.uuid() });

/** Body della chat: messaggio non vuoto, sessione opzionale (creata se assente). */
const chatBodySchema = z.object({
  sessionId: z.uuid().optional(),
  message: z.string().min(1).max(8000),
});

/** Query di ricerca: `q` non vuota, cappata a 300 char (come la ricerca per-repo). */
const searchQuerySchema = z.object({ q: z.string().min(1).max(300) });

/** Uno "spazio" dell'hub di progetto: un repository del progetto che ha documentazione. */
const spaceSchema = z.object({
  repositoryId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  pageCount: z.number().int(),
  lastGenerationAt: z.string().nullable(),
  lastCommitSha: z.string().nullable(),
});

/**
 * Un risultato di ricerca cross-repo: stesso shape della search per-repo
 * (slug/title/kind/snippet/score/source) ARRICCHITO col repository d'origine, così
 * il client può disambiguare/linkare la fonte tra i repo del progetto.
 */
const searchResultSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  snippet: z.string(),
  score: z.number(),
  source: z.enum(["semantic", "fulltext", "hybrid"]),
  repositoryId: z.uuid(),
  repositorySlug: z.string(),
  repositoryName: z.string(),
});

/**
 * Route della documentazione di PROGETTO, registrate sotto
 * /api/projects/:projectId/docs. Come la chat per-repo, la `POST /chat` bypassa lo
 * schema di risposta Zod (stream SSE grezzo): vive nello stesso plugin delle
 * letture project-scoped per coerenza di prefisso.
 */
export async function projectDocsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /** Verifica l'esistenza del progetto (404 altrimenti). */
  async function projectExists(projectId: string): Promise<boolean> {
    const [project] = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    return project !== undefined;
  }

  // --- Hub spazi del progetto ----------------------------------------------

  /**
   * Spazi-doc del progetto: i SUOI repository, ognuno come "spazio". Riusa la
   * logica dell'hub globale (left join repositories↔docPages↔docGenerations,
   * conteggio pagine della generazione corrente + manuali) ma FILTRATA a
   * `repositories.projectId = :projectId`. Un repo senza documentazione compare
   * con pageCount 0. 404 se il progetto non esiste.
   */
  app.get(
    "/projects/:projectId/docs/spaces",
    {
      preHandler: requireAuth,
      schema: {
        params: projectIdParamsSchema,
        response: { 200: z.array(spaceSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      if (!(await projectExists(projectId))) {
        return apiError(reply, 404, "project_not_found", "Project not found");
      }

      const rows = await app.db
        .select({
          repositoryId: repositories.id,
          slug: repositories.slug,
          name: repositories.name,
          pageCount: sql<number>`count(${docPages.id})::int`,
          lastGenerationAt: docGenerations.finishedAt,
          lastCommitSha: docGenerations.commitSha,
        })
        .from(repositories)
        .leftJoin(
          docPages,
          and(
            eq(docPages.repositoryId, repositories.id),
            or(
              eq(docPages.generationId, repositories.currentDocGenerationId),
              isNull(docPages.generationId),
            ),
          ),
        )
        .leftJoin(
          docGenerations,
          and(
            eq(docGenerations.id, repositories.currentDocGenerationId),
            eq(docGenerations.status, "succeeded"),
          ),
        )
        .where(eq(repositories.projectId, projectId))
        .groupBy(
          repositories.id,
          repositories.slug,
          repositories.name,
          docGenerations.finishedAt,
          docGenerations.commitSha,
        )
        .orderBy(asc(repositories.name));

      return rows.map((r) => ({
        repositoryId: r.repositoryId,
        slug: r.slug,
        name: r.name,
        pageCount: r.pageCount,
        lastGenerationAt: r.lastGenerationAt ? r.lastGenerationAt.toISOString() : null,
        lastCommitSha: r.lastCommitSha,
      }));
    },
  );

  /**
   * Highlights AGGREGATE del progetto: alimentano la home orientante. Il
   * changelog è unificato cross-repo (ordinato per data della entry, non per
   * `position` che è per-repo) e ogni voce porta il repository d'origine.
   * `topViewed` aggrega le pagine più lette di tutti i repo, escluse le release.
   * Scope pagine: generazione corrente di ciascun repo + pagine manuali.
   */
  app.get(
    "/projects/:projectId/docs/highlights",
    {
      preHandler: requireAuth,
      schema: {
        params: projectIdParamsSchema,
        response: { 200: projectHighlightsSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      if (!(await projectExists(projectId))) {
        return apiError(reply, 404, "project_not_found", "Project not found");
      }

      // Pagine VISIBILI dei repo del progetto: generazione corrente del repo o
      // pagina manuale/persistente (generationId null, incluse le release).
      const visible = and(
        eq(repositories.projectId, projectId),
        or(
          eq(docPages.generationId, repositories.currentDocGenerationId),
          isNull(docPages.generationId),
        ),
      );
      const pageFields = {
        slug: docPages.slug,
        title: docPages.title,
        kind: docPages.kind,
        viewCount: docPages.viewCount,
        repositoryId: repositories.id,
        repositorySlug: repositories.slug,
        repositoryName: repositories.name,
      };

      const [counts, topViewed, releases] = await Promise.all([
        app.db
          .select({ kind: docPages.kind, count: sql<number>`count(*)::int` })
          .from(docPages)
          .innerJoin(repositories, eq(repositories.id, docPages.repositoryId))
          .where(visible)
          .groupBy(docPages.kind),
        app.db
          .select(pageFields)
          .from(docPages)
          .innerJoin(repositories, eq(repositories.id, docPages.repositoryId))
          .where(and(visible, ne(docPages.kind, "releases")))
          .orderBy(desc(docPages.viewCount), asc(docPages.title))
          .limit(HIGHLIGHT_LIMITS.projectTopViewed),
        app.db
          .select({
            slug: docPages.slug,
            title: docPages.title,
            createdAt: docPages.createdAt,
            significant: docPages.significant,
            repositoryId: repositories.id,
            repositorySlug: repositories.slug,
            repositoryName: repositories.name,
          })
          .from(docPages)
          .innerJoin(repositories, eq(repositories.id, docPages.repositoryId))
          .where(and(eq(repositories.projectId, projectId), eq(docPages.kind, "releases")))
          .orderBy(desc(docPages.createdAt))
          .limit(HIGHLIGHT_LIMITS.projectReleases),
      ]);

      const countsByKind = emptyCountsByKind();
      for (const row of counts) countsByKind[row.kind] = row.count;

      return {
        countsByKind,
        topViewed,
        latestReleases: releases.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          // Le release sono persistenti: non appartengono a una generazione.
          commitSha: null,
        })),
      };
    },
  );

  // --- Ricerca cross-repo del progetto -------------------------------------

  /**
   * Ricerca ibrida CROSS-REPO sui Docs del progetto: stesso retrieval/ranking
   * della chat di progetto ({@link retrieveChunksForProject}). NESSUNA persistenza
   * di cronologia (D5): la palette di progetto non registra storia in Fase 2. I
   * risultati portano il repository d'origine. `q` vuota/di soli spazi → 400, 404
   * se il progetto non esiste.
   */
  app.get(
    "/projects/:projectId/docs/search",
    {
      preHandler: requireAuth,
      schema: {
        params: projectIdParamsSchema,
        querystring: searchQuerySchema,
        response: {
          200: z.array(searchResultSchema),
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const query = request.query.q.trim();
      // `q` di soli spazi passa il min(1) di Zod ma è semanticamente vuota.
      if (query.length === 0) {
        return apiError(reply, 400, "empty_query", "Search query must not be empty");
      }
      if (!(await projectExists(projectId))) {
        return apiError(reply, 404, "project_not_found", "Project not found");
      }

      const results = await retrieveChunksForProject(
        app.db,
        app.embeddingClient,
        projectId,
        query,
        { logger: request.log },
      );
      return results.map((r) => ({
        slug: r.slug,
        title: r.title,
        kind: r.kind,
        snippet: r.snippet,
        score: r.score,
        source: r.source,
        repositoryId: r.repositoryId,
        repositorySlug: r.repositorySlug,
        repositoryName: r.repositoryName,
      }));
    },
  );

  // --- Chat RAG di progetto (streaming SSE) --------------------------------

  /**
   * Chat RAG streaming di progetto. Stessa meccanica della chat per-repo
   * (pre-flight 503 se nessun provider api_key, hijack + SSE, AbortController,
   * persistenza messaggi), ma:
   *  - sessione PROJECT-LEVEL: `doc_chat_sessions` con `projectId` valorizzato e
   *    `repositoryId` NULL (rispetta il CHECK XOR); lookup su (projectId, userId);
   *  - retrieval CROSS-REPO ({@link retrieveChunksForProject}, k proporzionale di
   *    default), citazioni col repository d'origine.
   * 404 se il progetto non esiste; 404 su sessione inesistente/di un altro
   * utente o progetto.
   */
  app.post(
    "/projects/:projectId/docs/chat",
    {
      preHandler: requireAuth,
      schema: {
        params: projectIdParamsSchema,
        body: chatBodySchema,
        // Nessuno schema 200: la risposta è uno stream SSE grezzo su reply.raw
        // (reply.hijack). Restano gli errori PRIMA dello streaming.
        response: { 404: errorSchema, 503: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const { sessionId, message } = request.body;
      const userId = request.user!.id;

      if (!(await projectExists(projectId))) {
        return apiError(reply, 404, "project_not_found", "Project not found");
      }

      // PRE-FLIGHT disponibilità chat: BEFORE l'hijack dello stream. Se l'LLM
      // riporta non servibile (tipicamente: nessun provider AI `api_key`),
      // rispondiamo con un 503 JSON pulito invece di un evento SSE opaco a metà
      // stream. Il controllo mid-stream resta come fallback runtime.
      if (app.chatLlm.isAvailable) {
        const availability = await app.chatLlm.isAvailable();
        if (!availability.available) {
          return apiError(
            reply,
            503,
            "chat_unavailable",
            "Docs chat requires an API-key AI provider",
          );
        }
      }

      // Sessione PROJECT-LEVEL: riusa quella fornita (validandone l'ownership su
      // (projectId, userId)) o ne crea una nuova con projectId valorizzato e
      // repositoryId NULL (CHECK XOR).
      let resolvedSessionId: string;
      if (sessionId) {
        const [session] = await app.db
          .select({ id: docChatSessions.id })
          .from(docChatSessions)
          .where(
            and(
              eq(docChatSessions.id, sessionId),
              eq(docChatSessions.projectId, projectId),
              eq(docChatSessions.userId, userId),
            ),
          );
        // Sessione inesistente o di un altro utente/progetto: 404 (non si rivela
        // l'esistenza di sessioni altrui). L'ownership è SEMPRE verificata.
        if (!session) {
          return apiError(reply, 404, "chat_session_not_found", "Chat session not found");
        }
        resolvedSessionId = session.id;
      } else {
        const [created] = await app.db
          .insert(docChatSessions)
          .values({ projectId, userId })
          .returning({ id: docChatSessions.id });
        if (!created) throw new Error("insert della sessione di chat non ha restituito la riga");
        resolvedSessionId = created.id;
      }

      // Persiste il messaggio utente PRIMA del retrieval/streaming: così lo
      // storico passato all'LLM include la domanda corrente in coda.
      await app.db.insert(docChatMessages).values({
        sessionId: resolvedSessionId,
        role: "user",
        content: message,
      });

      // RETRIEVAL cross-repo riusato (no reimplementazione): stesso scope/ranking
      // della ricerca di progetto. k proporzionale ai repo documentati (default).
      // Se l'embedding è down, fa fallback full-text-only e non lancia.
      const chunks = await retrieveChunksForProject(
        app.db,
        app.embeddingClient,
        projectId,
        message,
        { logger: request.log },
      );
      const citations = buildCitations(chunks);
      const system = buildDocsSystemPrompt(chunks);
      const history = await loadHistory(app.db, resolvedSessionId);

      // Streaming SSE + persistenza del messaggio assistant: cuore condiviso con
      // la chat per-repo (vedi ./docs-chat-core.ts).
      await streamChatResponse({
        db: app.db,
        chatLlm: app.chatLlm,
        request,
        reply,
        sessionId: resolvedSessionId,
        system,
        history,
        citations,
        logContext: { projectId },
      });
    },
  );

  // --- Storico sessioni di progetto (lettura) ------------------------------

  /** Sessioni di chat di progetto dell'utente, più vecchie prima (come per-repo). */
  app.get(
    "/projects/:projectId/docs/chat/sessions",
    {
      preHandler: requireAuth,
      schema: {
        params: projectIdParamsSchema,
        response: {
          200: z.array(z.object({ id: z.uuid(), createdAt: z.string() })),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const userId = request.user!.id;
      if (!(await projectExists(projectId))) {
        return apiError(reply, 404, "project_not_found", "Project not found");
      }

      const rows = await app.db
        .select({ id: docChatSessions.id, createdAt: docChatSessions.createdAt })
        .from(docChatSessions)
        .where(and(eq(docChatSessions.projectId, projectId), eq(docChatSessions.userId, userId)))
        .orderBy(asc(docChatSessions.createdAt));

      return rows.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString() }));
    },
  );

  /** Messaggi di una sessione di progetto (cronologico). Solo se è dell'utente. */
  app.get(
    "/projects/:projectId/docs/chat/sessions/:id/messages",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ projectId: z.uuid(), id: z.uuid() }),
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              role: z.string(),
              content: z.string(),
              citations: z.unknown().nullable(),
              createdAt: z.string(),
            }),
          ),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, id } = request.params;
      const userId = request.user!.id;

      // Ownership della sessione: deve essere dell'utente e del progetto.
      const [session] = await app.db
        .select({ id: docChatSessions.id })
        .from(docChatSessions)
        .where(
          and(
            eq(docChatSessions.id, id),
            eq(docChatSessions.projectId, projectId),
            eq(docChatSessions.userId, userId),
          ),
        );
      if (!session) return apiError(reply, 404, "chat_session_not_found", "Chat session not found");

      const rows = await app.db
        .select({
          id: docChatMessages.id,
          role: docChatMessages.role,
          content: docChatMessages.content,
          citations: docChatMessages.citations,
          createdAt: docChatMessages.createdAt,
        })
        .from(docChatMessages)
        .where(eq(docChatMessages.sessionId, id))
        .orderBy(asc(docChatMessages.createdAt));

      return rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        citations: r.citations ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  );
}
