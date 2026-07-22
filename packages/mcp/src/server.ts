import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import type { ToolContext } from "./tools/types.js";

/** Versione dichiarata al client MCP. Tenuta in sync con package.json. */
export const SERVER_VERSION = "0.1.0";

/**
 * Assembla il server MCP Stubwise: crea l'istanza `McpServer` (con nome e
 * versione esposti al client nell'handshake) e vi registra tutti i tool di
 * lettura e scrittura. Non tocca il transport: il collegamento a stdio avviene
 * nell'entry `index.ts`, così `buildServer` resta testabile senza I/O.
 */
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "stubwise", version: SERVER_VERSION });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  return server;
}
