import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { PRODUCTION_CSP } from "./src/main/security";
import { backendAliases, backendDefine } from "./vite.backend";

// La build «app» nel browser (integrazione area 2, fetta 1): lo stesso
// renderer del desktop, sul server vero, servito da caddy su `/app/` con la
// sessione a cookie del web (stessa origine). Sempre in modo `app`: il
// prototipo nel browser è `vite.web.config.ts`. Lo controlla
// `scripts/check-no-seed.mjs`: nessun dato del seed nel bundle.
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  base: "/app/",
  resolve: { alias: backendAliases("app") },
  define: backendDefine("app"),
  plugins: [
    react(),
    tailwindcss(),
    {
      // La stessa CSP del renderer impacchettato: il renderer non fa rete
      // fuori dalla sua origine (le API sono `/api/…` sulla stessa).
      name: "stubwise:app-web-csp",
      apply: "build",
      transformIndexHtml: () => [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: PRODUCTION_CSP },
          injectTo: "head-prepend",
        },
      ],
    },
  ],
  build: {
    outDir: resolve(import.meta.dirname, "dist-web"),
    emptyOutDir: true,
  },
});
