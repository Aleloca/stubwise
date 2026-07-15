import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createRequire } from "node:module";
import type { Db } from "@stubwise/db";
import { createEmbeddingClient, type EmbeddingClient } from "@stubwise/embeddings";
import { aiJobRoutes, ticketUsageRoutes } from "./routes/ai-jobs.js";
import { aiProviderRoutes } from "./routes/ai-providers.js";
import { aiUsageCostsRoutes } from "./routes/usage-costs.js";
import { aiUsageSnapshotsRoutes } from "./routes/usage-snapshots.js";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentRoutes,
  ticketAttachmentRoutes,
} from "./routes/attachments.js";
import { authRoutes } from "./routes/auth.js";
import { commentRoutes } from "./routes/comments.js";
import { createAnthropicChatLlm, type ChatLlm } from "./routes/chat-llm.js";
import { docsChatRoutes } from "./routes/docs-chat.js";
import { docsRoutes } from "./routes/docs.js";
import { gitAccountRoutes } from "./routes/git-accounts.js";
import { gitIdentityRoutes } from "./routes/git-identity-routes.js";
import { inboundRoutes } from "./routes/inbound.js";
import { ingestRoutes } from "./routes/ingest.js";
import { widgetRoutes } from "./routes/widget.js";
import { monitorRoutes } from "./routes/monitor.js";
import { milestoneRoutes } from "./routes/milestones.js";
import { projectDocsRoutes } from "./routes/project-docs.js";
import { projectEnvFileRoutes } from "./routes/project-env-files.js";
import { projectRoutes } from "./routes/projects.js";
import { repositoryRoutes } from "./routes/repositories.js";
import { serverRoutes } from "./routes/servers.js";
import { serverCheckRoutes } from "./routes/servers-checks.js";
import { savedViewRoutes } from "./routes/saved-views.js";
import { searchRoutes } from "./routes/search.js";
import { settingsRoutes } from "./routes/settings.js";
import type { RateLimitConfig } from "./routes/shared.js";
import { slackRoutes } from "./slack/routes.js";
import { slackIdentityRoutes } from "./slack/identity-routes.js";
import type { SlackClientFactory } from "./slack/creds.js";
import { ticketRoutes } from "./routes/tickets.js";
import { userRoutes } from "./routes/users.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { widgetAdminRoutes } from "./routes/widget-admin.js";
import { getActiveStorage, type ObjectStorage, type StorageFactory } from "./storage/index.js";

