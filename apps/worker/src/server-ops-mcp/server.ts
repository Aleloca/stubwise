import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Server MCP `stubwise_server` (area 8, F4b, S5): gli strumenti di SOLA LETTURA
 * dell'analisi di un server, più il resoconto finale. Non vede DB né chiavi:
 * inoltra al PONTE del worker (loopback, segreto per run), dove stanno le
 * regole vere. Nomi tenuti allineati con `SERVER_ANALYSIS_TOOLS` di
 * `@stubwise/shared` (test d'allineamento); autonomo come `refine-mcp`.
 *
 * INVARIANTE: stdout è il canale del protocollo MCP; la diagnostica va su stderr.
 */
export const SERVER_OPS_SERVER_NAME = "stubwise_server";
const BRIDGE_TIMEOUT_MS = 11 * 60_000;

export interface ServerOpsMcpConfig {
  bridgeUrl: string;
  secret: string;
}

export function loadServerOpsMcpConfig(env: NodeJS.ProcessEnv): ServerOpsMcpConfig {
  const bridgeUrl = env["SERVER_OPS_BRIDGE_URL"];
  const secret = env["SERVER_OPS_BRIDGE_SECRET"];
  if (!bridgeUrl) throw new Error("SERVER_OPS_BRIDGE_URL mancante");
  if (!secret) throw new Error("SERVER_OPS_BRIDGE_SECRET mancante");
  return { bridgeUrl, secret };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function forward(config: ServerOpsMcpConfig, fetchImpl: typeof fetch, tool: string, args: unknown): Promise<ToolResult> {
  try {
    const res = await fetchImpl(`${config.bridgeUrl}/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.secret}` },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    const text = body.message ?? body.error ?? `HTTP ${res.status}`;
    return res.ok && body.ok === true ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], isError: true };
  } catch (error) {
    return { content: [{ type: "text", text: `The Stubwise bridge is unreachable (${error instanceof Error ? error.message : String(error)}).` }], isError: true };
  }
}

const container = z.string().describe("Container name, as listed by server_overview");

export const SERVER_OPS_TOOL_DEFS: { name: string; description: string; inputSchema: Record<string, z.ZodTypeAny> }[] = [
  { name: "server_overview", description: "The server's last sample (CPU, memory, disks, services), its checks and recent episodes. Read-only.", inputSchema: {} },
  { name: "server_metrics", description: "CPU, load, memory and disk over the last hours (1-48). Read-only.", inputSchema: { hours: z.number().int().min(1).max(48).optional() } },
  { name: "server_environments", description: "Which projects use this server, and which containers belong to each of their environments. Use it to say which project causes the problem. Read-only.", inputSchema: {} },
  {
    name: "container_logs",
    description: "The last log lines of one container, read by the monitoring agent (a signed read, logged). Read-only.",
    inputSchema: { container, lines: z.number().int().min(1).max(500), sinceMinutes: z.number().int().min(1).max(1440) },
  },
  { name: "container_state", description: "State, restart count and image of one container, read by the agent. Read-only.", inputSchema: { container } },
  { name: "ssh_read", description: "A fixed read-only command over SSH, if an SSH read access is connected. Read-only.", inputSchema: { read: z.string(), params: z.record(z.string(), z.unknown()).optional() } },
  {
    name: "propose_server_plan",
    description:
      "Propose the correction plan for this task: steps of the allowed actions only (container.restart, container.stop, container.start, docker.prune), on containers of this project. A person approves it before anything runs. Call it ONCE.",
    inputSchema: { steps: z.array(z.object({ action: z.string(), params: z.record(z.string(), z.unknown()), why: z.string() })) },
  },
  {
    name: "report_server_diagnosis",
    description:
      "Finish the analysis: the diagnosis, the project that causes it (its code, or null if you cannot tell) with the containers that prove it, and optionally a fix as steps of the allowed actions only. Call it ONCE, at the end.",
    inputSchema: {
      summary: z.string(),
      cause: z.object({ projectCode: z.string().nullable(), containers: z.array(z.string()), why: z.string() }),
      fix: z.object({ steps: z.array(z.object({ action: z.string(), params: z.record(z.string(), z.unknown()), why: z.string() })) }).optional(),
    },
  },
];

export function buildServerOpsMcpServer(config: ServerOpsMcpConfig, fetchImpl: typeof fetch = fetch): McpServer {
  const server = new McpServer({ name: SERVER_OPS_SERVER_NAME, version: "1.0.0" });
  for (const def of SERVER_OPS_TOOL_DEFS) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema }, ((args: Record<string, unknown>) =>
      forward(config, fetchImpl, def.name, args)) as Parameters<McpServer["registerTool"]>[2]);
  }
  return server;
}
