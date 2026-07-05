import fastifyCors from "@fastify/cors";
import {
  widgetChatMessageBodySchema,
  widgetConversationCreateBodySchema,
  widgetSettingsSchema,
} from "@stubwise/shared";
import { and, asc, count, desc, eq, gte } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  projects,
  widgetConversations,
  widgetMessages,
  widgetSettings,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import { keysMatch } from "../ingest/shared.js";
import { errorSchema, unprocessableEntityFormatter } from "./shared.js";
import type { RateLimitConfig } from "./shared.js";
import { apiError } from "../errors.js";
import { retrieveChunksForProject } from "./docs-retrieval.js";
import { buildCitations, CHAT_RETRIEVAL_K } from "./docs-rag.js";
import { buildWidgetSystemPrompt, streamWidgetChatResponse } from "./widget-chat.js";

export interface WidgetRoutesOptions {
  /** Limite di richieste per chiave del progetto (default 300/min). */
  rateLimit: RateLimitConfig;
  /**
   * Tetto GIORNALIERO (UTC) di messaggi utente della chat widget, per progetto.
   * Superficie pubblica: ogni messaggio consuma token LLM, quindi si limita
   * l'abuso. Da {@link ../app.ts#BuildAppOptions.widgetDailyMessageCap} (default 200).
   */
  dailyMessageCap: number;
}

/** Numero massimo di coppie (user+assistant) di storico passate all'LLM. */
const WIDGET_HISTORY_PAIRS = 10;

/** Inizio della giornata corrente in UTC (per il cap giornaliero e l'indice). */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Riga dei settings del widget, per il tipo di ritorno di loadEnabledSettings. */
type WidgetSettingsRow = typeof widgetSettings.$inferSelect;

/**
 * Carica i settings del widget di un progetto solo se il widget è ATTIVO
 * (riga presente ed `enabled = true`); altrimenti null. Helper riusato dalle
 * route pubbliche che richiedono un widget montabile (conversazioni, chat,
 * ticket): il chiamante risponde 404 `widget_disabled` uniforme su null, senza
 * esporre se manchino i settings o siano solo spenti.
 */
async function loadEnabledSettings(
  db: Db,
  projectId: string,
): Promise<WidgetSettingsRow | null> {
  const [row] = await db
    .select()
    .from(widgetSettings)
    .where(eq(widgetSettings.projectId, projectId));
  return row && row.enabled ? row : null;
}

/**
 * Superficie PUBBLICA cross-origin del widget di assistenza: GET/POST
 * /widget/:slug/*. È embeddata nei siti dei clienti, quindi CORS è aperto e
 * registrato QUI, dentro lo scope incapsulato del plugin (le altre route non
 * ricevono header CORS).
 *
 * Autenticazione: header X-Stubwise-Key confrontato (tempo costante) con la
 * ingestionKey del progetto individuato dallo slug. La chiave è visibile nel
 * sorgente della pagina ospite, per design (stesso modello dell'ingestion SDK):
 * autentica il progetto, non l'utente. Slug sconosciuto e chiave errata
 * producono la stessa 401 (niente enumerazione degli slug). Il controllo sta in
 * preValidation, condiviso da tutte le route del plugin (config e — nei task
 * successivi — conversazioni, messaggi, ticket): una richiesta non autenticata
 * riceve 401 anche con payload malformato.
 *
 * Validazione: come l'ingestion, un payload non valido risponde 422 (contratto
 * col client widget), via schemaErrorFormatter per-route.
 */
