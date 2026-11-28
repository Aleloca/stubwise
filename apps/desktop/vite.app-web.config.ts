import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { PRODUCTION_CSP } from "./src/main/security";
import { backendAliases, backendDefine } from "./vite.backend";

// La build «app» nel browser (integrazione area 2, fetta 1): lo stesso
// renderer del desktop, sul server vero, servito da caddy alla radice (R1) con la
// sessione a cookie del web (stessa origine). Sempre in modo `app`: il
// prototipo nel browser è `vite.web.config.ts`. Lo controlla
// `scripts/check-no-seed.mjs`: nessun dato del seed nel bundle.
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  base: "/",
  // Il target `web` (design della cassaforte nel browser §4): `@backend/vault` sulla scheda.
  resolve: { alias: backendAliases("app", "web") },
  define: backendDefine("app", "web"),
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
          // Revisione I-4 (§2.3): Trusted Types, e il worker della cassaforte dal bundle.
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: `${PRODUCTION_CSP}; require-trusted-types-for 'script'; trusted-types stubwise-vault-worker stubwise-html; worker-src 'self'`,
          },
          injectTo: "head-prepend",
        },
      ],
    },
  ],
  // Il worker della cassaforte nel browser (revisione I-1) come modulo ES, con
  // le sue dipendenze nel suo file.
  worker: { format: "es" },
  build: {
    outDir: resolve(import.meta.dirname, "dist-web"),
    emptyOutDir: true,
  },
});
