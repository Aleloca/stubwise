#!/usr/bin/env node
/**
 * Entry eseguibile del server MCP `stubwise_chat` (`node dist/chat-mcp/index.js`).
 * Non è un servizio del worker: lo lancia il `claude` CLI come processo stdio
 * figlio del turno di una conversazione libera, con la config via env
 * (`CHAT_BRIDGE_URL`, `CHAT_BRIDGE_SECRET`: nient'altro, mai DB, credenziali
 * né il token del turno, che resta nel ponte del worker).
 *
 * INVARIANTE: STDOUT è il canale del protocollo MCP. Nessun log va su stdout.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildChatMcpServer, loadChatMcpConfig } from "./server.js";

async function main(): Promise<void> {
  const server = buildChatMcpServer(loadChatMcpConfig(process.env));
  await server.connect(new StdioServerTransport());
  const shutdown = (): void => {
    void server.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error(`chat-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