export async function widgetRoutes(
  instance: FastifyInstance,
  opts: WidgetRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // CORS solo su questo scope: origin aperto (la chiave è l'autenticazione),
  // GET+POST e i due header che il widget invia. Gestisce anche la preflight OPTIONS.
  await app.register(fastifyCors, {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["content-type", "x-stubwise-key"],
  });

  /**
   * preValidation condivisa da tutte le route del plugin: autentica il progetto
   * dallo slug + X-Stubwise-Key (tempo costante) e decora request.widgetProject.
   * Ramo unico di rifiuto: header assente, slug sconosciuto e chiave errata sono
   * indistinguibili dal client.
   */
  const authenticateWidget = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const provided = request.headers["x-stubwise-key"];
    const { slug } = request.params as { slug: string };
    const [project] = await app.db
      .select({
        id: projects.id,
        name: projects.name,
        ingestionKey: projects.ingestionKey,
      })
      .from(projects)
      .where(eq(projects.slug, slug));
    if (
      typeof provided !== "string" ||
      !project ||
      !keysMatch(provided, project.ingestionKey)
    ) {
      await apiError(reply, 401, "invalid_ingestion_key", "Invalid ingestion key");
      return;
    }
    request.widgetProject = { id: project.id, name: project.name };
  };

  // Bucket per chiave del progetto (fallback IP per le richieste senza header):
  // un progetto loquace non consuma il budget degli altri. Riusato da tutte le
  // route del plugin.
  const rateLimit = {
    ...opts.rateLimit,
    keyGenerator: (request: FastifyRequest) =>
      (request.headers["x-stubwise-key"] as string | undefined) ?? request.ip,
  };

  const configResponseSchema = z.union([
    z.object({ enabled: z.literal(false) }),
    z.object({
      enabled: z.literal(true),
      title: z.string(),
      welcomeMessage: z.string(),
      accentColor: z.string(),
      language: widgetSettingsSchema.shape.language,
      chatEnabled: z.boolean(),
    }),
  ]);

  app.get(
    "/:slug/config",
    {
      config: { rateLimit },
      preValidation: authenticateWidget,
      schema: {
        params: z.object({ slug: z.string().min(1) }),
        response: {
          200: configResponseSchema,
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const project = request.widgetProject!;
      // Superficie pubblica: mai 500 su un errore interno (badge di caricamento
      // rotto nel sito del cliente). La config è per-richiesta e riflette lo stato
      // dei settings/provider al momento: niente cache lato browser/proxy.
      reply.header("cache-control", "no-store");

      const [row] = await app.db
        .select()
        .from(widgetSettings)
        .where(eq(widgetSettings.projectId, project.id));

      // Assente o spento: il widget non si monta. Non si espone alcun dettaglio.
      if (!row || !row.enabled) {
        return { enabled: false as const };
      }

      // La chat è servibile solo se esiste un provider LLM utilizzabile E almeno
      // un repo è esposto al retrieval (lista vuota = chat disabilitata). Se
      // isAvailable non è implementato, si assume disponibile. Se LANCIA (provider
      // misconfigurato, errore DB) non si abbatte l'endpoint pubblico: si degrada
      // a chat spenta e si logga, il widget si monta comunque.
      let llmAvailable = true;
      try {
        llmAvailable = (await app.chatLlm.isAvailable?.())?.available ?? true;
      } catch (err) {
        request.log.warn({ err }, "widget config: controllo disponibilità chat fallito, chat disabilitata");
        llmAvailable = false;
      }
      const chatEnabled = llmAvailable && row.enabledRepositoryIds.length > 0;

      // safeParse con fallback: un `language` corrotto a DB non deve 500-are la
      // superficie pubblica (il default del progetto è l'italiano).
      const language = widgetSettingsSchema.shape.language.safeParse(row.language);

      return {
        enabled: true as const,
        title: row.title,
        welcomeMessage: row.welcomeMessage,
        accentColor: row.accentColor,
        language: language.success ? language.data : ("it" as const),
        chatEnabled,
      };
    },
  );

  /**
   * Apertura (o ripresa) di una conversazione: crea una riga in
   * widget_conversations con l'identità DICHIARATA dal sito ospite (non
   * autenticata). Ritorna il solo conversationId: il client lo persiste per
   * riagganciare lo storico. Richiede un widget attivo (404 widget_disabled
   * altrimenti). Body invalido → 422 (contratto col client widget).
   */
  app.post(
    "/:slug/conversations",
    {
      config: { rateLimit },
      preValidation: authenticateWidget,
      schemaErrorFormatter: unprocessableEntityFormatter,
      schema: {
        params: z.object({ slug: z.string().min(1) }),
        body: widgetConversationCreateBodySchema,
        response: {
          200: z.object({ conversationId: z.uuid() }),
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const project = request.widgetProject!;
      const settings = await loadEnabledSettings(app.db, project.id);
      if (!settings) {
        return apiError(reply, 404, "widget_disabled", "Widget not available");
      }
      const { user } = request.body;
      const [conversation] = await app.db
        .insert(widgetConversations)
        .values({
          projectId: project.id,
          externalUserId: user.id,
          externalUserEmail: user.email ?? null,
          externalUserName: user.name ?? null,
        })
        .returning({ id: widgetConversations.id });
      return { conversationId: conversation!.id };
    },
  );

  const messageSchema = z.object({
    id: z.uuid(),
    role: z.string(),
    content: z.string(),
    // I riferimenti Docs della risposta RAG: forma libera (jsonb), può essere null.
    citations: z.unknown().nullable(),
    ticketId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  });

  /**
   * Storico dei messaggi di una conversazione, in ordine cronologico. Richiede
   * il widget attivo (404 widget_disabled) e un doppio controllo di
   * appartenenza: la conversazione deve essere del progetto autenticato E il
   * suo external_user_id deve combaciare col `userId` in query. Così un
   * conversationId rubato (è nel client) non permette a un altro utente di
   * leggere lo storico altrui: 404 indistinguibile in tutti i casi negativi.
   */
  app.get(
    "/:slug/conversations/:conversationId/messages",
    {
      config: { rateLimit },
      preValidation: authenticateWidget,
      schema: {
        params: z.object({
          slug: z.string().min(1),
          conversationId: z.uuid(),
        }),
        querystring: z.object({ userId: z.string().min(1) }),
        response: {
          200: z.object({ messages: z.array(messageSchema) }),
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const project = request.widgetProject!;
      const settings = await loadEnabledSettings(app.db, project.id);
      if (!settings) {
        return apiError(reply, 404, "widget_disabled", "Widget not available");
      }
      const { conversationId } = request.params;
      const { userId } = request.query;

      const [conversation] = await app.db
        .select({ externalUserId: widgetConversations.externalUserId })
        .from(widgetConversations)
        .where(
          and(
            eq(widgetConversations.id, conversationId),
            eq(widgetConversations.projectId, project.id),
          ),
        );
      // Conversazione inesistente, di un altro progetto, o di un altro utente:
      // 404 indistinguibile (anti-lettura cross-utente con id conversazione rubato).
      if (!conversation || conversation.externalUserId !== userId) {
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
        // Tiebreaker su `id`: due messaggi con lo stesso createdAt (user+assistant
        // ravvicinati) devono avere un ordine stabile e deterministico.
        .orderBy(asc(widgetMessages.createdAt), asc(widgetMessages.id));

      return {
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

  /**
   * Invio di un messaggio utente in una conversazione: RETRIEVAL cross-repo
   * FILTRATO ai repo esposti dal widget → chat RAG in streaming SSE (registro
   * customer service) con eventuale PROPOSTA di ticket via sentinel. Bypassa lo
   * schema di risposta Zod come la chat interna (stream grezzo su reply.raw).
   *
   * Ordine dei controlli (side-effect-free finché non serve): auth (preValidation)
   * → widget attivo → ownership conversazione → CAP giornaliero → pre-flight LLM →
   * insert del messaggio utente → retrieval → streaming. Il cap e il pre-flight
   * precedono qualunque insert/hijack.
   */
  app.post(
    "/:slug/conversations/:conversationId/messages",
    {
      config: { rateLimit },
      preValidation: authenticateWidget,
      schemaErrorFormatter: unprocessableEntityFormatter,
      schema: {
        params: z.object({
          slug: z.string().min(1),
          conversationId: z.uuid(),
        }),
        body: widgetChatMessageBodySchema,
        // Nessuno schema 200: la risposta è uno stream SSE grezzo (reply.hijack).
        // Restano gli errori PRIMA dello stream (401/404/429/503), path normale.
        response: {
          401: errorSchema,
          404: errorSchema,
          429: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const project = request.widgetProject!;
      const settings = await loadEnabledSettings(app.db, project.id);
      if (!settings) {
        return apiError(reply, 404, "widget_disabled", "Widget not available");
      }
      // Nessun repo esposto = chat non servibile (il config dichiara chatEnabled=false):
      // qui lo IMPONIAMO, così un client che ignora il config non brucia budget LLM su
      // risposte prive di documentazione. 404 widget_disabled coerente, PRIMA del cap e
      // di ogni insert.
      if (settings.enabledRepositoryIds.length === 0) {
        return apiError(reply, 404, "widget_disabled", "Widget not available");
      }
      const { conversationId } = request.params;
      const { content, userId } = request.body;

      // Ownership: la conversazione deve essere del progetto autenticato E del
      // `userId` dichiarato (id conversazione rubato → 404 indistinguibile).
      const [conversation] = await app.db
        .select({ externalUserId: widgetConversations.externalUserId })
        .from(widgetConversations)
        .where(
          and(
            eq(widgetConversations.id, conversationId),
            eq(widgetConversations.projectId, project.id),
          ),
        );
      if (!conversation || conversation.externalUserId !== userId) {
        return apiError(reply, 404, "conversation_not_found", "Conversation not found");
      }

      // CAP giornaliero (UTC) dei messaggi utente del progetto, PRIMA di
      // hijackare/consumare token. La JOIN filtra `last_message_at >= inizio
      // giornata` per sfruttare l'indice composito (project_id, last_message_at):
      // così si contano solo le conversazioni toccate oggi, non l'intero storico.
      const dayStart = startOfUtcDay(new Date());
      const [capRow] = await app.db
        .select({ value: count() })
        .from(widgetMessages)
        .innerJoin(
          widgetConversations,
          eq(widgetMessages.conversationId, widgetConversations.id),
        )
        .where(
          and(
            eq(widgetConversations.projectId, project.id),
            gte(widgetConversations.lastMessageAt, dayStart),
            eq(widgetMessages.role, "user"),
            gte(widgetMessages.createdAt, dayStart),
          ),
        );
      // Race benigna e deliberata: due richieste concorrenti possono leggere lo
      // stesso count e superare insieme il cap; l'overshoot è limitato dalla
      // concorrenza e non giustifica un lock sul conteggio del giorno.
      if ((capRow?.value ?? 0) >= opts.dailyMessageCap) {
        return apiError(reply, 429, "widget_chat_cap_reached", "Daily message limit reached");
      }

      // PRE-FLIGHT disponibilità chat: BEFORE l'hijack. Guard con try/catch come
      // il config endpoint: la superficie pubblica non deve 500-are su un provider
      // misconfigurato — un 503 pulito è l'errore corretto e mappabile dalla UI.
      let llmAvailable = true;
      try {
        llmAvailable = (await app.chatLlm.isAvailable?.())?.available ?? true;
      } catch (err) {
        request.log.warn({ err }, "widget chat: controllo disponibilità fallito");
        llmAvailable = false;
      }
      if (!llmAvailable) {
        return apiError(reply, 503, "chat_unavailable", "Chat is not available");
      }

      // Persiste il messaggio utente PRIMA del retrieval/streaming, aggiorna il
      // last_message_at (ordina l'elenco viewer + alimenta il cap del giorno).
      await app.db.insert(widgetMessages).values({
        conversationId,
        role: "user",
        content,
      });
      await app.db
        .update(widgetConversations)
        .set({ lastMessageAt: new Date() })
        .where(eq(widgetConversations.id, conversationId));

      // RETRIEVAL cross-repo FILTRATO ai soli repo esposti dal widget
      // (enabledRepositoryIds). Se l'embedding è down fa fallback full-text.
      const chunks = await retrieveChunksForProject(app.db, app.embeddingClient, project.id, content, {
        k: CHAT_RETRIEVAL_K,
        repositoryIds: settings.enabledRepositoryIds,
        logger: request.log,
      });
      const citations = buildCitations(chunks);
      const language = widgetSettingsSchema.shape.language.safeParse(settings.language);
      const system = buildWidgetSystemPrompt(chunks, {
        language: language.success ? language.data : "it",
      });

      // History: ultime WIDGET_HISTORY_PAIRS coppie (20 messaggi) in ordine
      // cronologico, col messaggio utente corrente già in coda (appena inserito).
      // Si prendono gli ultimi N in DESC (per l'indice) e si riordinano ASC.
      const recent = await app.db
        .select({ role: widgetMessages.role, content: widgetMessages.content })
        .from(widgetMessages)
        .where(eq(widgetMessages.conversationId, conversationId))
        .orderBy(desc(widgetMessages.createdAt), desc(widgetMessages.id))
        .limit(WIDGET_HISTORY_PAIRS * 2);
      const history = recent
        .reverse()
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      // Se la finestra (limit fisso) taglia a metà di una coppia, il primo elemento
      // può essere un `assistant`: l'API Messages di Anthropic esige che il primo
      // messaggio sia `user` (400 altrimenti). Si scartano i non-user in testa.
      while (history.length > 0 && history[0]!.role !== "user") history.shift();

      await streamWidgetChatResponse({
        db: app.db,
        chatLlm: app.chatLlm,
        request,
        reply,
        conversationId,
        system,
        history,
        citations,
        logContext: { projectId: project.id, conversationId },
      });
    },
  );
}

declare module "fastify" {
  interface FastifyRequest {
    /** Progetto autenticato dalla preValidation della superficie widget. */
    widgetProject?: { id: string; name: string };
  }
}
