import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { backendAliases, backendDefine } from "./vite.backend";

// Serve il solo renderer in un browser normale (script `preview:web`):
// serve agli screenshot di verifica. Il renderer non richiede API Electron.
// Sempre sul finto: è il prototipo nel browser (la build app web è
// `vite.app-web.config.ts`).
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  resolve: { alias: backendAliases("prototype") },
  define: backendDefine("prototype"),
  plugins: [react(), tailwindcss()],
  server: { port: 5174, strictPort: true },
});
