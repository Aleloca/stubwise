/**
 * Chat RAG in streaming sui Docs di un progetto (M6.5).
 *
 * `POST /api/projects/:projectId/docs/chat` — auth richiesta. Flusso:
 *  1. risolve/crea la sessione (scopata a progetto + utente);
 *  2. persiste il messaggio utente;
 *  3. RETRIEVAL riusato da {@link retrieveChunks} (stesso scope/ranking della
 *     ricerca M6.4) → top-K chunk con pagina (slug/title) per le citazioni;
 *  4. costruisce un system prompt con le regole dei due registri (tecnico/
 *     capability), l'anti-allucinazione e l'obbligo di citare;
 *  5. stremma la risposta dell'LLM ({@link ChatLlm}, iniettabile) al client via
 *     SSE (`reply.raw`), un evento `delta` per frammento, poi un evento `done`
 *     con le citazioni;
 *  6. persiste il messaggio assistant: se lo stream è completato, contenuto
 *     completo + citazioni; se è stato interrotto (errore/disconnessione a metà)
 *     ed era stato accumulato del testo, lo salva SENZA citazioni e con un
 *     marcatore di troncamento, così storico e UI lo distinguono da una risposta
 *     completa e non abortisce inutilmente il consumo di token (AbortSignal).
 *
 * NOTA SSE: questa è l'UNICA route che bypassa lo schema di risposta Zod —
 * scrive uno stream grezzo su `reply.raw`, quindi `reply.hijack()` dice a
 * Fastify di non gestire/serializzare la risposta. Niente precedente in questo
 * progetto: il protocollo (header + framing `data: {json}\n\n`) è documentato
 * qui sotto.
 */

import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { docChatMessages, docChatSessions, repositories } from "@stubwise/db";
import { apiError } from "../errors.js";
import type { ChatLlm } from "./chat-llm.js";
import { retrieveChunks } from "./docs-retrieval.js";
import { buildCitations, buildDocsSystemPrompt, CHAT_RETRIEVAL_K } from "./docs-rag.js";
import { loadHistory, streamChatResponse } from "./docs-chat-core.js";
import { appendGraphContext, retrieveGraphContext } from "../graph-chat/context.js";
import { authErrorResponses, errorSchema } from "./shared.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * LLM della chat RAG sui Docs. Iniettabile nei test via
     * BuildAppOptions.chatLlm (fake che emette delta canned); in produzione è
     * l'implementazione reale via SDK Anthropic. Le route lo leggono da
     * `app.chatLlm`.
     */
    chatLlm: ChatLlm;
  }
}

const repositoryIdParamsSchema = z.object({ repositoryId: z.uuid() });

/** Body della chat: messaggio non vuoto, sessione opzionale (creata se assente). */
const chatBodySchema = z.object({
  sessionId: z.uuid().optional(),
  message: z.string().min(1).max(8000),
});

/**
 * Numero di pagine di contesto recuperate per la chat. Il system prompt e le
 * citazioni vivono in {@link ./docs-rag.ts} (UNICA definizione, condivisa con il
 * flusso RAG non-streaming): qui li importiamo invece di duplicarli. Il loop SSE,
 * l'AbortSignal e la persistenza del messaggio assistant vivono in
 * {@link ./docs-chat-core.ts}, condivisi con la chat di progetto.
 */

/**
 * Route della chat RAG, registrata sotto /api (path interno completo
 * `/projects/:projectId/docs/chat`). Separata da docsRoutes perché bypassa lo
 * schema di risposta Zod (stream SSE grezzo).
 */
