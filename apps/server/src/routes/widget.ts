import { createHash } from "node:crypto";
import fastifyCors from "@fastify/cors";
import {
  normalizeWidgetOrigin,
  widgetChatMessageBodySchema,
  widgetConversationCreateBodySchema,
  widgetSettingsSchema,
  widgetTicketConfirmBodySchema,
  siteRequestDetailSchema,
  siteRequestListSchema,
} from "@stubwise/shared";
import { and, asc, count, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  decrypt,
  projects,
  widgetConversations,
  widgetMessages,
  widgets,
} from "@stubwise/db";
import { keysMatch } from "../ingest/shared.js";
import { verifyWidgetIdentity, type WidgetIdentity } from "../auth/widget-identity.js";
import { maybeEnqueueBacklogIntake } from "../backlog/enqueue.js";
import { createTicket } from "../db/tickets.js";
import { errorSchema, unprocessableEntityFormatter } from "./shared.js";
import type { RateLimitConfig } from "./shared.js";
import { openConversationFor } from "../services/support-continuation.js";
import { listSiteRequests, siteRequestDetail } from "../services/site-requests.js";
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
    // `authorization`: il token d'identità del cliente (area 8, «L'API per i siti»).
    allowedHeaders: ["content-type", "x-stubwise-key", "authorization"],
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
      // Area 9, F6: un progetto ARCHIVIATO è come uno slug sconosciuto (401).
      .where(and(eq(projects.slug, slug), isNull(projects.archivedAt)));

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
    // Area 8, F3, S16: i siti ammessi. Elenco vuoto = qualunque sito (i widget
    // installati prima); pieno = un'`Origin` assente o fuori elenco è rifiutata
    // qui, prima di ogni scrittura e di ogni chiamata al modello. L'origine
    // dell'istanza è sempre ammessa (l'anteprima nell'app). L'`Origin` la
    // falsifica chiunque non sia un browser: protegge dall'embed su siti
    // altrui, l'autenticazione resta la chiave.
    if (matched.allowedOrigins.length > 0 && !originAllowed(request.headers.origin, matched.allowedOrigins)) {
      await apiError(reply, 403, "origin_not_allowed", "This site may not load the widget");
      return;
    }
    request.widget = matched;
    request.widgetProject = { id: project.id, name: project.name };
  };

  /**
   * Area 8, «L'API per i siti» (S3): l'identità del cliente FIRMATA dal sito,
   * dopo `authenticateWidget`, sulle rotte della conversazione (non sulla
   * config: il widget si monta anche con un token scaduto). Un header
   * `Authorization: Bearer` presente va verificato col segreto del widget:
   * non valido, o widget senza segreto, è la stessa 401 `invalid_identity`.
   * Assente: identità null, e con «Solo clienti verificati» 401
   * `identity_required`.
   */
  const identify = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const widget = request.widget!;
    request.widgetIdentity = null;
    const header = request.headers.authorization;
    if (typeof header === "string" && header.trim() !== "") {
      const token = /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1];
      let identity: WidgetIdentity | null = null;
      if (token && widget.identitySecretEncrypted) {
        try {
          identity = verifyWidgetIdentity(token, { secret: decrypt(widget.identitySecretEncrypted, app.encryptionKey), widgetId: widget.id });
        } catch {
          identity = null;
        }
      }
      if (!identity) {
        await apiError(reply, 401, "invalid_identity", "Invalid customer identity");
        return;
      }
      request.widgetIdentity = identity;
      return;
    }
    if (widget.identityRequired) {
      await apiError(reply, 401, "identity_required", "This site requires a verified customer identity");
    }
  };

  /**
   * Il cliente della richiesta: col token è il suo `sub`, e un id dichiarato
   * diverso è un mismatch (null = la rotta risponde 401 `identity_mismatch`);
   * senza, l'id dichiarato, come prima.
   */
  const customerOf = (request: FastifyRequest, declared: string): string | null => {
    const identity = request.widgetIdentity;
    if (!identity) return declared;
    return identity.sub === declared ? identity.sub : null;
  };
  /**
   * Una conversazione è di chi chiede: lo stesso cliente E, se è VERIFICATA,
   * solo con un token (dichiararne il cliente non basta più).
   */
  const owns = (request: FastifyRequest, customer: string, row: { externalUserId: string; identityVerified: boolean }): boolean =>
    row.externalUserId === customer && (!row.identityVerified || request.widgetIdentity !== null);

  /** Le letture del cliente vogliono SEMPRE il token, anche se la chat non lo chiede. */
  const requireIdentity = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.widgetIdentity) await apiError(reply, 401, "identity_required", "A verified customer identity is required");
  };

  const ownOrigin = (() => {
    try {
      return new URL(app.publicUrl).origin;
    } catch {
      return null;
    }
  })();
  const originAllowed = (header: string | undefined, allowed: readonly string[]): boolean => {
    const origin = typeof header === "string" ? normalizeWidgetOrigin(header) : null;
    return origin !== null && (origin === ownOrigin || allowed.includes(origin));
  };

  // Bucket per chiave del progetto (fallback IP per le richieste senza header):
  // un progetto loquace non consuma il budget degli altri. Riusato da tutte le
  // route del plugin.
  const rateLimit = {
    ...opts.rateLimit,
    keyGenerator: (request: FastifyRequest) =>
      (request.headers["x-stubwise-key"] as string | undefined) ?? request.ip,
  };

  // Area 8, «L'API per i siti»: le letture del cliente hanno anche un bucket
  // per chiave E token (cioè per cliente), così un cliente insistente non
  // consuma il budget del widget intero.
  const rateLimitPerCustomer = {
    ...opts.rateLimit,
    keyGenerator: (request: FastifyRequest) =>
      `${(request.headers["x-stubwise-key"] as string | undefined) ?? request.ip}:${createHash("sha256").update(String(request.headers.authorization ?? "")).digest("hex").slice(0, 32)}`,
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
      config: { rateLimit, access: { kind: "public" } },
      preValidation: authenticateWidget,
      schema: {
        params: z.object({ slug: z.string().min(1) }),
        response: {
          200: configResponseSchema,
          401: errorSchema,
          403: errorSchema,
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
      config: { rateLimit, access: { kind: "public" } },
      preValidation: [authenticateWidget, identify],
      schemaErrorFormatter: unprocessableEntityFormatter,
      schema: {
        params: z.object({ slug: z.string().min(1) }),
        body: widgetConversationCreateBodySchema,
        response: {
          200: z.object({ conversationId: z.uuid() }),
          401: errorSchema,
          403: errorSchema,
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
      const customer = customerOf(request, user.id);
      if (customer === null) return apiError(reply, 401, "identity_mismatch", "The declared customer is not the signed one");
      const identity = request.widgetIdentity;
      const [conversation] = await app.db
        .insert(widgetConversations)
        .values({
          projectId: widget.projectId,
          widgetId: widget.id,
          externalUserId: customer,
          // Col token, email e nome FIRMATI vincono su quelli dichiarati.
          externalUserEmail: identity ? (identity.email ?? user.email ?? null) : (user.email ?? null),
          externalUserName: identity ? (identity.name ?? user.name ?? null) : (user.name ?? null),
          identityVerified: identity !== null,
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
      config: { rateLimit, access: { kind: "public" } },
      preValidation: [authenticateWidget, identify],
      schema: {
        params: z.object({
          slug: z.string().min(1),
          conversationId: z.uuid(),
        }),
        querystring: z.object({ userId: z.string().min(1) }),
        response: {
          200: z.object({ messages: z.array(messageSchema) }),
          401: errorSchema,
          403: errorSchema,
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
      const customer = customerOf(request, request.query.userId);
      if (customer === null) return apiError(reply, 401, "identity_mismatch", "The declared customer is not the signed one");

      const [conversation] = await app.db
        .select({ externalUserId: widgetConversations.externalUserId, identityVerified: widgetConversations.identityVerified })
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
      if (!conversation || !owns(request, customer, conversation)) {
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
      config: { rateLimit, access: { kind: "public" } },
      preValidation: [authenticateWidget, identify],
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
          403: errorSchema,
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
      const { content } = request.body;
      const userId = customerOf(request, request.body.userId);
      if (userId === null) return apiError(reply, 401, "identity_mismatch", "The declared customer is not the signed one");

      // Ownership: la conversazione deve essere del progetto e del widget
      // autenticati E del `userId` dichiarato (id conversazione rubato o chiave di
      // un altro widget → 404 indistinguibile).
      const [conversation] = await app.db
        .select({ externalUserId: widgetConversations.externalUserId, identityVerified: widgetConversations.identityVerified })
        .from(widgetConversations)
        .where(
          and(
            eq(widgetConversations.id, conversationId),
            eq(widgetConversations.projectId, widget.projectId),
            eq(widgetConversations.widgetId, widget.id),
          ),
        );
      if (!conversation || !owns(request, userId, conversation)) {
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

      // Area 8, F3, S17: una conversazione con un esito è CHIUSA; il messaggio
      // va nella sua successiva (creata se manca, una sola). Dopo la proprietà,
      // il cap e il pre-flight: è la prima scrittura.
      const targetId = await openConversationFor(app.db, conversationId, { identityVerified: request.widgetIdentity !== null });
      // Una catena che, senza token, porterebbe in una conversazione verificata: non è sua.
      if (targetId === null) return apiError(reply, 404, "conversation_not_found", "Conversation not found");

      // Persiste il messaggio utente PRIMA del retrieval/streaming, aggiorna il
      // last_message_at (ordina l'elenco viewer + alimenta il cap del giorno).
      await app.db.insert(widgetMessages).values({
        conversationId: targetId,
        role: "user",
        content,
      });
      await app.db
        .update(widgetConversations)
        .set({ lastMessageAt: new Date() })
        .where(eq(widgetConversations.id, targetId));

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
        .where(eq(widgetMessages.conversationId, targetId))
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
        conversationId: targetId,
        // Il widget impara l'id della successiva (un widget vecchio ignora l'evento).
        announceConversation: targetId !== conversationId,
        system,
        history,
        citations,
        logContext: { projectId: project.id, conversationId: targetId },
        projectId: project.id,
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
  /**
   * Area 8, «L'API per i siti» (S4): le richieste e i ticket del cliente
   * FIRMATO dal sito. Le regole stanno in `services/site-requests.ts`.
   */
  app.get(
    "/:slug/me/requests",
    {
      config: { rateLimit: rateLimitPerCustomer, access: { kind: "public" } },
      preValidation: [authenticateWidget, identify, requireIdentity],
      schema: {
        params: z.object({ slug: z.string().min(1) }),
        response: { 200: siteRequestListSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      // Widget spento = spento anche per il sito (review finale): come la chat.
      if (!request.widget!.enabled) return apiError(reply, 404, "widget_disabled", "Widget not available");
      return listSiteRequests(app.db, request.widget!, request.widgetIdentity!.sub);
    },
  );

  /**
   * S4b: il dettaglio, coi messaggi della SUA conversazione col widget. Il
   * codice si cerca solo fra le sue: «non esiste» e «non è tua» sono lo
   * stesso 404.
   */
  app.get(
    "/:slug/me/requests/:code",
    {
      config: { rateLimit: rateLimitPerCustomer, access: { kind: "public" } },
      preValidation: [authenticateWidget, identify, requireIdentity],
      schema: {
        params: z.object({ slug: z.string().min(1), code: z.string().min(1).max(40) }),
        response: { 200: siteRequestDetailSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!request.widget!.enabled) return apiError(reply, 404, "widget_disabled", "Widget not available");
      const detail = await siteRequestDetail(app.db, request.widget!, request.widgetIdentity!.sub, request.params.code);
      if (!detail) return apiError(reply, 404, "not_found", "Not found");
      return detail;
    },
  );

  app.post(
    "/:slug/conversations/:conversationId/tickets",
    {
      config: { rateLimit, access: { kind: "public" } },
      preValidation: [authenticateWidget, identify],
      schemaErrorFormatter: unprocessableEntityFormatter,
      schema: {
        params: z.object({
          slug: z.string().min(1),
          conversationId: z.uuid(),
        }),
        body: widgetTicketConfirmBodySchema,
        response: {
          // `conversationId` (area 8, F3, S17, additivo): dove è finita la conferma
          // (la successiva, se la conversazione era chiusa).
          200: z.object({ ticketId: z.uuid(), number: z.number().int(), conversationId: z.uuid() }),
          401: errorSchema,
          403: errorSchema,
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
      const { title, body: proposalBody, type } = request.body;
      const userId = customerOf(request, request.body.userId);
      if (userId === null) return apiError(reply, 401, "identity_mismatch", "The declared customer is not the signed one");

      // Ownership: la conversazione deve essere del progetto e del widget
      // autenticati E del `userId` dichiarato (id conversazione rubato o chiave di
      // un altro widget → 404 indistinguibile).
      const [conversation] = await app.db
        .select({
          externalUserId: widgetConversations.externalUserId,
          externalUserEmail: widgetConversations.externalUserEmail,
          externalUserName: widgetConversations.externalUserName,
          identityVerified: widgetConversations.identityVerified,
        })
        .from(widgetConversations)
        .where(
          and(
            eq(widgetConversations.id, conversationId),
            eq(widgetConversations.projectId, widget.projectId),
            eq(widgetConversations.widgetId, widget.id),
          ),
        );
      if (!conversation || !owns(request, userId, conversation)) {
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

      // Area 8, F3, S17: su una conversazione chiusa la conferma va alla successiva.
      const targetId = await openConversationFor(app.db, conversationId, { identityVerified: request.widgetIdentity !== null });
      // Una catena che, senza token, porterebbe in una conversazione verificata: non è sua.
      if (targetId === null) return apiError(reply, 404, "conversation_not_found", "Conversation not found");

      // Ultimi N messaggi PRIMA della conferma, in ordine cronologico (DESC +
      // reverse per l'indice, tiebreaker su id come lo storico).
      const recentOf = (id: string) =>
        app.db
          .select({ role: widgetMessages.role, content: widgetMessages.content })
          .from(widgetMessages)
          .where(eq(widgetMessages.conversationId, id))
          .orderBy(desc(widgetMessages.createdAt), desc(widgetMessages.id))
          .limit(WIDGET_TICKET_TRANSCRIPT_MESSAGES);
      // La trascrizione è dove la proposta è nata: la successiva se ha già i
      // messaggi (un widget vecchio che scrive alla chiusa), altrimenti la
      // conversazione su cui si conferma — una successiva appena aperta è vuota
      // (review F3).
      let recent = await recentOf(targetId);
      if (targetId !== conversationId && !recent.some((m) => m.role === "user")) recent = await recentOf(conversationId);
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
          conversationId: targetId,
          role: "assistant",
          content: confirmation,
          ticketId: created.id,
        });
        await tx
          .update(widgetConversations)
          .set({ lastMessageAt: new Date() })
          .where(eq(widgetConversations.id, targetId));
        return created;
      });

      return { ticketId: ticket.id, number: ticket.number, conversationId: targetId };
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
    /** Area 8, «L'API per i siti»: il cliente firmato dal sito (null = dichiarato). */
    widgetIdentity?: WidgetIdentity | null;
  }
}
