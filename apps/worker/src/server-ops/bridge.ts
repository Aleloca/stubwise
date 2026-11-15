import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_ANALYSIS_TOOLS, SERVER_FIX_TOOLS, SERVER_MCP_SERVER_NAME, type ServerOpsTool } from "@stubwise/shared";
import type { AgentMcpConfig } from "../agent/runner.js";
import { runAnalysisTool, type AnalysisGrant, type ToolDeps } from "./tools.js";

/**
 * PONTE degli strumenti di un server (area 8, F4b, S5): come quello del
 * refinement, un endpoint HTTP SOLO su loopback nel processo del worker. Il
 * server MCP `stubwise_server` (figlio del CLI) non vede DB, chiave di firma né
 * credenziali: riceve via env solo l'URL e un SEGRETO CASUALE PER RUN, legato a
 * UN'analisi di UN server, revocato a fine run.
 */

const MAX_BODY_BYTES = 64 * 1024;
const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface ServerOpsBridge {
  readonly url: string;
  grant(grant: AnalysisGrant): { secret: string; revoke(): void };
  close(): Promise<void>;
}

/** `dist/server-ops/bridge.js` → `dist/server-ops-mcp/index.js`. */
export function serverOpsServerPath(): string {
  return join(moduleDir, "..", "server-ops-mcp", "index.js");
}

/** La config MCP del run; `null` se l'entry compilata non c'è (fail-closed: nessun run). */
export function buildServerOpsMcpConfig(
  bridge: ServerOpsBridge,
  secret: string,
  serverPath: string,
  mode: "analysis" | "fix" = "analysis",
): { mcpConfig: AgentMcpConfig; tools: string[] } | null {
  if (!existsSync(serverPath)) return null;
  return {
    mcpConfig: {
      servers: {
        [SERVER_MCP_SERVER_NAME]: { command: process.execPath, args: [serverPath], env: { SERVER_OPS_BRIDGE_URL: bridge.url, SERVER_OPS_BRIDGE_SECRET: secret } },
      },
    },
    tools: (mode === "fix" ? SERVER_FIX_TOOLS : SERVER_ANALYSIS_TOOLS).map((t) => `mcp__${SERVER_MCP_SERVER_NAME}__${t}`),
  };
}

type Reply = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, message?: string): Reply => ({ status, body: { ok: false, error, ...(message ? { message } : {}) } });

function readBody(req: IncomingMessage): Promise<string | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(tooLarge ? "too_large" : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startServerOpsBridge(deps: ToolDeps & { log?: (m: string) => void }): Promise<ServerOpsBridge> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const grants = new Map<string, AnalysisGrant>();
  // Ogni grant vede SOLO gli strumenti della sua modalità.
  const toolsOf = (g: AnalysisGrant) => new Set<string>(g.mode === "fix" ? SERVER_FIX_TOOLS : SERVER_ANALYSIS_TOOLS);

  const grantOf = (header: string | undefined) => {
    const given = header?.startsWith("Bearer ") ? Buffer.from(header.slice(7)) : null;
    if (given === null) return undefined;
    let found: AnalysisGrant | undefined;
    for (const [secret, g] of grants) {
      const expected = Buffer.from(secret);
      if (expected.length === given.length && timingSafeEqual(expected, given)) found = g;
    }
    return found;
  };

  async function handle(req: IncomingMessage): Promise<Reply> {
    const tool = /^\/tools\/([a-z_]+)$/.exec(req.url ?? "")?.[1];
    if (req.method !== "POST" || tool === undefined) return fail(404, "not_found");
    const grant = grantOf(req.headers.authorization);
    if (grant === undefined) return fail(401, "unauthorized");
    if (!toolsOf(grant).has(tool)) return fail(404, "not_found");
    const raw = await readBody(req);
    if (raw === "too_large") return fail(413, "too_large");
    let args: unknown;
    try {
      args = raw.length === 0 ? {} : JSON.parse(raw);
    } catch {
      return fail(400, "invalid_input", "The body is not valid JSON.");
    }
    const reply = await runAnalysisTool(deps, grant, tool as ServerOpsTool, args);
    return { status: 200, body: { ok: reply.ok, message: reply.text } };
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req)
      .catch((error: unknown): Reply => {
        log(`[server-ops] ponte: strumento fallito: ${error instanceof Error ? error.message : String(error)}`);
        return fail(500, "internal", "Stubwise could not read it; try again.");
      })
      .then((reply) => {
        if (res.headersSent) return;
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (error) => log(`[server-ops] ponte: errore del server: ${String(error)}`));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server-ops bridge: indirizzo non disponibile");
  return {
    url: `http://127.0.0.1:${address.port}`,
    grant(g) {
      const secret = randomBytes(32).toString("hex");
      grants.set(secret, g);
      return { secret, revoke: () => void grants.delete(secret) };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
