import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { PRODUCTION_CSP } from "./src/main/security";

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve(__dirname, "src/main/index.ts") } },
  },
  preload: {
    // Un preload con sandbox:true deve essere CommonJS, anche se il package è ESM.
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [
      react(),
      tailwindcss(),
      {
        // CSP solo nel build: in dev HMR vuole script inline e websocket. Un
        // meta, perché il renderer impacchettato è `file://` (niente header).
        name: "stubwise:production-csp",
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
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
  },
});