// Versione letta dal package.json (accanto a src/ e a dist/, quindi il
// percorso relativo vale sia in sviluppo che dopo la build).
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    /** Chiave AES-256 (32 byte) per cifrare le credenziali git dei progetti. */
    encryptionKey: Buffer;
    /**
     * URL pubblico dell'istanza (PUBLIC_URL), senza slash finale. Serve a
     * comporre l'URL assoluto del webhook (`${publicUrl}/webhooks/git/:slug`)
     * da registrare sul provider git.
     */
    publicUrl: string;
    /**
     * Risolve l'ObjectStorage attivo a runtime dalle instance settings, o
     * `null` se lo storage non è configurato/valido. Iniettabile nei test via
     * BuildAppOptions.storageFactory (fake in-memory).
     */
    storage(): Promise<ObjectStorage | null>;
    /**
     * Client di embedding (OpenAI-compatibile) per la ricerca semantica e la
     * chat RAG sui Docs. Iniettabile nei test via BuildAppOptions.embeddingClient
     * (fake deterministico, senza rete); altrimenti costruito dalla config.
     */
    embeddingClient: EmbeddingClient;
  }
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  db?: Db;
  /** Firma il cookie di sessione. Necessario perché login/sessioni funzionino. */
  sessionSecret?: string;
  /**
   * Chiave di cifratura delle credenziali: 32 byte codificati in base64
   * (stesso formato di ENCRYPTION_KEY, vedi config.ts). Necessaria per le
   * route dei progetti.
   */
  encryptionKey?: string;
  /**
   * URL pubblico dell'istanza (PUBLIC_URL). Serve a comporre l'URL assoluto
   * del webhook da registrare sul provider git. Necessario per la route di
   * configurazione automatica del webhook.
   */
  publicUrl?: string;
  /**
   * Limite di rate per POST /ingest/:slug, contato per chiave di ingestion.
   * Override pensato per i test; default 300 richieste al minuto.
   */
  ingestRateLimit?: RateLimitConfig;
  /**
   * Limite di rate per login e register, contato per IP: argon2 è
   * deliberatamente costoso e senza limite sarebbe un vettore di DoS.
   * Override pensato per i test; default 10 richieste al minuto.
   */
  authRateLimit?: RateLimitConfig;
  /**
   * Fidarsi degli header X-Forwarded-* del reverse proxy (Caddy nel deploy
   * Docker). Va abilitato dietro un proxy affinché `secure: "auto"` sul cookie
   * di sessione veda l'HTTPS terminato dal proxy (X-Forwarded-Proto) e imposti
   * il flag Secure. Default false: in test e in sviluppo diretto non c'è proxy.
   */
  trustProxy?: boolean;
  /**
   * Fabbrica dello storage attivo. Default {@link getActiveStorage}, che legge
   * le instance settings e costruisce il client S3. Override pensato per i
   * test: inietta un fake in-memory senza toccare la rete.
   */
  storageFactory?: StorageFactory;
  /**
   * Fabbrica del client Slack (views.open / users.info). Default: client reale
   * via fetch globale, costruito dal bot token decifrato. Override pensato per
   * i test: inietta un fake che non tocca la rete Slack.
   */
  slackClientFactory?: SlackClientFactory;
  /**
   * Sorgente del tempo per la verifica della firma Slack (anti-replay).
   * Default: Date.now. Override nei test per firmare con un timestamp
   * deterministico.
   */
  slackNow?: () => number;
  /**
   * POST best-effort verso un response_url di Slack (risposta differita di
   * `/docs` post-ack). Default: fetch JSON con try/catch. Override pensato per i
   * test: inietta uno spy che non tocca la rete e si può attendere.
   */
  slackPostResponse?: (url: string, payload: unknown) => Promise<void>;
  /**
   * Client di embedding per la ricerca semantica / chat RAG sui Docs. Default:
   * client reale {@link createEmbeddingClient} costruito da embeddingBaseUrl /
   * embeddingModel / embeddingApiKey. Override pensato per i test: inietta un
   * fake deterministico (createFakeEmbeddingClient) senza toccare la rete.
   */
  embeddingClient?: EmbeddingClient;
  /** Base URL OpenAI-compatibile per l'embedding (default {@link createEmbeddingClient}). */
  embeddingBaseUrl?: string;
  /** Modello di embedding (es. bge-m3). */
  embeddingModel?: string;
  /** API key opzionale per l'endpoint di embedding. */
  embeddingApiKey?: string;
  /**
   * LLM della chat RAG sui Docs. Default: implementazione reale
   * {@link createAnthropicChatLlm} che legge il primo provider AI `api_key`
   * abilitato (decifrato con encryptionKey) e stremma via SDK Anthropic.
   * Override pensato per i test: inietta un fake che emette delta canned senza
   * toccare la rete né richiedere credenziali.
   */
  chatLlm?: ChatLlm;
  /**
   * Tetto GIORNALIERO (UTC) di messaggi utente della chat widget, per progetto:
   * il widget è pubblico (chiave nel sorgente ospite) e ogni messaggio consuma
   * token LLM, quindi si limita l'abuso. Default 200. Override pensato per i test
   * (cap basso) e per la config di deploy.
   */
  widgetDailyMessageCap?: number;
  /**
   * Tetto GIORNALIERO (UTC) di ticket (segnalazioni) creati dal widget, per
   * progetto: come il cap dei messaggi, la superficie è pubblica e ogni ticket
   * crea una riga permanente, quindi si limita l'abuso. Default 50. Override
   * pensato per i test (cap basso) e per la config di deploy.
   */
  widgetDailyTicketCap?: number;
  /**
   * Limite di rate della superficie pubblica /monitor (ingest + config), contato
   * per chiave del server. Server-to-server con batch periodici: cap alto.
   * Override pensato per i test; default 600 richieste al minuto.
   */
  monitorRateLimit?: RateLimitConfig;
}

