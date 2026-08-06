import fastifyCors from "@fastify/cors";
import {
  widgetChatMessageBodySchema,
  widgetConversationCreateBodySchema,
  widgetSettingsSchema,
  widgetTicketConfirmBodySchema,
} from "@stubwise/shared";
import { and, asc, count, desc, eq, gte, isNotNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  projects,
  widgetConversations,
  widgetMessages,
  widgets,
} from "@stubwise/db";
import { keysMatch } from "../ingest/shared.js";
import { maybeEnqueueBacklogIntake } from "../backlog/enqueue.js";
import { createTicket } from "../db/tickets.js";
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
   * DEFAULT d'istanza del tetto GIORNALIERO (UTC) di messaggi utente della chat,
   * PER WIDGET: usato quando la riga del widget non ha un override
   * (`dailyMessageCap` null). Superficie pubblica: ogni messaggio consuma token
   * LLM, quindi si limita l'abuso. Da
   * {@link ../app.ts#BuildAppOptions.widgetDailyMessageCap} (default 200).
   */
  dailyMessageCap: number;
  /**
   * DEFAULT d'istanza del tetto GIORNALIERO (UTC) di ticket (source='widget'),
   * PER WIDGET: usato quando la riga del widget non ha un override
   * (`dailyTicketCap` null). Superficie pubblica: ogni ticket crea una riga
   * permanente, quindi si limita l'abuso. Da
   * {@link ../app.ts#BuildAppOptions.widgetDailyTicketCap} (default 50).
   */
  dailyTicketCap: number;
}

/** Numero massimo di coppie (user+assistant) di storico passate all'LLM. */
const WIDGET_HISTORY_PAIRS = 10;

/**
 * Numero di messaggi della conversazione inclusi nella trascrizione del ticket.
 * Dimensionato sull'intake guidato: fino a 3 scambi di domande di chiarimento
 * prima della proposta, che con 10 taglierebbero l'inizio della conversazione.
 */
const WIDGET_TICKET_TRANSCRIPT_MESSAGES = 20;

/** Troncamento di ogni messaggio nella trascrizione, per non gonfiare il body. */
const WIDGET_TICKET_MESSAGE_MAXLEN = 500;

/** Limite del campo `body` di un ticket (allineato allo schema/DB). */
const TICKET_BODY_MAXLEN = 20_000;

/** Inizio della giornata corrente in UTC (per il cap giornaliero e l'indice). */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Riga completa del widget autenticato, decorata su request.widget. */
type WidgetRow = typeof widgets.$inferSelect;