export async function docsChatRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/repositories/:repositoryId/docs/chat",
    {
      preHandler: requireAuth,
      schema: {
        params: repositoryIdParamsSchema,
        body: chatBodySchema,
        // Nessuno schema di risposta 200: la risposta è uno stream SSE grezzo
        // scritto su reply.raw (reply.hijack), non un body serializzato da Zod.
        // Restano gli errori PRIMA dello streaming (404/403/401/503), che usano
        // il path normale di Fastify. Il 503 è la chat non servibile (nessun
        // provider api_key): un errore JSON pulito, non un evento SSE opaco.
        response: { 404: errorSchema, 503: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { repositoryId } = request.params;
      const { sessionId, message } = request.body;
      const userId = request.user!.id;

      // Progetto esistente (404 altrimenti).
      const [project] = await app.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      // PRE-FLIGHT disponibilità chat: BEFORE l'hijack dello stream. Se l'LLM
      // espone `isAvailable` e riporta non servibile (tipicamente: nessun
      // provider AI `api_key` — gli account/oauth servono il worker ma non l'SDK
      // HTTP), rispondiamo con un 503 JSON pulito che la UI mappa su un messaggio
      // chiaro ("configura un provider API key"). Senza questo controllo l'errore
      // emergerebbe solo a metà stream, DOPO hijack/writeHead, come evento SSE
      // `error` opaco. Il controllo mid-stream resta come fallback runtime.
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

      // Sessione: riusa quella fornita (validandone l'ownership) o ne crea una nuova.
      let resolvedSessionId: string;
      if (sessionId) {
        const [session] = await app.db
          .select({ id: docChatSessions.id })
          .from(docChatSessions)
          .where(
            and(
              eq(docChatSessions.id, sessionId),
              eq(docChatSessions.repositoryId, repositoryId),
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
          .values({ repositoryId, userId })
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

      // RETRIEVAL riusato (no reimplementazione): stesso scope/ranking della
      // ricerca M6.4. Se l'embedding è down, retrieveChunks fa fallback
      // full-text-only e non lancia — la chat resta servibile.
      // IN PARALLELO il retrieval strutturale dal knowledge graph (fase 2b):
      // stessa domanda dell'utente, latenza invariata (la query al grafo è più
      // veloce dell'embedding) e fail-open totale — `null` = system identico a
      // prima. Il blocco va DOPO i chunk (vedi appendGraphContext).
      const [chunks, graphBlock] = await Promise.all([
        retrieveChunks(app.db, app.embeddingClient, repositoryId, message, {
          k: CHAT_RETRIEVAL_K,
          logger: request.log,
        }),
        retrieveGraphContext(
          { db: app.db, logger: request.log, ...app.graphChat },
          { repositoryId, question: message },
        ),
      ]);
      const citations = buildCitations(chunks);
      const system = appendGraphContext(buildDocsSystemPrompt(chunks), graphBlock);
      const history = await loadHistory(app.db, resolvedSessionId);

      // Streaming SSE + persistenza del messaggio assistant: cuore condiviso con
      // la chat di progetto (vedi ./docs-chat-core.ts).
      await streamChatResponse({
        db: app.db,
        chatLlm: app.chatLlm,
        request,
        reply,
        sessionId: resolvedSessionId,
        system,
        history,
        citations,
        logContext: { repositoryId },
      });
    },
  );

  // --- Storico sessioni (lettura) ------------------------------------------

  /** Sessioni di chat dell'utente per il progetto, più recenti prima. */
  app.get(
    "/repositories/:repositoryId/docs/chat/sessions",
    {
      preHandler: requireAuth,
      schema: {
        params: repositoryIdParamsSchema,
        response: {
          200: z.array(z.object({ id: z.uuid(), createdAt: z.string() })),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { repositoryId } = request.params;
      const userId = request.user!.id;

      const [project] = await app.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      const rows = await app.db
        .select({ id: docChatSessions.id, createdAt: docChatSessions.createdAt })
        .from(docChatSessions)
        .where(
          and(eq(docChatSessions.repositoryId, repositoryId), eq(docChatSessions.userId, userId)),
        )
        .orderBy(asc(docChatSessions.createdAt));

      return rows.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString() }));
    },
  );

  /** Messaggi di una sessione (cronologico). Solo se la sessione è dell'utente. */
  app.get(
    "/repositories/:repositoryId/docs/chat/sessions/:id/messages",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ repositoryId: z.uuid(), id: z.uuid() }),
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
      const { repositoryId, id } = request.params;
      const userId = request.user!.id;

      // Ownership della sessione: deve essere dell'utente e del progetto.
      const [session] = await app.db
        .select({ id: docChatSessions.id })
        .from(docChatSessions)
        .where(
          and(
            eq(docChatSessions.id, id),
            eq(docChatSessions.repositoryId, repositoryId),
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
