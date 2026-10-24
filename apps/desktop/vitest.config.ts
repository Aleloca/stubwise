import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Fuso fisso per i test: le date del prototipo (giorno locale della rassegna,
// ore mostrate) non devono dipendere dalla macchina. I worker lo ereditano.
process.env.TZ = "UTC";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/renderer/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 15_000,
  },
});
