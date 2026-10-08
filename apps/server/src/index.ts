import { createAgentSessionBus } from "./agent-session-bus.js";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { createDb, runMigrations } from "@stubwise/db";

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const { db, client } = createDb(config.databaseUrl);

try {
  await runMigrations(db);
} catch (err) {
  console.error("Migrazione del database fallita:", err instanceof Error ? err.message : err);
  process.exit(1);
}

// Una LISTEN per canale per processo, condivisa da tutti gli stream SSE.
const sessionBus = await createAgentSessionBus((channel, cb) => client.listen(channel, cb));

const app = buildApp({
  logger: true,
  db,
  sessionSecret: config.sessionSecret,
  encryptionKey: config.encryptionKey,
  publicUrl: config.publicUrl,
  trustProxy: config.trustProxy,
  embeddingBaseUrl: config.embeddingBaseUrl,
  embeddingModel: config.embeddingModel,
  ...(config.embeddingApiKey !== undefined ? { embeddingApiKey: config.embeddingApiKey } : {}),
  widgetDailyMessageCap: config.widgetDailyMessageCap,
  widgetDailyTicketCap: config.widgetDailyTicketCap,
  graphsDir: config.graphsDir,
  // Retrieval dal grafo nelle chat interne: senza GRAPHIFY_MCP_URL (o con la
  // variabile vuota) la chiave non viene passata e la feature resta spenta.
  ...(config.graphifyMcpUrl !== undefined ? { graphifyMcpUrl: config.graphifyMcpUrl } : {}),
  graphChatTokenBudget: config.graphChatTokenBudget,
  graphChatSnippetMaxChars: config.graphChatSnippetMaxChars,
  graphChatSnippetNodes: config.graphChatSnippetNodes,
  mirrorsDir: config.mirrorsDir,
  sessionBus,
});

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
