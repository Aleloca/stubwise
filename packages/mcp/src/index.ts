#!/usr/bin/env node
/**
 * Entry point eseguibile del server MCP Stubwise (`bin: stubwise-mcp`). Legge la
 * configurazione dall'ambiente + `.stubwise.json`, costruisce il client HTTP e il
 * server MCP con tutti i tool, poi si collega al transport stdio e resta in
 * ascolto di messaggi JSON-RPC dal client (Claude Code).
 *
 * INVARIANTE: STDOUT è il canale del protocollo MCP. Nessun log va su stdout —
 * ogni diagnostica passa da `console.error` (stderr). Un errore di bootstrap
 * (es. STUBWISE_TOKEN mancante) finisce su stderr con exit code != 0.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { StubwiseClient } from "./client.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig({ cwd: process.cwd(), env: process.env });
  const client = new StubwiseClient(config);
  const server = buildServer({ client, config });
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
  console.error(`stubwise-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
