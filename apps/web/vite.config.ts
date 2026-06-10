import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In dev il server Fastify gira a parte: il proxy evita problemi di CORS e
// fa viaggiare il cookie di sessione come same-origin.
const proxy = {
  "/api": "http://localhost:3000",
  "/ingest": "http://localhost:3000",
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
