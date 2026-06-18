import { defineConfig } from "vitest/config";

/**
 * Config Vitest del worker. Alcuni file di test avviano un Postgres effimero via
 * testcontainers nel `beforeAll`. Durante `pnpm -r test` il worker gira in
 * parallelo a server e db, ognuno con i propri container: per evitare di saturare
 * Docker/CPU/RAM (ECONNREFUSED, hook scaduti) limitiamo i fork concorrenti e
 * alziamo gli hookTimeout per dare aria all'avvio/stop dei container sotto carico.
 */
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 2,
        minForks: 1,
      },
    },
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
