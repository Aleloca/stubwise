#!/usr/bin/env node
/**
 * Entry eseguibile del server MCP `ask_user` (`node dist/ask-user-mcp/index.js`).
 * Non è un servizio del worker: lo lancia il `claude` CLI come processo stdio
 * figlio del run di pianificazione, con la config passata via env
 * (`ASK_USER_FILE`, `ASK_USER_ROUND`, `ASK_USER_MAX_ROUNDS`).
 *
 * INVARIANTE: STDOUT è il canale del protocollo MCP. Nessun log va su stdout —
 * ogni diagnostica passa da `console.error` (stderr). Un errore di bootstrap
 * (es. `ASK_USER_FILE` mancante) finisce su stderr con exit code != 0.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildAskUserServer, loadAskUserConfig } from "./server.js";

async function main(): Promise<void> {
  const config = loadAskUserConfig(process.env);
  const server = buildAskUserServer(config);
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
  console.error(`ask-user-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
