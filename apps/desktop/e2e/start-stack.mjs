/*
 * Stack di backend per la suite E2E della NUOVA app (`apps/desktop/e2e`):
 * Postgres effimero (testcontainers, pgvector) + il server Fastify vero via
 * tsx, su :3220. Stessa scelta della suite del web vecchio
 * (`apps/web/e2e/start-stack.mjs`), con porte e cartella sue, così le due
 * suite girano una dopo l'altra nello stesso job senza toccarsi. Quando il
 * web vecchio sparisce, resta questa.
 *
 * Il database nasce vuoto a ogni run (le migrazioni le applica il server al
 * boot); i dati li prepara lo spec (API e, per la posta, il database).
 * Lo stato della run condiviso con gli spec sta in `<tmp>/stubwise-e2e-app`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../server");

console.log("[e2e app] avvio Postgres effimero…");
// Immagine pgvector (come i testcontainers unitari): le migrazioni del server
// fanno `CREATE EXTENSION vector` per gli embedding dei Docs, che un postgres
// "liscio" non ha. `--locale=C` per una collation deterministica, allineata.
const container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
  .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=C" })
  // Riconoscibile: un container rimasto orfano si toglie per etichetta, senza toccare quelli d'altri.
  .withLabels({ "stubwise.e2e": "app" })
  .start();
console.log("[e2e app] Postgres pronto, avvio il server su :3210");

// Stato della run condiviso con gli spec (che girano in un altro processo):
// l'URL del database, per le poche verifiche che il browser non può fare
// (invecchiare il secondo fattore di una sessione, vedi
// `second-factor.spec.ts`), e i segreti TOTP che gli spec registrano
// (`second-factor.ts`). Ripulito a ogni avvio: lo stack nasce vuoto, i
// segreti di una run precedente non valgono più. Il percorso è lo stesso di
// `STACK_DIR` in `second-factor.ts`.
const stackDir = path.join(os.tmpdir(), "stubwise-e2e-app");
rmSync(stackDir, { recursive: true, force: true });
mkdirSync(stackDir, { recursive: true });
writeFileSync(
  path.join(stackDir, "stack.json"),
  // L'id del container: `teardown.mjs` toglie QUESTO, e nessun altro.
  JSON.stringify({ databaseUrl: container.getConnectionUri(), containerId: container.getId() }),
);

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
    PORT: "3220",
    PUBLIC_URL: "http://localhost:5220",
    // Come in produzione dietro Caddy: l'IP del client si legge da
    // X-Forwarded-For. Gli spec ne danno uno diverso a ogni contesto
    // (`clientIpHeaders` in `second-factor.ts`), così il tetto di tentativi
    // per IP delle credenziali (10 al minuto, login e secondo fattore
    // insieme) non somma i login di spec diversi in una run sola.
    TRUST_PROXY: "true",
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
