import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
}

/**
 * Crea l'istanza Fastify con plugin e route registrati.
 * Non legge process.env: la configurazione arriva dalle opzioni,
 * così i test possono usare `app.inject` senza variabili d'ambiente.
 */
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
