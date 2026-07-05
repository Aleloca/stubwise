import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

// Bundle standalone del widget embeddabile: due formati.
//  - ES (stubwise-widget.js): entry del pacchetto per chi lo importa (SPA, bundler).
//  - IIFE (stubwise-widget.iife.js): tag <script> nei siti ospiti, globale "Stubwise".
export default defineConfig({
  plugins: [preact()],
  // Il widget gira sempre in produzione nei siti ospiti: fissa NODE_ENV così
  // Preact non trascina i warning/dev-checks nel bundle IIFE.
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    lib: {
      entry: "src/index.ts",
      name: "Stubwise",
      formats: ["es", "iife"],
      fileName: (format) =>
        format === "iife" ? "stubwise-widget.iife.js" : "stubwise-widget.js",
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
