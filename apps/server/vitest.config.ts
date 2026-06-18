import { defineConfig } from "vitest/config";

/**
 * Config Vitest del server. La maggior parte dei file di test avvia un Postgres
 * effimero via testcontainers nel `beforeAll` (vedi startTestDb): con il pool a
 * fork di default Vitest lancia ~un worker per CPU, quindi su una macchina a più
 * core decine di container Postgres partono quasi insieme. Sotto `pnpm -r test`
 * (server + worker + db in parallelo) la contesa su Docker/CPU/RAM faceva
 * scadere gli hook (default 10s) e generava ECONNREFUSED verso i container.
 *
 * Mitigazione, senza ridurre la copertura:
 *  - `maxForks` limita quanti file (e quindi quanti container) girano in
 *    parallelo, tenendo la contesa sotto controllo anche durante `pnpm -r test`.
 *  - `hookTimeout`/`testTimeout` alzati danno aria all'avvio/stop dei container
 *    sotto carico (alcuni file passano già 120_000 inline al beforeAll).
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
