import { resolve } from "node:path";
import process from "node:process";
import { defineConfig, devices } from "@playwright/test";

/*
 * E2E della NUOVA app (D3 del piano del taglio): la build web vera, servita su
 * `/app` con le intestazioni del Caddyfile (`serve-app.mjs`), contro lo stack
 * vero (`start-stack.mjs`: Postgres testcontainers + server su :3220).
 *
 * UN flusso seriale su un solo database, che nasce vuoto a ogni run: un
 * worker, niente parallelismo, niente retry (un retry ripartirebbe su uno
 * stato già consumato).
 */
const desktop = resolve(import.meta.dirname, "..");

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // Toglie il container Postgres di questa run (e solo quello).
  globalTeardown: "./teardown.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never", outputFolder: resolve(desktop, "playwright-report") }]],
  outputDir: resolve(desktop, "test-results"),
  use: {
    baseURL: "http://localhost:5220",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: "node e2e/start-stack.mjs",
      cwd: desktop,
      url: "http://localhost:3220/health",
      timeout: 180_000,
      // Sempre uno stack fresco: lo spec presuppone il database vuoto.
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // La build web vera, come la serve Caddy (non `vite dev`).
      // E la pagina a sé della cassaforte (`dist-vault`, su /app/vault/).
      command: "pnpm build:web && pnpm build:vault && node e2e/serve-app.mjs",
      cwd: desktop,
      url: "http://localhost:5220/health",
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
