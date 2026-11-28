import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { APP_ENTRY } from "@stubwise/shared/app-links";
import { backendAliases, backendDefine } from "./vite.backend";

// La pagina A SÉ della cassaforte (revisione di sicurezza della fase 2, I-2;
// design della cassaforte nel browser §10): un documento suo, `vault.html`,
// con dentro solo il worker della cassaforte e le sue pagine (attivare, la
// propria chiave, il kit, il recupero, l'associazione di un Mac, le passkey).
// Un build a sé (`dist-vault/`), così nessun pezzo dell'app ci finisce per un
// chunk condiviso; caddy lo serve su `/vault/` con la sua CSP stretta.
// Lo controlla `check-vault-target.mjs … vault`.
//
// Il percorso segue l'ingresso dell'app (`APP_ENTRY` di `@stubwise/shared`):
// con l'app alla radice (R1) è `/vault/`.

export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  base: `${APP_ENTRY}vault/`,
  resolve: { alias: backendAliases("app", "web") },
  define: backendDefine("app", "web"),
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  build: {
    outDir: resolve(import.meta.dirname, "dist-vault"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/vault.html") },
  },
});
