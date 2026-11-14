#!/usr/bin/env node
/**
 * Entry eseguibile del server MCP `stubwise_server` (`node dist/server-ops-mcp/index.js`).
 * Non è un servizio del worker: lo lancia il `claude` CLI come processo stdio
 * figlio del turno di un'analisi di un server, con la config passata via env
 * (`SERVER_OPS_BRIDGE_URL`, `SERVER_OPS_BRIDGE_SECRET`: nient'altro, mai DB né
 * credenziali).
 *
 * INVARIANTE: STDOUT è il canale del protocollo MCP. Nessun log va su stdout —
 * ogni diagnostica passa da `console.error` (stderr). Un errore di bootstrap
 * (es. `SERVER_OPS_BRIDGE_URL` mancante) finisce su stderr con exit code != 0.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServerOpsMcpServer, loadServerOpsMcpConfig } from "./server.js";

async function main(): Promise<void> {
  const config = loadServerOpsMcpConfig(process.env);
  const server = buildServerOpsMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Chiusura ordinata: alla ricezione di un segnale chiudi il server (che chiude
  // il transport stdio) ed esci pulito. `once` evita doppie esecuzioni.
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
  console.error(`server-ops-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
