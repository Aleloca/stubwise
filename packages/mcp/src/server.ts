import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import type { ToolContext } from "./tools/types.js";

/**
 * Versione dichiarata al client MCP: LETTA dal package.json reale, non
 * duplicata a mano (prima era un literal "0.1.0" rimasto indietro rispetto al
 * package.json). `../package.json` è il percorso corretto sia da `src/server.ts`
 * sia da `dist/server.js`: il build è flat (`rootDir: src` → `outDir: dist`,
 * nessun file in sottocartelle di primo livello), quindi entrambi stanno a un
 * livello sotto la radice del package.
 *
 * `createRequire` invece di un `import ... with { type: "json" }`: quest'ultimo
 * richiederebbe `resolveJsonModule` e farebbe finire il JSON DENTRO `rootDir`,
 * cambiando il layout di `dist`. Il require resta risolto a runtime.
 */
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };

/** Versione dichiarata al client MCP (dal package.json del pacchetto). */
export const SERVER_VERSION: string = pkg.version ?? "0.0.0";

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
