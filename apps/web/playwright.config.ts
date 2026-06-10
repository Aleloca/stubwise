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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
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
