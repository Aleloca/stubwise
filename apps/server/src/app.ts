import fastifyCookie from "@fastify/cookie";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Db } from "./db/client.js";
import { authRoutes } from "./routes/auth.js";
import { commentRoutes } from "./routes/comments.js";
import { projectRoutes } from "./routes/projects.js";
import { ticketRoutes } from "./routes/tickets.js";

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

  void app.register(authRoutes, { prefix: "/api/auth" });
  void app.register(projectRoutes, { prefix: "/api/projects" });
  void app.register(ticketRoutes, { prefix: "/api/tickets" });
  // I commenti vivono sotto il singolo ticket: il prefisso porta il
  // parametro :ticketId, disponibile nelle route come request.params.
  void app.register(commentRoutes, { prefix: "/api/tickets/:ticketId/comments" });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
