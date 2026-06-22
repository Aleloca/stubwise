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
 *  6. persiste il messaggio assistant (contenuto completo + citazioni).
 *
 * NOTA SSE: questa è l'UNICA route che bypassa lo schema di risposta Zod —
 * scrive uno stream grezzo su `reply.raw`, quindi `reply.hijack()` dice a
 * Fastify di non gestire/serializzare la risposta. Niente precedente in questo
 * progetto: il protocollo (header + framing `data: {json}\n\n`) è documentato
 * qui sotto.
 */

import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { docChatMessages, docChatSessions, projects } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import { apiError } from "../errors.js";
import type { ChatLlm } from "./chat-llm.js";
import { retrieveChunks, type RetrievedChunk } from "./docs-retrieval.js";
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

const projectIdParamsSchema = z.object({ projectId: z.uuid() });

/** Body della chat: messaggio non vuoto, sessione opzionale (creata se assente). */
const chatBodySchema = z.object({
  sessionId: z.uuid().optional(),
  message: z.string().min(1).max(8000),
});

/** Numero di pagine di contesto recuperate per la chat. */
const CHAT_RETRIEVAL_K = 8;

/** Citazione restituita alla UI / persistita: riferimento a una pagina doc. */
interface Citation {
  slug: string;
  title: string;
  kind: RetrievedChunk["kind"];
}

/**
 * System prompt della chat RAG. Codifica i requisiti di prodotto:
 *  - DOPPIO REGISTRO: domanda tecnica → risposta tecnica con moduli/API;
 *    domanda capability ("si può fare X") → risposta funzionale con i passi se
 *    fattibile, oppure il perché non lo è.
 *  - ANTI-ALLUCINAZIONE: rispondere SOLO dal contesto recuperato; se non basta,
 *    dirlo esplicitamente invece di inventare.
 *  - CITAZIONI: citare le pagine usate (per slug/titolo).
 *
 * Il contesto recuperato è incluso in coda al prompt, con slug/titolo per ogni
 * pagina così il modello può citarle.
 */
function buildSystemPrompt(chunks: RetrievedChunk[]): string {
  const header = [
    "Sei l'assistente di documentazione di un progetto software. Rispondi nella lingua della domanda.",
    "",
    "ADATTA IL REGISTRO ALLA DOMANDA:",
    '- Domanda TECNICA ("come funziona X?", "dove sta Y?") → risposta tecnica, con riferimenti a moduli, API pubbliche e flussi reali presenti nel contesto.',
    '- Domanda di CAPABILITY ("si può fare X?", "è possibile Y?") → risposta funzionale: se è fattibile descrivi i passi; se NON è fattibile spiega il perché, sempre ancorato a cosa il codice/documentazione effettivamente fa.',
    "",
    "RISPONDI SOLO DAL CONTESTO RECUPERATO QUI SOTTO. Non inventare: se il contesto non basta a rispondere, dillo esplicitamente (es. \"La documentazione recuperata non copre questo punto\") invece di tirare a indovinare.",
    "",
    "CITA SEMPRE le pagine di documentazione che hai usato, riferendoti al loro titolo.",
    "",
    "--- CONTESTO RECUPERATO ---",
  ];

  if (chunks.length === 0) {
    header.push("(nessuna pagina di documentazione rilevante è stata trovata per questa domanda)");
    return header.join("\n");
  }

  const context = chunks.map((c, i) => {
    return [
      `[${i + 1}] Pagina "${c.title}" (slug: ${c.slug}, tipo: ${c.kind})`,
      c.snippet,
    ].join("\n");
  });

  return [...header, ...context].join("\n\n");
}

/** Deriva le citazioni (una per pagina) dai chunk recuperati, deduplicate per slug. */
function toCitations(chunks: RetrievedChunk[]): Citation[] {
  const bySlug = new Map<string, Citation>();
  for (const c of chunks) {
    if (!bySlug.has(c.slug)) {
      bySlug.set(c.slug, { slug: c.slug, title: c.title, kind: c.kind });
    }
  }
  return [...bySlug.values()];
}

