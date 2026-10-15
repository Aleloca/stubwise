#!/usr/bin/env node
/**
 * Entry eseguibile del server MCP `stubwise_refine` (`node dist/refine-mcp/index.js`).
 * Non è un servizio del worker: lo lancia il `claude` CLI come processo stdio
 * figlio del turno di una sessione di refinement, con la config passata via env
 * (`REFINE_BRIDGE_URL`, `REFINE_BRIDGE_SECRET`: nient'altro, mai DB né
 * credenziali).
 *
 * INVARIANTE: STDOUT è il canale del protocollo MCP. Nessun log va su stdout —
 * ogni diagnostica passa da `console.error` (stderr). Un errore di bootstrap
 * (es. `REFINE_BRIDGE_URL` mancante) finisce su stderr con exit code != 0.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildRefineMcpServer, loadRefineMcpConfig } from "./server.js";

async function main(): Promise<void> {
  const config = loadRefineMcpConfig(process.env);
  const server = buildRefineMcpServer(config);
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
  console.error(`refine-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
