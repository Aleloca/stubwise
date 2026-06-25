/*
 * Stack di backend per la suite Playwright: Postgres effimero (testcontainers)
 * + server Fastify reale via tsx, su una porta dedicata (3210).
 *
 * Scelta dell'infrastruttura: il server non serve gli statici (in produzione
 * lo fa il reverse proxy), quindi Playwright avvia DUE webServer — questo
 * script per le API e un `vite dev` su 5210 con il proxy puntato a 3210
 * (vedi playwright.config.ts). È la stessa topologia dello sviluppo locale,
 * senza build aggiuntive e CI-friendly: serve solo Docker per il container.
 *
 * Il database nasce vuoto a ogni run (le migrazioni le applica il server al
 * boot): lo spec parte sempre dal primo setup dell'istanza. Alla chiusura
 * Playwright uccide il process group; il container orfano viene raccolto dal
 * reaper di testcontainers (ryuk).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../server");

console.log("[e2e] avvio Postgres effimero…");
// Immagine pgvector (come i testcontainers unitari): le migrazioni del server
// fanno `CREATE EXTENSION vector` per gli embedding dei Docs, che un postgres
// "liscio" non ha. `--locale=C` per una collation deterministica, allineata.
const container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
  .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
  .start();
console.log("[e2e] Postgres pronto, avvio il server su :3210");

// Binario tsx del workspace server: niente build, gira i sorgenti TS.
const tsxBin = path.join(serverDir, "node_modules", ".bin", "tsx");
const server = spawn(tsxBin, ["src/index.ts"], {
  cwd: serverDir,
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: container.getConnectionUri(),
    // Segreti fissi e finti: servono solo a far partire l'istanza di test.
    SESSION_SECRET: "stubwise-e2e-session-secret-0123456789abcdef",
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    PORT: "3210",
    PUBLIC_URL: "http://localhost:5210",
  },
});

async function stop(code) {
  try {
    await container.stop();
  } finally {
    process.exit(code);
  }
}

server.on("exit", (code) => void stop(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
