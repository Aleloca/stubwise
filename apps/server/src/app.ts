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

  if (opts.db) {
    app.decorate("db", opts.db);
  }

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
