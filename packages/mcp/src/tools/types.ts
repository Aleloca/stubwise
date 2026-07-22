import type { z } from "zod";

import type { StubwiseClient } from "../client.js";
import type { StubwiseConfig } from "../config.js";

/**
 * Dipendenze iniettate in ogni handler di tool: il client HTTP verso Stubwise e
 * la configurazione risolta (baseUrl, token, projectSlug di default). Passarle
 * come contesto — invece di catturarle in una closure — rende gli handler
 * chiamabili direttamente nei test con un client mockato, senza mai passare per
 * il protocollo MCP.
 */
export interface ToolContext {
  client: StubwiseClient;
  config: StubwiseConfig;
}

/**
 * Risultato di un tool nella forma attesa dall'SDK MCP: una lista di blocchi di
 * contenuto (qui sempre testo) più un flag `isError`. Gli handler NON lanciano:
 * un errore parlante viene restituito come `ToolResult` con `isError: true`, così
 * Claude riceve un messaggio leggibile invece di un crash del tool.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Definizione testabile di un tool MCP, disaccoppiata dall'SDK: `handler` è una
 * funzione pura `(args, ctx) => Promise<ToolResult>` invocabile nei test. La
 * registrazione sull'SDK (`server.registerTool(name, {description, inputSchema},
 * (args) => handler(args, ctx))`) avviene altrove (vedi `registerReadTools`).
 *
 * `inputSchema` è una `ZodRawShape` (oggetto di campi zod), la forma richiesta
 * da `registerTool` dell'SDK: l'SDK la usa sia per la validazione degli argomenti
 * sia per esporre lo schema JSON del tool al client.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}
