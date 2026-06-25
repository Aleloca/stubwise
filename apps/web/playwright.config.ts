import process from "node:process";
import { defineConfig, devices } from "@playwright/test";

/*
 * Suite e2e contro lo stack reale (vedi e2e/start-stack.mjs per la scelta
 * dell'infrastruttura): Postgres testcontainer + server Fastify su :3210,
 * vite dev su :5210 con il proxy puntato al server di test.
 *
 * La suite è UN flusso serializzato su un solo database (lo spec parte dal
 * primo setup dell'istanza): un worker, niente parallelismo, niente retry —
 * un retry ripartirebbe su uno stato già consumato.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // L'avvio del container Postgres può costare decine di secondi a freddo.
  timeout: 60_000,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5210",
    trace: "retain-on-failure",
  },
  // Viewport ampio (full HD): la board kanban ha 6 colonne (min 15rem ciascuna)
  // e sotto una certa larghezza va in scroll orizzontale. Con un viewport stretto
  // l'auto-scroll di dnd-kit durante il drag sposterebbe le colonne sotto il
  // puntatore, facendo cadere il rilascio sulla colonna sbagliata: a 1920px tutte
  // le colonne stanno in pagina e il drag-and-drop col mouse è deterministico.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } },
    },
  ],
  webServer: [
    {
      command: "node e2e/start-stack.mjs",
      url: "http://localhost:3210/health",
      timeout: 180_000,
      // Sempre uno stack fresco: lo spec presuppone il database vuoto.
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm exec vite dev --port 5210 --strictPort",
      url: "http://localhost:5210",
      timeout: 60_000,
      reuseExistingServer: false,
      env: { STUBWISE_API_TARGET: "http://localhost:3210" },
    },
  ],
});
