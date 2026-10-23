import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Serve il solo renderer in un browser normale (script `preview:web`):
// serve agli screenshot di verifica. Il renderer non richiede API Electron.
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  plugins: [react()],
  server: { port: 5174, strictPort: true },
});
