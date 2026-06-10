import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Db } from "./db/client.js";
import { authRoutes } from "./routes/auth.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  db?: Db;
  /** Firma il cookie di sessione. Necessario perché login/sessioni funzionino. */
  sessionSecret?: string;
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

  // Senza secret il plugin si registra comunque (parsing dei cookie), ma
  // firmare il cookie di sessione fallisce: stesso spirito del getter su db.
  void app.register(fastifyCookie, { secret: opts.sessionSecret });

  void app.register(authRoutes, { prefix: "/api/auth" });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
