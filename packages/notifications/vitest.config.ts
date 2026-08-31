import { defineConfig } from "vitest/config";

/**
 * Config Vitest del pacchetto notifications. `publish.test.ts` avvia un Postgres
 * effimero via testcontainers (la pubblicazione scrive su più tabelle con CHECK
 * di coerenza: un fake `Db` non basterebbe). Durante `pnpm -r test` gira in
 * parallelo a server, worker e db: come loro limitiamo i fork concorrenti e
 * alziamo i timeout degli hook, per non saturare Docker/CPU/RAM.
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
