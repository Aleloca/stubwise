import fastifyCookie from "@fastify/cookie";
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
import { aiJobRoutes, ticketUsageRoutes } from "./routes/ai-jobs.js";
import { authRoutes } from "./routes/auth.js";
import { commentRoutes } from "./routes/comments.js";
import { ingestRoutes } from "./routes/ingest.js";
import { projectRoutes } from "./routes/projects.js";
import type { RateLimitConfig } from "./routes/shared.js";
import { ticketRoutes } from "./routes/tickets.js";
import { userRoutes } from "./routes/users.js";
import { webhookRoutes } from "./routes/webhooks.js";

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
    return reply.code(500).send({ message: "Errore interno" });
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

  // Senza secret il plugin si registra comunque (parsing dei cookie), ma
  // firmare il cookie di sessione fallisce: stesso spirito del getter su db.
  void app.register(fastifyCookie, { secret: opts.sessionSecret });

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
  });
  void app.register(projectRoutes, { prefix: "/api/projects" });
  void app.register(ticketRoutes, { prefix: "/api/tickets" });
  // I commenti vivono sotto il singolo ticket: il prefisso porta il
  // parametro :ticketId, disponibile nelle route come request.params.
  void app.register(commentRoutes, { prefix: "/api/tickets/:ticketId/comments" });
  // Stesso schema dei commenti: la timeline dei job AI vive sotto il ticket.
  void app.register(aiJobRoutes, { prefix: "/api/tickets/:ticketId/jobs" });
  // Riepilogo consumi AI del ticket (token + costo per modello).
  void app.register(ticketUsageRoutes, { prefix: "/api/tickets/:ticketId/usage" });
  void app.register(userRoutes, { prefix: "/api/users" });
  // Superficie pubblica per gli SDK: fuori da /api, CORS aperto solo qui
  // (registrato dentro il plugin), autenticazione via X-Stubwise-Key.
  void app.register(ingestRoutes, {
    prefix: "/ingest",
    rateLimit: opts.ingestRateLimit ?? { max: 300, timeWindow: "1 minute" },
  });
  // Webhook git dei provider (chiusura ticket al merge): fuori da /api, niente
  // sessione, autenticazione via firma HMAC. Il parser raw-body è registrato
  // dentro lo scope del plugin, quindi non tocca il parsing JSON di /api né di
  // /ingest.
  void app.register(webhookRoutes, { prefix: "/webhooks" });

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