/** Scrive un evento SSE (`data: {json}\n\n`) sullo stream grezzo. */
function writeSseEvent(reply: FastifyReply, event: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Carica lo storico della sessione (cronologico) come messaggi per l'LLM.
 * Esclude il messaggio appena inserito? No: viene chiamata DOPO l'insert del
 * messaggio utente, così lo storico include già la domanda corrente in coda.
 */
async function loadHistory(
  db: Db,
  sessionId: string,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await db
    .select({ role: docChatMessages.role, content: docChatMessages.content })
    .from(docChatMessages)
    .where(eq(docChatMessages.sessionId, sessionId))
    .orderBy(asc(docChatMessages.createdAt));
  // `role` è text libero a schema: normalizziamo ai due valori attesi dall'LLM.
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

/**
 * Route della chat RAG, registrata sotto /api (path interno completo
 * `/projects/:projectId/docs/chat`). Separata da docsRoutes perché bypassa lo
 * schema di risposta Zod (stream SSE grezzo).
 */
export async function docsChatRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/projects/:projectId/docs/chat",
    {
      preHandler: requireAuth,
      schema: {
        params: projectIdParamsSchema,
        body: chatBodySchema,
        // Nessuno schema di risposta 200: la risposta è uno stream SSE grezzo
        // scritto su reply.raw (reply.hijack), non un body serializzato da Zod.
        // Restano gli errori PRIMA dello streaming (404/403/401), che usano il
        // path normale di Fastify.
        response: { 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const { sessionId, message } = request.body;
      const userId = request.user!.id;

      // Progetto esistente (404 altrimenti).
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      // Sessione: riusa quella fornita (validandone l'ownership) o ne crea una nuova.
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

      // RETRIEVAL riusato (no reimplementazione): stesso scope/ranking della
      // ricerca M6.4. Se l'embedding è down, retrieveChunks fa fallback
      // full-text-only e non lancia — la chat resta servibile.
      const chunks = await retrieveChunks(app.db, app.embeddingClient, projectId, message, {
        k: CHAT_RETRIEVAL_K,
        logger: request.log,
      });
      const citations = toCitations(chunks);
      const system = buildSystemPrompt(chunks);
      const history = await loadHistory(app.db, resolvedSessionId);

      // --- Streaming SSE ------------------------------------------------------
      // Da qui in poi gestiamo la risposta a mano: header SSE + scrittura grezza
      // su reply.raw. reply.hijack() impedisce a Fastify di serializzare/chiudere
      // la risposta al posto nostro.
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Disconnessione del client: smettiamo di scrivere/consumare lo stream LLM.
      let clientGone = false;
      request.raw.on("close", () => {
        clientGone = true;
      });

      let full = "";
      try {
        for await (const delta of app.chatLlm.stream({ system, messages: history })) {
          if (clientGone) break;
          full += delta;
          writeSseEvent(reply, { type: "delta", text: delta });
        }
      } catch (error) {
        // Errore dell'LLM a metà stream: lo segnaliamo al client con un evento
        // `error` e chiudiamo. Logghiamo per intero lato server (mai nel body).
        request.log.error({ err: error, projectId, sessionId: resolvedSessionId }, "chat LLM error");
        if (!clientGone) {
          writeSseEvent(reply, { type: "error", message: "Chat generation failed" });
          reply.raw.end();
        }
        // NON persistiamo un messaggio assistant parziale/vuoto su errore puro.
        // Se invece avevamo già accumulato del testo prima dell'errore, lo
        // salviamo sotto (full non vuoto) per non perdere la risposta parziale.
        if (full.length === 0) return;
      }

      if (!clientGone) {
        // Evento finale con le citazioni, poi chiusura dello stream.
        writeSseEvent(reply, { type: "done", citations });
        reply.raw.end();
      }

      // Persiste il messaggio assistant (testo completo + citazioni) anche se il
      // client si è disconnesso: la risposta è stata comunque generata e va
      // conservata nello storico della sessione.
      if (full.length > 0) {
        await app.db.insert(docChatMessages).values({
          sessionId: resolvedSessionId,
          role: "assistant",
          content: full,
          citations,
        });
      }
    },
  );

  // --- Storico sessioni (lettura) ------------------------------------------

  /** Sessioni di chat dell'utente per il progetto, più recenti prima. */
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

      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      const rows = await app.db
        .select({ id: docChatSessions.id, createdAt: docChatSessions.createdAt })
        .from(docChatSessions)
        .where(
          and(eq(docChatSessions.projectId, projectId), eq(docChatSessions.userId, userId)),
        )
        .orderBy(asc(docChatSessions.createdAt));

      return rows.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString() }));
    },
  );

  /** Messaggi di una sessione (cronologico). Solo se la sessione è dell'utente. */
  app.get(
    "/projects/:projectId/docs/chat/sessions/:id/messages",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ projectId: z.uuid(), id: z.uuid() }),
        response: {
          200: z.array(
            z.object({
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
          role: docChatMessages.role,
          content: docChatMessages.content,
          citations: docChatMessages.citations,
          createdAt: docChatMessages.createdAt,
        })
        .from(docChatMessages)
        .where(eq(docChatMessages.sessionId, id))
        .orderBy(asc(docChatMessages.createdAt));

      return rows.map((r) => ({
        role: r.role,
        content: r.content,
        citations: r.citations ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  );
}
