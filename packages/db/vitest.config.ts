import { defineConfig } from "vitest/config";

/**
 * Config Vitest del pacchetto db. I test dello schema avviano un Postgres
 * effimero via testcontainers. Durante `pnpm -r test` girano in parallelo a
 * server e worker: limitiamo i fork concorrenti e alziamo gli hookTimeout per
 * non saturare Docker/CPU/RAM (ECONNREFUSED, hook scaduti) sotto carico.
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
