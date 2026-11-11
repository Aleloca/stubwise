import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Server MCP `stubwise_chat` (chat con Claude): i tool di LETTURA con cui
 * Claude, in una conversazione libera, legge Stubwise per conto di chi scrive
 * e, dalla fetta 3, `propose_action`, che scrive solo una PROPOSTA: la classe
 * la calcola il server, una B aspetta la conferma dell'autore, una A la esegue
 * il server a nome della persona. Nessun tool esegue niente da sé. Non vede il
 * DB né credenziali: inoltra al PONTE HTTP del worker (loopback, segreto per
 * turno), che chiama il server col token del turno. Nomi e `fn` tenuti
 * allineati a mano con `CHAT_MCP_SERVER_NAME`, `CHAT_TOOLS` e
 * `CLAUDE_PROPOSABLE_FNS` di `@stubwise/shared` (test d'allineamento in
 * `claude-chat/bridge.test.ts`): l'entry resta autonomo come `refine-mcp`
 * (solo SDK, zod e node, niente pacchetti del workspace).
 *
 * INVARIANTE: stdout è il canale del protocollo MCP (JSON-RPC). Qui non si
 * scrive MAI su stdout: ogni diagnostica passa da `console.error` (stderr).
 */
export const CHAT_SERVER_NAME = "stubwise_chat";
const VERSION = "1.0.0";
const BRIDGE_TIMEOUT_MS = 30_000;

/** Copia di `CLAUDE_PROPOSABLE_FNS` (test d'allineamento): gli argomenti li valida il server. */
export const PROPOSABLE_FNS = [
  "createTask",
  "updateTask",
  "planTask",
  "addComment",
  "deleteComment",
  "createRequest",
  "convertRequest",
  "archiveRequest",
  "reopenRequest",
  "startRun",
  "createMilestone",
  "deleteMilestone",
  "saveFilter",
  "deleteFilter",
  "pageAction",
] as const;

/** La chiave con cui il CLI (2.1.322) passa l'id del `tool_use` nel `_meta` di `tools/call`. */
const TOOL_USE_META = "claudecode/toolUseId";

export interface ChatMcpConfig {
  bridgeUrl: string;
  secret: string;
  /** Solo nei turni di @Claude nella Chat: il tool `ask_question` (area 4, fetta 3). */
  askQuestion?: boolean;
}

export function loadChatMcpConfig(env: NodeJS.ProcessEnv): ChatMcpConfig {
  const bridgeUrl = env["CHAT_BRIDGE_URL"];
  const secret = env["CHAT_BRIDGE_SECRET"];
  if (!bridgeUrl) throw new Error("CHAT_BRIDGE_URL mancante");
  if (!secret) throw new Error("CHAT_BRIDGE_SECRET mancante");
  return { bridgeUrl, secret, ...(env["CHAT_ASK_QUESTION"] === "1" ? { askQuestion: true } : {}) };
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
    "list_people",
    "List the people the user can see (id, name, initials, departments), to find an assignee by name. The row marked isClaude is Claude itself: assigning it starts Claude's work, only in claudeAssignableProjectIds.",
    {},
  );
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
  server.registerTool(
    "propose_action",
    {
      description:
        "Propose one or more Stubwise actions on behalf of the person (the catalog and the argument shapes are in the conversation contract). Stubwise decides: it either does it right away, or asks the person to confirm, or refuses. Never say something is done unless this tool's answer says it was executed.",
      inputSchema: {
        actions: z
          .array(z.object({ fn: z.enum(PROPOSABLE_FNS), args: z.record(z.string(), z.unknown()) }))
          .min(1)
          .max(20)
          .describe("The actions, in order; they succeed or fail together"),
        summary: z.string().max(2000).describe("One short sentence, in the person's language, saying what this does"),
      },
    },
    ((args: Record<string, unknown>, extra: { _meta?: Record<string, unknown> }) => {
      const toolUseId = extra._meta?.[TOOL_USE_META];
      return forward(config, fetchImpl, "propose_action", {
        ...args,
        ...(typeof toolUseId === "string" ? { toolUseId } : {}),
      });
    }) as Parameters<McpServer["registerTool"]>[2],
  );
  if (config.askQuestion) {
    register(
      "ask_question",
      "Ask the person who called you ONE multiple-choice question, when you cannot go on without a choice only they can make. Then end your turn: they answer and you continue. Only once per call.",
      {
        question: z.string().min(1).max(500).describe("The question, short, in the person's language"),
        options: z
          .array(z.object({ label: z.string().min(1).max(120), description: z.string().max(300).optional() }))
          .min(2)
          .max(5)
          .describe("2 to 5 choices"),
      },
    );
  }
  return server;
}
