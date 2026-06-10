import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Db } from "./db/client.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  db?: Db;
}

/**
 * Crea l'istanza Fastify con plugin e route registrati.
 * Non legge process.env: la configurazione arriva dalle opzioni,
 * così i test possono usare `app.inject` senza variabili d'ambiente.
 */
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

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

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
