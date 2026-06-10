import fastifyCookie from "@fastify/cookie";
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
import type { Db } from "./db/client.js";
import { authRoutes } from "./routes/auth.js";
import { commentRoutes } from "./routes/comments.js";
import { projectRoutes } from "./routes/projects.js";
import { ticketRoutes } from "./routes/tickets.js";

// Versione letta dal package.json (accanto a src/ e a dist/, quindi il
// percorso relativo vale sia in sviluppo che dopo la build).
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    /** Chiave AES-256 (32 byte) per cifrare le credenziali git dei progetti. */
    encryptionKey: Buffer;
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
}

/**
 * Crea l'istanza Fastify con plugin e route registrati.
 * Non legge process.env: la configurazione arriva dalle opzioni,
 * così i test possono usare `app.inject` senza variabili d'ambiente.
 */
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

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

  // Senza secret il plugin si registra comunque (parsing dei cookie), ma
  // firmare il cookie di sessione fallisce: stesso spirito del getter su db.
  void app.register(fastifyCookie, { secret: opts.sessionSecret });

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

  void app.register(authRoutes, { prefix: "/api/auth" });
  void app.register(projectRoutes, { prefix: "/api/projects" });
  void app.register(ticketRoutes, { prefix: "/api/tickets" });
  // I commenti vivono sotto il singolo ticket: il prefisso porta il
  // parametro :ticketId, disponibile nelle route come request.params.
  void app.register(commentRoutes, { prefix: "/api/tickets/:ticketId/comments" });

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