/**
 * Crea l'istanza Fastify con plugin e route registrati.
 * Non legge process.env: la configurazione arriva dalle opzioni,
 * così i test possono usare `app.inject` senza variabili d'ambiente.
 */
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false });

  // Validazione e serializzazione via Zod su tutta l'app: gli schemi delle
  // route sono oggetti Zod e (Task 9) diventeranno la fonte dell'OpenAPI.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Gli errori "previsti" (validazione Fastify/Zod, statusCode < 500) passano
  // intatti: il loro messaggio è pensato per il client. Tutto il resto viene
  // loggato per intero ma risposto con un 500 generico, così i dettagli del
  // driver o interni non finiscono mai nel corpo della risposta.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (error.code === "FST_ERR_VALIDATION" || statusCode < 500) {
      return reply.code(statusCode).send(error);
    }
    request.log.error(error);
    return reply.code(500).send({ message: "Internal error" });
  });

  // L'augmentation del modulo tipizza `db` come sempre presente, ma la
  // decorazione è condizionale: il getter rende l'errore esplicito se una
  // route tocca il db quando l'app è stata costruita senza (es. unit test).
  const db = opts.db;
  app.decorate("db", {
    getter(): Db {
      if (!db) {
        throw new Error("buildApp chiamata senza db");
      }
      return db;
    },
  });

  // Decodifica subito (fail fast su una chiave malformata), getter come per
  // db: l'app si costruisce anche senza chiave, esplode solo chi la usa.
  const encryptionKey = opts.encryptionKey
    ? Buffer.from(opts.encryptionKey, "base64")
    : undefined;
  if (encryptionKey && encryptionKey.length !== 32) {
    throw new Error("encryptionKey deve essere 32 byte codificati in base64");
  }
  app.decorate("encryptionKey", {
    getter(): Buffer {
      if (!encryptionKey) {
        throw new Error("buildApp chiamata senza encryptionKey");
      }
      return encryptionKey;
    },
  });

  // URL pubblico, normalizzato senza slash finale. Getter come gli altri:
  // esplode solo chi compone l'URL del webhook senza averlo configurato.
  const publicUrl = opts.publicUrl?.replace(/\/+$/, "");
  app.decorate("publicUrl", {
    getter(): string {
      if (!publicUrl) {
        throw new Error("buildApp chiamata senza publicUrl");
      }
      return publicUrl;
    },
  });

  // Storage attivo risolto a runtime. La factory (reale o fake nei test) riceve
  // db ed encryptionKey già risolti dai getter, così le route non li ripassano.
  const storageFactory = opts.storageFactory ?? getActiveStorage;
  app.decorate("storage", function storage(this: FastifyInstance) {
    return storageFactory(this.db, this.encryptionKey);
  });

  // Client di embedding per la ricerca semantica / chat RAG sui Docs. Nei test
  // si inietta un fake deterministico; in produzione si costruisce dalla config
  // (default Ollama in-rete). Costruito una volta e decorato sull'app: le route
  // Docs lo leggono da `app.embeddingClient`.
  const embeddingClient =
    opts.embeddingClient ??
    createEmbeddingClient({
      baseUrl: opts.embeddingBaseUrl ?? "http://ollama:11434/v1",
      model: opts.embeddingModel ?? "bge-m3",
      ...(opts.embeddingApiKey !== undefined ? { apiKey: opts.embeddingApiKey } : {}),
    });
  app.decorate("embeddingClient", embeddingClient);

  // LLM della chat RAG sui Docs. Nei test si inietta un fake (delta canned); in
  // produzione si costruisce l'implementazione reale via SDK Anthropic, che a
  // runtime legge il primo provider AI `api_key` abilitato (decifrato con
  // encryptionKey) — gli account/oauth non sono supportati dall'SDK HTTP. La
  // costruzione è lazy via getter: db/encryptionKey sono risolti dai loro getter
  // solo al primo uso, coerente con storage/embedding (l'app si costruisce anche
  // senza, esplode solo chi tocca la chat senza averli configurati).
  let realChatLlm: ChatLlm | undefined;
  const getRealChatLlm = (): ChatLlm => {
    realChatLlm ??= createAnthropicChatLlm({
      db: app.db,
      encryptionKey: app.encryptionKey,
    });
    return realChatLlm;
  };
  const chatLlm: ChatLlm =
    opts.chatLlm ?? {
      stream(input) {
        return getRealChatLlm().stream(input);
      },
      // Pre-flight inoltrato all'impl reale (controllo provider api_key), così la
      // route può rispondere 503 PRIMA dell'hijack dello stream se non servibile.
      isAvailable() {
        return getRealChatLlm().isAvailable!();
      },
    };
  app.decorate("chatLlm", chatLlm);

  // Senza secret il plugin si registra comunque (parsing dei cookie), ma
  // firmare il cookie di sessione fallisce: stesso spirito del getter su db.
  void app.register(fastifyCookie, { secret: opts.sessionSecret });

  // Upload allegati: un solo file per richiesta, max 10 MB. Oltre il limite,
  // @fastify/multipart lancia (FST_REQ_FILE_TOO_LARGE) leggendo il file.
  void app.register(fastifyMultipart, {
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  // Rate limiting opt-in (`global: false`): nessuna route è limitata di
  // default, lo diventano solo quelle che dichiarano `config.rateLimit`
  // (ingestion per chiave, login/register per IP). Store in-memory: per un
  // deployment self-hosted a singola istanza è sufficiente.
  void app.register(fastifyRateLimit, { global: false });

  // Spec OpenAPI derivata dagli schemi Zod delle route. Va registrato PRIMA
  // delle route, altrimenti @fastify/swagger non le vede. jsonSchemaTransform
  // converte gli schemi Zod in JSON Schema dentro il documento.
  // Le route registrate con path "/" sotto un prefisso esistono anche nella
  // variante con slash finale (prefixTrailingSlash "both") e Fastify riusa lo
  // stesso oggetto routeOptions mutandone la url: nella spec arriverebbe
  // "/api/tickets/". Normalizziamo togliendo lo slash finale, che è la forma
  // canonica usata da client e test.
  void app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Stubwise API", version },
    },
    transform: (input) => {
      const { schema, url } = jsonSchemaTransform(input);
      return { schema, url: url.length > 1 ? url.replace(/\/$/, "") : url };
    },
  });

  void app.register(authRoutes, {
    prefix: "/api/auth",
    rateLimit: opts.authRateLimit ?? { max: 10, timeWindow: "1 minute" },
    // Necessaria per gli inviti originati dal workspace Slack: deriva
    // email/avatar dal profilo Slack server-side. Fake nei test.
    slackClientFactory: opts.slackClientFactory,
  });
  // Account git riutilizzabili (credenziali slegate dal progetto): lettura per
  // ogni utente (scelta in fase di creazione progetto), scrittura solo admin.
  void app.register(gitAccountRoutes, { prefix: "/api/git-accounts" });
  // Progetti (gruppi): CRUD del raggruppamento product-level (ticket/milestone)
  // con le impostazioni di prodotto (provider AI, auto-update docs).
  void app.register(projectRoutes, { prefix: "/api/projects" });
  // CRUD dei widget di assistenza e viewer conversazioni, per progetto (API
  // interna della SPA, distinta dalla superficie pubblica /widget). Sotto
  // /api/projects/:projectId.
  void app.register(widgetAdminRoutes, { prefix: "/api/projects" });
  // Repository: il singolo repo git (ex "progetto") con setup git, branch,
  // webhook, ingestion, docs. Appartiene sempre a un progetto.
  void app.register(repositoryRoutes, { prefix: "/api/repositories" });
  // File d'ambiente, materializzati nel worktree del repo: sono repository-level
  // (il parametro :id dell'URL è il repositoryId).
  void app.register(projectEnvFileRoutes, { prefix: "/api/repositories" });
  // Monitoraggio server: CRUD interno dei server monitorati (chiave agente
  // one-shot, associazione N:M ai progetti, soglie alert). API della SPA,
  // distinta dalla superficie pubblica /monitor usata dall'agente.
  void app.register(serverRoutes, { prefix: "/api/servers" });
  // Check di servizio e metriche time-series di un server: secondo plugin sullo
  // stesso prefix (i DSN dei check DB restano cifrati, mai in risposta).
  void app.register(serverCheckRoutes, { prefix: "/api/servers" });
  void app.register(ticketRoutes, { prefix: "/api/tickets" });
  // Documentazione (non-chat): trigger/stato generazione, hub spazi, albero,
  // pagina, CRUD pagine manuali. Path interni completi (es.
  // /projects/:projectId/docs/generate, /docs/spaces) sotto /api.
  void app.register(docsRoutes, { prefix: "/api" });
  // Chat RAG in streaming sui Docs (M6.5): plugin separato perché bypassa lo
  // schema di risposta Zod (stream SSE grezzo su reply.raw). Path interno
  // completo `/projects/:projectId/docs/chat` sotto /api.
  void app.register(docsChatRoutes, { prefix: "/api" });
  // Documentazione a livello di PROGETTO (Fase 2 multi-repo): hub spazi aggregato,
  // ricerca cross-repo, chat RAG cross-repo su sessione project-level. Path interni
  // completi (es. /projects/:projectId/docs/spaces, .../docs/chat) sotto /api.
  // Stesso prefisso /api delle altre route docs: i path portano già /projects.
  void app.register(projectDocsRoutes, { prefix: "/api" });
  // Milestone di progetto: pianificazione e avanzamento, per ogni utente.
  void app.register(milestoneRoutes, { prefix: "/api/milestones" });
  // Viste salvate dei filtri della lista ticket: private o condivise.
  void app.register(savedViewRoutes, { prefix: "/api/saved-views" });
  // Ricerca globale (spotlight Cmd/K): full-text federata cross-entità e
  // cronologia unificata dei risultati cliccati. Path: /api/search[/history].
  void app.register(searchRoutes, { prefix: "/api/search" });
  // I commenti vivono sotto il singolo ticket: il prefisso porta il
  // parametro :ticketId, disponibile nelle route come request.params.
  void app.register(commentRoutes, { prefix: "/api/tickets/:ticketId/comments" });
  // Stesso schema dei commenti: la timeline dei job AI vive sotto il ticket.
  void app.register(aiJobRoutes, { prefix: "/api/tickets/:ticketId/jobs" });
  // Riepilogo consumi AI del ticket (token + costo per modello).
  void app.register(ticketUsageRoutes, { prefix: "/api/tickets/:ticketId/usage" });
  // Allegati di un ticket: upload e lista vivono sotto il singolo ticket.
  void app.register(ticketAttachmentRoutes, { prefix: "/api/tickets/:ticketId/attachments" });
  // Download e delete per id di allegato, non vincolati al path del ticket.
  void app.register(attachmentRoutes, { prefix: "/api/attachments" });
  void app.register(userRoutes, { prefix: "/api/users" });
  // Impostazioni di automazione AI (regole per tipo): solo admin.
  void app.register(settingsRoutes, { prefix: "/api/settings" });
  // Provider AI (credenziali del worker, secret cifrata write-only): solo admin.
  void app.register(aiProviderRoutes, { prefix: "/api/ai-providers" });
  // Dashboard consumi AI (costi/token aggregati): solo admin.
  void app.register(aiUsageCostsRoutes, { prefix: "/api/ai-usage" });
  // Usage residuo abbonamento: ultimo snapshot per credenziale account. Solo admin.
  void app.register(aiUsageSnapshotsRoutes, { prefix: "/api/ai-usage" });
  // Superficie pubblica per gli SDK: fuori da /api, CORS aperto solo qui
  // (registrato dentro il plugin), autenticazione via X-Stubwise-Key.
  void app.register(ingestRoutes, {
    prefix: "/ingest",
    rateLimit: opts.ingestRateLimit ?? { max: 300, timeWindow: "1 minute" },
  });
  // Superficie pubblica del widget di assistenza embeddato nei siti dei clienti:
  // fuori da /api, CORS aperto solo qui (registrato dentro il plugin),
  // autenticazione via X-Stubwise-Key (ingestionKey del progetto). Riusa il
  // rate-limit dell'ingestion (stessa natura pubblica per-chiave).
  void app.register(widgetRoutes, {
    prefix: "/widget",
    rateLimit: opts.ingestRateLimit ?? { max: 300, timeWindow: "1 minute" },
    dailyMessageCap: opts.widgetDailyMessageCap ?? 200,
    dailyTicketCap: opts.widgetDailyTicketCap ?? 50,
  });
  // Superficie pubblica del monitoraggio server: fuori da /api, niente CORS
  // (server-to-server, nessun browser), autenticazione via X-Stubwise-Server-Key
  // (sha256 → key_hash). L'agente installato sull'host fa ingest e scarica la
  // config. Cap di rate alto: batch periodici da molti server.
  void app.register(monitorRoutes, {
    prefix: "/monitor",
    rateLimit: opts.monitorRateLimit ?? { max: 600, timeWindow: "1 minute" },
  });
  // Webhook generico per chiamanti esterni: POST /api/inbound/:slug/ticket.
  // Stessa autenticazione/CORS/rate-limit dell'ingestion SDK, ma crea un
  // singolo ticket con source "webhook" e attribuzione opzionale per email.
  void app.register(inboundRoutes, {
    prefix: "/api/inbound",
    rateLimit: opts.ingestRateLimit ?? { max: 300, timeWindow: "1 minute" },
  });
  // Webhook git dei provider (chiusura ticket al merge): fuori da /api, niente
  // sessione, autenticazione via firma HMAC. Il parser raw-body è registrato
  // dentro lo scope del plugin, quindi non tocca il parsing JSON di /api né di
  // /ingest.
  void app.register(webhookRoutes, { prefix: "/webhooks" });

  // Integrazione Slack: slash command + interactivity (modal Block Kit). Sotto
  // /api/slack ma autenticata SOLO dalla firma Slack (niente sessione). Il
  // parser raw-body urlencoded è scoped a questo plugin: non tocca /api né
  // /ingest. La fabbrica del client e la sorgente del tempo sono iniettabili
  // per i test (fake senza rete, timestamp deterministico).
  void app.register(slackRoutes, {
    prefix: "/api/slack",
    slackClientFactory: opts.slackClientFactory,
    now: opts.slackNow,
    // STESSE istanze embeddingClient/chatLlm della chat web (decorate sull'app):
    // la risposta RAG di `/docs` via Slack riusa identico retrieval + LLM. Il
    // publicUrl compone i link alle citazioni (può essere assente in test/unit:
    // slackRoutes lo legge in modo difensivo dal decorator se non passato).
    embeddingClient,
    chatLlm,
    ...(publicUrl !== undefined ? { publicUrl } : {}),
    ...(opts.slackPostResponse ? { postResponse: opts.slackPostResponse } : {}),
  });

  // Gestione dell'identità Slack degli utenti (link/unlink + picker membri
  // workspace): solo admin, JSON, sessione. Plugin separato da slackRoutes
  // (che è signature-authed e usa un parser urlencoded scoped). Montato sotto
  // /api: i path interni (`/users/:id/slack`, `/slack/workspace-users`)
  // risultano così completi. Riusa la stessa SlackClientFactory iniettabile.
  void app.register(slackIdentityRoutes, {
    prefix: "/api",
    slackClientFactory: opts.slackClientFactory,
  });

  // Linking identità git/Bitbucket → membro (gemello di slackIdentityRoutes),
  // per attribuire i commit alle persone nel daily activity report.
  void app.register(gitIdentityRoutes, { prefix: "/api" });

  app.get("/health", async () => ({ status: "ok" }));

  // Documento JSON puro, niente Swagger UI: il sito di documentazione
  // (Task 28) renderà questa spec. Non serve un db per servirla.
  // Nota: questa route e /health non compaiono nella spec — le route sul
  // root vengono registrate (e quindi viste dall'hook onRoute) prima che
  // @fastify/swagger sia caricato. Va bene così: sono endpoint
  // infrastrutturali, non parte dell'API documentata.
  app.get("/api/openapi.json", async () => app.swagger());

  return app;
}
