import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const { db } = createDb(config.databaseUrl);

try {
  await runMigrations(db);
} catch (err) {
  console.error("Migrazione del database fallita:", err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = buildApp({
  logger: true,
  db,
  sessionSecret: config.sessionSecret,
  encryptionKey: config.encryptionKey,
});

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
