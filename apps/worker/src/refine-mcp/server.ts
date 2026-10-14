import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Server MCP `stubwise_refine` (design 2026-10-14 §4.3): i tre tool con cui
 * l'agente di una sessione di refinement scrive design, piano e metadati
 * della voce. Non vede il DB né credenziali: inoltra al PONTE HTTP del worker
 * (loopback, segreto per turno) e restituisce all'agente la sua risposta. La
 * validazione vera sta nel ponte; gli schemi qui servono solo a dire al CLI
 * che forma hanno gli argomenti. Nomi ed enum tenuti allineati a mano con
 * `REFINE_MCP_SERVER_NAME`/`REFINE_TOOLS` e con gli schemi dei metadati di
 * `@stubwise/shared` (lo verifica il test d'allineamento in
 * `backlog/refine/bridge.test.ts`): questo entry resta autonomo come
 * `ask-user-mcp` (solo SDK, zod e node, niente pacchetti del workspace).
 *
 * Nessun `readOnlyHint`: il turno di refinement non è in plan mode (spec
 * §4.2), quindi l'annotazione non servirebbe a renderli chiamabili; li
 * abilita l'`allowedTools` del turno.
 *
 * INVARIANTE: stdout è il canale del protocollo MCP (JSON-RPC). Qui non si
 * scrive MAI su stdout: ogni diagnostica passa da `console.error` (stderr).
 */
export const REFINE_SERVER_NAME = "stubwise_refine";
const VERSION = "1.0.0";
const BRIDGE_TIMEOUT_MS = 30_000;

export interface RefineMcpConfig {
  bridgeUrl: string;
  secret: string;
}

export function loadRefineMcpConfig(env: NodeJS.ProcessEnv): RefineMcpConfig {
  const bridgeUrl = env["REFINE_BRIDGE_URL"];
  const secret = env["REFINE_BRIDGE_SECRET"];
  if (!bridgeUrl) throw new Error("REFINE_BRIDGE_URL mancante");
  if (!secret) throw new Error("REFINE_BRIDGE_SECRET mancante");
  return { bridgeUrl, secret };
}

const docShape = {
  markdown: z.string().min(1).describe("The full document, in Markdown. It replaces the current one."),
};
const itemShape = {
  title: z.string().optional(),
  effort: z.number().int().min(1).max(5).nullable().optional().describe("1-5, null to clear"),
  risk: z.enum(["low", "medium", "high"]).nullable().optional(),
  riskNote: z.string().nullable().optional(),
  urgency: z.enum(["low", "medium", "high", "urgent"]).nullable().optional(),
};

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function forward(
  config: RefineMcpConfig,
  fetchImpl: typeof fetch,
  tool: string,
  args: unknown,
): Promise<ToolResult> {
  try {
    const res = await fetchImpl(`${config.bridgeUrl}/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.secret}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    if (res.ok && body.ok === true) return { content: [{ type: "text", text: body.message ?? "Saved." }] };
    return {
      content: [{ type: "text", text: `Not saved (${body.error ?? res.status}): ${body.message ?? ""}`.trim() }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Not saved: the Stubwise bridge is unreachable (${error instanceof Error ? error.message : String(error)}).`,
        },
      ],
      isError: true,
    };
  }
}

export function buildRefineMcpServer(config: RefineMcpConfig, fetchImpl: typeof fetch = fetch): McpServer {
  const server = new McpServer({ name: REFINE_SERVER_NAME, version: VERSION });
  const register = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>) =>
    server.registerTool(
      name,
      { description, inputSchema },
      ((args: Record<string, unknown>) => forward(config, fetchImpl, name, args)) as Parameters<
        McpServer["registerTool"]
      >[2],
    );
  register(
    "set_design",
    "Save the design document of the backlog item (replaces the current one; the previous version is kept by Stubwise). Use it when the design is mature, and say so in the chat.",
    docShape,
  );
  register(
    "set_plan",
    "Save the implementation plan of the backlog item (replaces the current one; the previous version is kept by Stubwise).",
    docShape,
  );
  register(
    "update_item",
    "Update the item's title, effort (1-5), risk (+ riskNote) or urgency. Only the fields you pass change.",
    itemShape,
  );
  return server;
}
