import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Server MCP `stubwise_chat` (chat con Claude, fetta 1): i tool di SOLA
 * LETTURA con cui Claude, in una conversazione libera, legge Stubwise per
 * conto di chi scrive. Non vede il DB né credenziali: inoltra al PONTE HTTP
 * del worker (loopback, segreto per turno), che chiama il server col token
 * del turno, cioè con la visibilità dell'autore. Nessun tool scrive, propone
 * o esegue niente. Nomi tenuti allineati a mano con `CHAT_MCP_SERVER_NAME` e
 * `CHAT_TOOLS` di `@stubwise/shared` (test d'allineamento in
 * `claude-chat/bridge.test.ts`): l'entry resta autonomo come `refine-mcp`
 * (solo SDK, zod e node, niente pacchetti del workspace).
 *
 * INVARIANTE: stdout è il canale del protocollo MCP (JSON-RPC). Qui non si
 * scrive MAI su stdout: ogni diagnostica passa da `console.error` (stderr).
 */
export const CHAT_SERVER_NAME = "stubwise_chat";
const VERSION = "1.0.0";
const BRIDGE_TIMEOUT_MS = 30_000;

export interface ChatMcpConfig {
  bridgeUrl: string;
  secret: string;
}

export function loadChatMcpConfig(env: NodeJS.ProcessEnv): ChatMcpConfig {
  const bridgeUrl = env["CHAT_BRIDGE_URL"];
  const secret = env["CHAT_BRIDGE_SECRET"];
  if (!bridgeUrl) throw new Error("CHAT_BRIDGE_URL mancante");
  if (!secret) throw new Error("CHAT_BRIDGE_SECRET mancante");
  return { bridgeUrl, secret };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function forward(config: ChatMcpConfig, fetchImpl: typeof fetch, tool: string, args: unknown): Promise<ToolResult> {
  try {
    const res = await fetchImpl(`${config.bridgeUrl}/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.secret}` },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string };
    if (res.ok && body.ok === true) return { content: [{ type: "text", text: body.text ?? "" }] };
    return { content: [{ type: "text", text: body.text ?? `Unavailable (${body.error ?? res.status}).` }], isError: true };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Unavailable: the Stubwise bridge is unreachable (${error instanceof Error ? error.message : String(error)}).`,
        },
      ],
      isError: true,
    };
  }
}

export function buildChatMcpServer(config: ChatMcpConfig, fetchImpl: typeof fetch = fetch): McpServer {
  const server = new McpServer({ name: CHAT_SERVER_NAME, version: VERSION });
  const register = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>) =>
    server.registerTool(
      name,
      { description, inputSchema },
      ((args: Record<string, unknown>) => forward(config, fetchImpl, name, args)) as Parameters<
        McpServer["registerTool"]
      >[2],
    );
  register("list_projects", "List the Stubwise projects the user can see: id, code, name, description.", {});
  register(
    "search_tasks",
    "Search the tasks the user can see. Optional free text, project id, and whether to include closed ones.",
    {
      text: z.string().optional().describe("Words to look for in the title or description"),
      projectId: z.string().optional().describe("A project id from list_projects"),
      includeClosed: z.boolean().optional(),
    },
  );
  register("read_task", "Read one task by its code (e.g. AUD-12): status, assignee, week, description.", {
    code: z.string().min(1),
  });
  register("read_request", "Read one request of a project's backlog by its code (e.g. AUD-R4).", {
    code: z.string().min(1),
  });
  register("search_docs", "Search the documentation of a project the user can see.", {
    projectId: z.string().min(1),
    query: z.string().min(1),
  });
  register(
    "read_project_overview",
    "Read a project's latest weekly brief (generated text) and its decision log (facts recorded by people).",
    { projectId: z.string().min(1) },
  );
  return server;
}
