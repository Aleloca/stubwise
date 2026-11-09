import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { backendAliases } from "./vite.backend";

// Fuso fisso per i test: le date del prototipo (giorno locale della rassegna,
// ore mostrate) non devono dipendere dalla macchina. I worker lo ereditano.
process.env.TZ = "UTC";

export default defineConfig({
  plugins: [react()],
  // I test girano sempre sul finto. Il modo NON è un `define` (sarebbe
  // sostituito alla compilazione): è una variabile d'ambiente, così un test
  // può provare la build app con `vi.stubEnv("VITE_STUBWISE_BUILD", "app")`.
  resolve: { alias: backendAliases("prototype") },
  test: {
    env: { VITE_STUBWISE_BUILD: "prototype" },
    environment: "happy-dom",
    setupFiles: ["./src/renderer/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 15_000,
    // Metà dei core, non tutti meno uno (il default): ogni file monta l'app
    // intera in happy-dom, e con un worker per core la macchina satura; i
    // test rallentano fino a sforare le attese di testing-library (vedi
    // `asyncUtilTimeout` nel setup). Con meno worker la corsa non si allunga.
    maxWorkers: "50%",
  },
});
