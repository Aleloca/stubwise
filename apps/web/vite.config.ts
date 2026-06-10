import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In dev il server Fastify gira a parte: il proxy evita problemi di CORS e
// fa viaggiare il cookie di sessione come same-origin. Il target è
// sovrascrivibile via env: la suite Playwright punta il vite dev al server
// effimero dello stack e2e (vedi e2e/start-stack.mjs).
const target = process.env.STUBWISE_API_TARGET ?? "http://localhost:3000";
const proxy = {
  "/api": target,
  "/ingest": target,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    // Solo i test unit/component di src: gli spec Playwright in e2e/ hanno
    // il loro runner (`pnpm e2e`) e non devono finire sotto vitest.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
