import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { appendNotice } from "./notices.js";
import { docsTools } from "./tools/docs.js";
import { registerReadTools } from "./tools/read.js";
import { requestTools } from "./tools/requests.js";
import type { ToolContext, ToolDef } from "./tools/types.js";
import { registerWriteTools } from "./tools/write.js";

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
 * Registra una lista di tool con la stessa forma di `registerReadTools`: il
 * `ctx` arriva dalla closure, e in coda alla prima risposta della sessione va
 * l'eventuale avviso sul plugin (`appendNotice`, che non tocca `isError`).
 */
function registerToolDefs(server: McpServer, ctx: ToolContext, defs: ToolDef[]): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      // Cast al boundary dell'SDK: vedi la nota in registerReadTools.
      ((args: Record<string, unknown>) =>
        def.handler(args, ctx).then((result) => appendNotice(result, ctx.notice))) as Parameters<
        McpServer["registerTool"]
      >[2],
    );
  }
}

/**
 * Assembla il server MCP Stubwise: crea l'istanza `McpServer` (con nome,
 * versione e istruzioni di server esposti al client nell'handshake) e vi
 * registra tutti i tool: lettura, scrittura, documentazione e richieste
 * dell'utente. Non tocca il transport: il collegamento a stdio avviene
 * nell'entry `index.ts`, così `buildServer` resta testabile senza I/O.
 */
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "stubwise", version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerToolDefs(server, ctx, [...docsTools, ...requestTools]);
  return server;
}