/**
 * Superficie PUBBLICA cross-origin del widget di assistenza: GET/POST
 * /widget/:slug/*. È embeddata nei siti dei clienti, quindi CORS è aperto e
 * registrato QUI, dentro lo scope incapsulato del plugin (le altre route non
 * ricevono header CORS).
 *
 * Autenticazione: header X-Stubwise-Key confrontato (tempo costante) con la
 * `key` di UNO dei widget del progetto individuato dallo slug. La chiave è
 * visibile nel sorgente della pagina ospite, per design (stesso modello
 * dell'ingestion SDK): autentica il widget (e con esso il progetto), non
 * l'utente. Slug sconosciuto, header assente e chiave che non combacia con
 * alcun widget producono la stessa 401 (niente enumerazione degli slug né dei
 * widget). Il controllo sta in preValidation, condiviso da tutte le route del
 * plugin (config, conversazioni, messaggi, ticket): una richiesta non
 * autenticata riceve 401 anche con payload malformato.
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
   * preValidation condivisa da tutte le route del plugin: autentica il widget
   * dallo slug del progetto + X-Stubwise-Key e decora request.widget (la riga
   * completa) e request.widgetProject (id/nome del progetto, comodo per i log).
   *
   * La chiave si confronta con quella di OGNI widget del progetto: keysMatch è
   * timing-safe sul singolo confronto e l'iterazione è bounded (pochi widget per
   * progetto). Ramo unico di rifiuto: header assente, slug sconosciuto e chiave
   * che non combacia con alcun widget sono indistinguibili dal client (stessa
   * 401 `invalid_ingestion_key`).
   */
  const authenticateWidget = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const provided = request.headers["x-stubwise-key"];
    const { slug } = request.params as { slug: string };
    const [project] = await app.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.slug, slug));

    let matched: WidgetRow | undefined;
    if (typeof provided === "string" && project) {
      const rows = await app.db
        .select()
        .from(widgets)
        .where(eq(widgets.projectId, project.id));
      matched = rows.find((w) => keysMatch(provided, w.key));
    }
    if (!project || !matched) {
      await apiError(reply, 401, "invalid_ingestion_key", "Invalid ingestion key");
      return;
    }
    request.widget = matched;
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
      const widget = request.widget!;
      // Superficie pubblica: mai 500 su un errore interno (badge di caricamento
      // rotto nel sito del cliente). La config è per-richiesta e riflette lo stato
      // del widget/provider al momento: niente cache lato browser/proxy.
      reply.header("cache-control", "no-store");

      // Widget spento: non si monta. Non si espone alcun dettaglio.
      if (!widget.enabled) {
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
      const chatEnabled = llmAvailable && widget.enabledRepositoryIds.length > 0;

      // safeParse con fallback: un `language` corrotto a DB non deve 500-are la
      // superficie pubblica (il default del progetto è l'italiano).
      const language = widgetSettingsSchema.shape.language.safeParse(widget.language);

      return {
        enabled: true as const,
        title: widget.title,
        welcomeMessage: widget.welcomeMessage,
        accentColor: widget.accentColor,
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
      const widget = request.widget!;
      if (!widget.enabled) {
        return apiError(reply, 404, "widget_disabled", "Widget not available");
      }
      const { user } = request.body;
      const [conversation] = await app.db
        .insert(widgetConversations)
        .values({
          projectId: widget.projectId,
          widgetId: widget.id,
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
   * il widget attivo (404 widget_disabled) e un triplo controllo di
   * appartenenza: la conversazione deve essere del progetto autenticato, del
   * widget autenticato (widget_id) E il suo external_user_id deve combaciare col
   * `userId` in query. Così un conversationId rubato (è nel client) o la chiave
   * di un ALTRO widget dello stesso progetto non permettono di leggere lo storico
   * altrui: 404 indistinguibile in tutti i casi negativi.
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
      const widget = request.widget!;
      if (!widget.enabled) {
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
            eq(widgetConversations.projectId, widget.projectId),
            eq(widgetConversations.widgetId, widget.id),
          ),
        );
      // Conversazione inesistente, di un altro progetto/widget, o di un altro
      // utente: 404 indistinguibile (anti-lettura cross-utente/cross-widget con
      // id conversazione rubato).
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
      const widget = request.widget!;
      const project = request.widgetProject!;
      if (!widget.enabled) {
        return apiError(reply, 404, "widget_disabled", "Widget not available");
      }
      // Nessun repo esposto = chat non servibile (il config dichiara chatEnabled=false):
      // qui lo IMPONIAMO, così un client che ignora il config non brucia budget LLM su
      // risposte prive di documentazione. 404 widget_disabled coerente, PRIMA del cap e
      // di ogni insert.
      if (widget.enabledRepositoryIds.length === 0) {
        return apiError(reply, 404, "widget_disabled", "Widget not available");
      }
      const { conversationId } = request.params;
      const { content, userId } = request.body;

      // Ownership: la conversazione deve essere del progetto e del widget
      // autenticati E del `userId` dichiarato (id conversazione rubato o chiave di
      // un altro widget → 404 indistinguibile).
      const [conversation] = await app.db
        .select({ externalUserId: widgetConversations.externalUserId })
        .from(widgetConversations)
        .where(
          and(
            eq(widgetConversations.id, conversationId),
            eq(widgetConversations.projectId, widget.projectId),
            eq(widgetConversations.widgetId, widget.id),
          ),
        );
      if (!conversation || conversation.externalUserId !== userId) {
        return apiError(reply, 404, "conversation_not_found", "Conversation not found");
      }

      // CAP giornaliero (UTC) dei messaggi utente DEL WIDGET, PRIMA di
      // hijackare/consumare token. Il cap è l'override sulla riga del widget
      // (dailyMessageCap) o, se null, il default d'istanza (opts). La JOIN filtra
      // per project_id + `last_message_at >= inizio giornata` (colpisce l'indice
      // composito (project_id, last_message_at): niente seq scan su endpoint
      // pubblico); widget_id resta come filtro residuo per contare solo le
      // conversazioni di QUESTO widget toccate oggi, non l'intero storico né gli
      // altri widget del progetto.
      const messageCap = widget.dailyMessageCap ?? opts.dailyMessageCap;
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
            eq(widgetConversations.projectId, widget.projectId),
            eq(widgetConversations.widgetId, widget.id),
            gte(widgetConversations.lastMessageAt, dayStart),
            eq(widgetMessages.role, "user"),
            gte(widgetMessages.createdAt, dayStart),
          ),
        );
      // Race benigna e deliberata: due richieste concorrenti possono leggere lo
      // stesso count e superare insieme il cap; l'overshoot è limitato dalla
      // concorrenza e non giustifica un lock sul conteggio del giorno.
      if ((capRow?.value ?? 0) >= messageCap) {
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
        repositoryIds: widget.enabledRepositoryIds,
        // Filtro FINE per-repo (path filter): restringe alle sole sezioni esposte
        // dal widget. Il filtro non ALLARGA mai la whitelist repositoryIds (una
        // entry per un repo fuori whitelist è inerte: quel repo è già escluso).
        repositoryFilters: widget.repositoryFilters,
        logger: request.log,
      });
      const citations = buildCitations(chunks);
      const language = widgetSettingsSchema.shape.language.safeParse(widget.language);
      const system = buildWidgetSystemPrompt(chunks, {
        language: language.success ? language.data : "it",
        instructions: widget.instructions,
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

  /**
   * Conferma di una segnalazione (ticket) dal widget: crea un ticket nel
   * progetto a partire dalla PROPOSTA (title/body/type) e ne appende identità e
   * trascrizione della conversazione. NON passa dalla pipeline AI (niente
   * createExternalTicket): in v1 i ticket widget sono solo registrati.
   *
   * Ownership come la chat (progetto + userId dichiarato → 404 indistinguibile).
   * Il widget deve essere ATTIVO (404 widget_disabled) ma la segnalazione resta
   * possibile anche a chat spenta: NON si richiede `enabledRepositoryIds.length`.
   * Body invalido → 422.
   */
  app.post(
    "/:slug/conversations/:conversationId/tickets",
    {
      config: { rateLimit },
      preValidation: authenticateWidget,
      schemaErrorFormatter: unprocessableEntityFormatter,
      schema: {
        params: z.object({
          slug: z.string().min(1),
          conversationId: z.uuid(),
        }),
        body: widgetTicketConfirmBodySchema,
        response: {
          200: z.object({ ticketId: z.uuid(), number: z.number().int() }),
          401: errorSchema,
          404: errorSchema,
          429: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const widget = request.widget!;
      const project = request.widgetProject!;
      if (!widget.enabled) {
        return apiError(reply, 404, "widget_disabled", "Widget not available");
      }
      const { conversationId } = request.params;
      const { title, body: proposalBody, type, userId } = request.body;

      // Ownership: la conversazione deve essere del progetto e del widget
      // autenticati E del `userId` dichiarato (id conversazione rubato o chiave di
      // un altro widget → 404 indistinguibile).
      const [conversation] = await app.db
        .select({
          externalUserId: widgetConversations.externalUserId,
          externalUserEmail: widgetConversations.externalUserEmail,
          externalUserName: widgetConversations.externalUserName,
        })
        .from(widgetConversations)
        .where(
          and(
            eq(widgetConversations.id, conversationId),
            eq(widgetConversations.projectId, widget.projectId),
            eq(widgetConversations.widgetId, widget.id),
          ),
        );
      if (!conversation || conversation.externalUserId !== userId) {
        return apiError(reply, 404, "conversation_not_found", "Conversation not found");
      }

      // CAP giornaliero (UTC) dei ticket DEL WIDGET, PRIMA di creare qualsiasi
      // cosa. Il cap è l'override sulla riga del widget (dailyTicketCap) o, se
      // null, il default d'istanza (opts). I ticket non hanno widget_id, quindi
      // si contano i MESSAGGI DI CONFERMA di oggi (widget_messages con ticketId
      // non-null e createdAt >= inizio giornata) JOIN sulle conversazioni del
      // widget: stessa informazione (ogni conferma inserisce esattamente un
      // messaggio con ticketId), già collegata al widget. Race benigna come il
      // cap chat: due richieste concorrenti possono superare insieme il cap,
      // overshoot limitato dalla concorrenza.
      // Nota: cancellare una conversazione/ticket fa scendere il conteggio del
      // giorno (il messaggio di conferma sparisce col cascade). Accettato: oggi
      // è teorico (nessuna cancellazione sulla superficie pubblica).
      const ticketCap = widget.dailyTicketCap ?? opts.dailyTicketCap;
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
            eq(widgetConversations.widgetId, widget.id),
            isNotNull(widgetMessages.ticketId),
            gte(widgetMessages.createdAt, dayStart),
          ),
        );
      if ((capRow?.value ?? 0) >= ticketCap) {
        return apiError(reply, 429, "widget_ticket_cap_reached", "Daily ticket limit reached");
      }

      const language = widgetSettingsSchema.shape.language.safeParse(widget.language);
      const lang = language.success ? language.data : "it";

      // Ultimi N messaggi PRIMA della conferma, in ordine cronologico (DESC +
      // reverse per l'indice, tiebreaker su id come lo storico).
      const recent = await app.db
        .select({ role: widgetMessages.role, content: widgetMessages.content })
        .from(widgetMessages)
        .where(eq(widgetMessages.conversationId, conversationId))
        .orderBy(desc(widgetMessages.createdAt), desc(widgetMessages.id))
        .limit(WIDGET_TICKET_TRANSCRIPT_MESSAGES);
      const transcript = recent.reverse();

      const body = composeWidgetTicketBody({
        proposalBody,
        widgetName: widget.name,
        identity: {
          id: conversation.externalUserId,
          email: conversation.externalUserEmail,
          name: conversation.externalUserName,
        },
        transcript,
        language: lang,
      });

      // Transazione unica: createTicket (che apre già una sua transazione,
      // annidata da drizzle come savepoint) + insert del messaggio di conferma +
      // avanzamento di lastMessageAt. Così un fallimento a metà non lascia un
      // ticket senza messaggio o un lastMessageAt disallineato.
      const ticket = await app.db.transaction(async (tx) => {
        const created = await createTicket(tx, {
          projectId: project.id,
          title,
          body,
          type,
          priority: "medium",
          source: "widget",
        });

        // Feedback/feature su progetto con backlogEnabled → job intake nel
        // backlog di discovery. I ticket widget non hanno mai accodato aiJobs,
        // quindi il valore di ritorno non deve saltare nulla: serve solo
        // l'accodamento, atomico col ticket.
        await maybeEnqueueBacklogIntake(tx, created);

        // Messaggio di conferma nella lingua dei settings, collegato al ticket, +
        // avanzamento di lastMessageAt (ordina l'elenco viewer).
        const confirmation =
          lang === "en"
            ? `Report submitted: #${created.number}`
            : `Segnalazione registrata: #${created.number}`;
        await tx.insert(widgetMessages).values({
          conversationId,
          role: "assistant",
          content: confirmation,
          ticketId: created.id,
        });
        await tx
          .update(widgetConversations)
          .set({ lastMessageAt: new Date() })
          .where(eq(widgetConversations.id, conversationId));
        return created;
      });

      return { ticketId: ticket.id, number: ticket.number };
    },
  );
}

/**
 * Compone il body del ticket widget: blocco IDENTITÀ + separatore + PROPOSTA
 * (con heading) + trascrizione (ultimi messaggi, ognuno troncato). Ogni riga
 * della trascrizione è un blockquote markdown col ruolo tradotto.
 *
 * Budget di troncamento: identità e trascrizione sono contenuto GENERATO da noi
 * e sempre entro il cap; la proposta è testo libero dell'LLM e potenzialmente
 * enorme. Quindi si tronca SOLO la proposta, calcolando lo spazio residuo dopo
 * identità+trascrizione, così che identità e trascrizione non vengano MAI
 * tagliate per colpa di una proposta gigante e il body resti sotto TICKET_BODY_MAXLEN.
 */
function composeWidgetTicketBody(input: {
  proposalBody: string;
  widgetName: string;
  identity: { id: string; email: string | null; name: string | null };
  transcript: { role: string; content: string }[];
  language: "it" | "en";
}): string {
  const { proposalBody, widgetName, identity, transcript, language } = input;
  const labels =
    language === "en"
      ? { header: "Reporter", proposal: "Report", name: "Name", email: "Email", id: "External ID", transcript: "Conversation transcript", user: "user", assistant: "assistant" }
      : { header: "Segnalato da", proposal: "Segnalazione", name: "Nome", email: "Email", id: "ID esterno", transcript: "Trascrizione della conversazione", user: "utente", assistant: "assistente" };

  const identityLines = [`**${labels.header}**`];
  if (identity.name) identityLines.push(`- ${labels.name}: ${identity.name}`);
  if (identity.email) identityLines.push(`- ${labels.email}: ${identity.email}`);
  identityLines.push(`- ${labels.id}: ${identity.id}`);
  // Nome del widget d'origine: "Widget" è un label universale (uguale in it/en).
  // Nome admin-controlled ma lo schema non vieta newline: si collassano in spazio
  // per non spezzare la riga markdown.
  const safeWidgetName = widgetName.replace(/\s*\n+\s*/g, " ");
  identityLines.push(`- Widget: ${safeWidgetName}`);
  const identitySection = identityLines.join("\n");

  const truncate = (s: string): string =>
    s.length > WIDGET_TICKET_MESSAGE_MAXLEN
      ? `${s.slice(0, WIDGET_TICKET_MESSAGE_MAXLEN)}…`
      : s;
  const roleLabel = (role: string): string =>
    role === "assistant" ? labels.assistant : labels.user;
  const transcriptLines = transcript.map(
    // Newline interni collassati: un blockquote su una riga sola per messaggio.
    (m) => `> **${roleLabel(m.role)}:** ${truncate(m.content).replace(/\s*\n+\s*/g, " ")}`,
  );
  const transcriptSection =
    transcriptLines.length > 0
      ? `**${labels.transcript}**\n\n${transcriptLines.join("\n")}`
      : null;

  // Separatore fra sezioni; il join finale ne inserisce uno fra ogni coppia.
  const SEP = "\n\n---\n\n";
  const proposalHeading = `**${labels.proposal}**\n\n`;

  // Spazio riservato a identità + trascrizione + separatori + heading proposta:
  // ciò che resta è il budget massimo per il corpo della proposta. Se la
  // proposta non entra, tronca SOLO lei (identità e trascrizione restano intere).
  const fixedSections = [identitySection];
  if (transcriptSection) fixedSections.push(transcriptSection);
  const fixedLength =
    fixedSections.join(SEP).length +
    // separatore fra identità e la sezione proposta + heading della proposta.
    SEP.length +
    proposalHeading.length;
  const proposalBudget = Math.max(0, TICKET_BODY_MAXLEN - fixedLength);
  const trimmedProposal =
    proposalBody.length > proposalBudget
      ? proposalBody.slice(0, proposalBudget)
      : proposalBody;

  const sections = [identitySection, `${proposalHeading}${trimmedProposal}`];
  if (transcriptSection) sections.push(transcriptSection);
  const composed = sections.join(SEP);
  // Cintura di sicurezza: il budget garantisce già il limite, ma se per un
  // arrotondamento si sforasse, si taglia comunque al massimo del campo body.
  return composed.length > TICKET_BODY_MAXLEN
    ? composed.slice(0, TICKET_BODY_MAXLEN)
    : composed;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Widget autenticato (riga completa) dalla preValidation della superficie widget. */
    widget?: WidgetRow;
    /** Progetto del widget autenticato (id/nome, comodo per i log). */
    widgetProject?: { id: string; name: string };
  }
}
