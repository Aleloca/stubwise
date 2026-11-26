import { createAgentSessionBus } from "./agent-session-bus.js";
import { createChatBus } from "./chat/bus.js";
import { buildApp } from "./app.js";
import { backfillManualPageEmbeddings } from "./services/doc-embed.js";
import { backfillAllProductSearchText, startProductEmbedPoller } from "./services/product-embed.js";
import { PRODUCT_LIVE_NOTIFY } from "./services/product-live-notify.js";
import { productPages } from "@stubwise/db";
import { eq } from "drizzle-orm";
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
const chatBus = await createChatBus((channel, cb) => client.listen(channel, cb));

const app = buildApp({
  logger: true,
  db,
  sessionSecret: config.sessionSecret,
  encryptionKey: config.encryptionKey,
  publicUrl: config.publicUrl,
  mailClassifyV2: config.mailClassifyV2,
  vaultDesktop: config.vaultDesktop,
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
  ...(config.smtpUrl !== undefined ? { smtpUrl: config.smtpUrl } : {}),
  ...(config.mailFrom !== undefined ? { mailFrom: config.mailFrom } : {}),
  sessionBus,
  chatBus,
});

// Area 11, F3: gli embedding delle pagine di prodotto ferme e cambiate, ogni
// `PRODUCT_EMBED_POLL_SECONDS` (vuota = spento). Qui e non in `buildApp`, o
// girerebbe in ogni test; PRIMA di `listen` (review di F3, C1: l'hook di
// chiusura dopo `listen` fa uscire il server all'avvio).
if (config.productEmbedPollSeconds !== undefined) startProductEmbedPoller(app, config.productEmbedPollSeconds);
// Area 11, F4: le revisioni scritte da un altro processo (il worker, F5) arrivano al canale dal vivo.
// Review di F4 (M11): `onlisten` scatta anche a ogni riconnessione della LISTEN, quando le
// NOTIFY del frattempo sono perse: a ogni stream aperto uno `state` nuovo (il client rilegge).
await client.listen(
  PRODUCT_LIVE_NOTIFY,
  (payload) => app.productLive.handleNotify(payload),
  () =>
    void app.productLive.resyncAll(async (pageId) => {
      const [row] = await app.db.select({ seq: productPages.revSeq }).from(productPages).where(eq(productPages.id, pageId));
      return row?.seq ?? null;
    }),
);

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Area 11, F3 (review I5): il testo cercabile delle pagine di prodotto che ne
// sono senza, all'avvio e qualunque sia l'env del poller. In sottofondo, fail-open.
void backfillAllProductSearchText(app.db)
  .then((n) => {
    if (n > 0) app.log.info({ pages: n }, "testo cercabile delle pagine di prodotto ricostruito");
  })
  .catch((error: unknown) => app.log.warn({ err: error }, "testo cercabile delle pagine di prodotto non ricostruito"));

// Gli embedding delle pagine manuali di prima della 0142, all'avvio (poi ogni
// ora dal timer di `buildApp`): in sottofondo, fail-open.
void backfillManualPageEmbeddings(app.db, app.embeddingClient, app.log)
  .then((n) => {
    if (n > 0) app.log.info({ pages: n }, "embedding delle pagine manuali recuperati");
  })
  .catch((error: unknown) => app.log.warn({ err: error }, "backfill degli embedding delle pagine manuali non riuscito"));
