import { createDb } from "@stubwise/db";
import { ClaudeCliRunner } from "./agent/claude-cli.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { MirrorManager } from "./git/mirrors.js";
import { createHandler } from "./handler.js";
import { runWorker } from "./queue.js";

/**
 * Entry point del worker: config → DB → mirror manager → CLI claude →
 * handler (triage → fix, serializzato per progetto) → loop runWorker.
 * Le migrazioni NON si lanciano qui: le applica il server all'avvio, il
 * worker assume che lo schema esista già (vedi packages/db/src/client.ts).
 */

function loadConfigOrExit(): WorkerConfig {
  try {
    return loadWorkerConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const { db, client } = createDb(config.databaseUrl);

const handler = createHandler({
  db,
  runner: new ClaudeCliRunner(),
  mirrors: new MirrorManager({ mirrorsDir: config.mirrorsDir }),
  encryptionKey: config.encryptionKey,
});

// Shutdown pulito: al primo segnale il loop smette di reclamare job e
// attende quelli in volo (runWorker si risolve solo a job conclusi).
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.error(`[stubwise-worker] ricevuto ${signal}: attendo i job in corso e mi fermo`);
    controller.abort();
  });
}

console.error(
  `[stubwise-worker] avviato (concurrency ${config.concurrency}, mirrors in ${config.mirrorsDir})`,
);
await runWorker({ db, handler, concurrency: config.concurrency, signal: controller.signal });
await client.end();
console.error("[stubwise-worker] fermato");
