import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAT_MCP_SERVER_NAME,
  CHAT_PROPOSE_TOOL,
  CHAT_TOOL_NAMES,
  CHAT_TOOLS,
  claudeProposalOutcomeSchema,
  type ChatReadToolName,
  type ChatToolName,
} from "@stubwise/shared";
import type { AgentMcpConfig } from "../agent/runner.js";

/**
 * PONTE dei tool della chat con Claude (fette 1–3). Endpoint HTTP
 * SOLO su loopback, nel processo del worker: il server MCP `stubwise_chat`
 * (figlio del CLI) gli inoltra le chiamate con un SEGRETO CASUALE PER TURNO.
 * Il ponte traduce ogni tool in una o più GET sul server, con il TOKEN DEL
 * TURNO (`stw_chat_…`, `issueChatToolToken`): il server lo accetta solo in GET
 * e solo sulle rotte di `CHAT_TOOL_READ_ROUTES`, e agisce come l'autore —
 * un progetto che l'autore non vede è 404 anche qui.
 *
 * Il token del turno resta DENTRO il ponte: non passa per l'env del server MCP
 * (che ha solo URL e segreto del ponte), non torna mai nelle risposte, non va
 * nei log.
 *
 * Fetta 3: `propose_action` è l'UNICA chiamata che non è una GET — un POST
 * sulla sola rotta di scrittura del token (`CHAT_TOOL_WRITE_ROUTES`), che crea
 * una PROPOSTA. Il ponte non esegue niente: al modello torna solo l'esito
 * (eseguita coi codici, in attesa di conferma, rifiutata col motivo), mai il
 * corpo del server.
 */

const MAX_BODY_BYTES = 16_384;
/** Tetto del testo restituito all'agente per una chiamata. */
export const CHAT_TOOL_TEXT_MAX = 12_000;
const SERVER_TIMEOUT_MS = 20_000;
const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface ChatTurnGrant {
  secret: string;
  revoke(): void;
}
export interface ChatBridge {
  readonly url: string;
  grant(turn: { sessionId: string; serverToken: string }): ChatTurnGrant;
  revokeSession(sessionId: string): void;
  close(): Promise<void>;
}

/** `dist/claude-chat/bridge.js` → `dist/chat-mcp/index.js`. */
export function chatServerPath(): string {
  return join(moduleDir, "..", "chat-mcp", "index.js");
}

/** Config MCP del turno; `null` se l'entry compilato non c'è (sviluppo con `tsx`). */
export function buildChatMcpConfig(
  bridge: ChatBridge,
  grant: ChatTurnGrant,
  serverPath: string,
): { mcpConfig: AgentMcpConfig; tools: readonly string[] } | null {
  if (!existsSync(serverPath)) return null;
  return {
    mcpConfig: {
      servers: {
        [CHAT_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: [serverPath],
          env: { CHAT_BRIDGE_URL: bridge.url, CHAT_BRIDGE_SECRET: grant.secret },
        },
      },
    },
    tools: CHAT_TOOL_NAMES,
  };
}

type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const seg = (v: string) => encodeURIComponent(v);

/** Un codice di task (`AUD-12`) o di richiesta (`AUD-R4`); un id di progetto è un uuid. */
const TASK_CODE = /^[A-Z][A-Z0-9]*-\d+$/;
const REQUEST_CODE = /^[A-Z][A-Z0-9]*-R\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un argomento non valido: la risposta per il modello, senza chiamare il server. */
export class ChatToolArgError extends Error {}

const codeArg = (args: Args, re: RegExp, example: string): string => {
  const code = (str(args["code"]) ?? "").toUpperCase();
  if (!re.test(code)) throw new ChatToolArgError(`Invalid code: use one like ${example}.`);
  return code;
};
const projectArg = (args: Args, required: boolean): string | undefined => {
  const id = str(args["projectId"]);
  if (id === undefined && !required) return undefined;
  if (id === undefined || !UUID.test(id)) {
    throw new ChatToolArgError("Invalid projectId: use the id of a project from list_projects.");
  }
  return id;
};

/**
 * I percorsi (sempre GET, sempre nell'allowlist del server) di un tool. Ogni
 * valore dell'agente si VALIDA prima (codici, uuid: `ChatToolArgError`) e
 * entra codificato: niente apre altri percorsi.
 */
export function chatServerPaths(tool: ChatReadToolName, args: Args): string[] {
  switch (tool) {
    case "list_projects":
      return ["/api/projects"];
    case "list_people":
      return ["/api/people"];
    case "search_tasks": {
      const q = new URLSearchParams();
      const text = str(args["text"]);
      const projectId = projectArg(args, false);
      if (text) q.set("text", text.slice(0, 500));
      if (projectId) q.set("projectIds", projectId);
      if (args["includeClosed"] !== true) q.set("families", "todo,active");
      const qs = q.toString();
      return [qs ? `/api/tasks?${qs}` : "/api/tasks"];
    }
    case "read_task":
      return [`/api/tasks/by-code/${seg(codeArg(args, TASK_CODE, "AUD-12"))}`];
    case "read_request":
      return [`/api/requests/by-code/${seg(codeArg(args, REQUEST_CODE, "AUD-R4"))}`];
    case "search_docs": {
      const q = new URLSearchParams({ q: (str(args["query"]) ?? "").slice(0, 300) });
      return [`/api/projects/${seg(projectArg(args, true)!)}/docs/search?${q.toString()}`];
    }
    case "read_project_overview": {
      const p = seg(projectArg(args, true)!);
      return [`/api/projects/${p}/briefs/latest`, `/api/projects/${p}/decisions?limit=50`];
    }
  }
}

/** Chiavi che non servono a rispondere e non devono finire nel contesto del modello. */
const HIDDEN_KEY = /(key|token|secret|password|hash|cookie)$/i;

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (HIDDEN_KEY.test(k) || v === null || v === undefined) continue;
      out[k] = compact(v);
    }
    return out;
  }
  return value;
}

/**
 * Ciò che di una risposta entra nel contesto del modello, per i tool che non
 * la passano intera. `list_people`: solo ciò che serve a trovare una persona
 * per nome; le EMAIL restano fuori (decisione dell'orchestratrice, 10 nov 2026).
 */
const PERSON_FIELDS = ["id", "name", "initials", "departmentIds", "deactivated", "isClaude", "claudeAssignableProjectIds"] as const;
export function projectToolResult(tool: ChatReadToolName, json: unknown): unknown {
  if (tool === "list_people") {
    if (!Array.isArray(json)) return [];
    return json.map((row: unknown) => {
      const out: Record<string, unknown> = {};
      if (row === null || typeof row !== "object") return out;
      for (const field of PERSON_FIELDS) if (field in row) out[field] = (row as Record<string, unknown>)[field];
      return out;
    });
  }
  return json;
}

/** L'id del `tool_use` (idempotenza della proposta); senza, uno nuovo. */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** L'esito di una proposta, in parole per il modello: niente del corpo del server oltre a stato, codici e motivo. */
export function proposalOutcomeText(json: unknown): { ok: boolean; text: string } {
  const parsed = claudeProposalOutcomeSchema.safeParse(json);
  if (!parsed.success) return { ok: false, text: "Stubwise gave an unexpected answer; nothing is known to be done. Tell the person to check the conversation." };
  const outcome = parsed.data;
  switch (outcome.status) {
    case "executed":
      return {
        ok: true,
        text: `EXECUTED by Stubwise on the person's behalf${outcome.codes.length > 0 ? `: ${outcome.codes.join(", ")}` : ""}. The person sees it in this conversation with an Undo button: undoing is their gesture, not yours.`,
      };
    case "awaiting_confirmation":
      return {
        ok: true,
        text: "NOT DONE YET: Stubwise shows the person a card to confirm it. Tell them you are asking them to confirm; do not say it is done.",
      };
    case "refused":
      return { ok: false, text: `REFUSED by Stubwise, nothing was changed: ${outcome.reason ?? "not allowed"}.` };
  }
}

function truncate(text: string): string {
  return text.length <= CHAT_TOOL_TEXT_MAX
    ? text
    : `${text.slice(0, CHAT_TOOL_TEXT_MAX)}\n…(truncated: ask a narrower question)`;
}

const subjectOf = (args: Args) => str(args["code"]) ?? str(args["projectId"]) ?? "the requested item";

type Reply = { status: number; body: { ok: boolean; text?: string; error?: string } };

export async function startChatBridge(deps: {
  serverUrl: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}): Promise<ChatBridge> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const serverUrl = deps.serverUrl.replace(/\/+$/, "");
  const grants = new Map<string, { sessionId: string; serverToken: string }>();

  const turnOf = (header: string | undefined) => {
    const given = header?.startsWith("Bearer ") ? Buffer.from(header.slice(7)) : null;
    if (given === null) return undefined;
    let found: { sessionId: string; serverToken: string } | undefined;
    for (const [secret, turn] of grants) {
      const expected = Buffer.from(secret);
      if (expected.length === given.length && timingSafeEqual(expected, given)) found = turn;
    }
    return found;
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string | "too_large">((resolve, reject) => {
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

  async function propose(turn: { sessionId: string; serverToken: string }, args: Args): Promise<Reply> {
    const given = args["toolUseId"];
    const body = {
      toolUseId: typeof given === "string" && TOOL_USE_ID.test(given) ? given : `chat_${randomUUID()}`,
      summary: typeof args["summary"] === "string" ? args["summary"].slice(0, 2000) : "",
      actions: args["actions"],
    };
    let res: Response;
    try {
      res = await fetchImpl(`${serverUrl}/api/claude/conversations/${seg(turn.sessionId)}/proposals`, {
        method: "POST",
        headers: { authorization: `Bearer ${turn.serverToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
      });
    } catch (error) {
      // Può essere arrivata: non si dice «riprova», si rimanda alla conversazione.
      log(`[chat] ponte: proposta non consegnata: ${error instanceof Error ? error.message : String(error)}`);
      return {
        status: 200,
        body: { ok: false, text: "Stubwise could not be reached; it is not known whether the proposal arrived. Do not repeat it: ask the person to look at the conversation." },
      };
    }
    if (res.status === 400) {
      return {
        status: 200,
        body: { ok: false, text: "REFUSED by Stubwise, nothing was changed: the actions are not valid (check fn names, ids and argument shapes)." },
      };
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return { status: 200, body: { ok: false, text: "This turn can no longer propose actions (it ended or the conversation was closed). Nothing was changed." } };
    }
    if (!res.ok) {
      log(`[chat] ponte: propose_action → ${res.status}`);
      return { status: 200, body: { ok: false, text: `Stubwise is unavailable right now (${res.status}); nothing is known to be done.` } };
    }
    return { status: 200, body: proposalOutcomeText(await res.json().catch(() => null)) };
  }

  async function handle(req: IncomingMessage): Promise<Reply> {
    const match = /^\/tools\/([a-z_]+)$/.exec(req.url ?? "");
    const tool = match?.[1] as ChatToolName | undefined;
    if (req.method !== "POST" || tool === undefined || !(CHAT_TOOLS as readonly string[]).includes(tool)) {
      return { status: 404, body: { ok: false, error: "not_found" } };
    }
    const turn = turnOf(req.headers.authorization);
    if (turn === undefined) return { status: 401, body: { ok: false, error: "unauthorized" } };
    const raw = await readBody(req);
    if (raw === "too_large") return { status: 413, body: { ok: false, text: "The request is too large." } };
    let args: Args = {};
    try {
      const parsed: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Args;
    } catch {
      return { status: 400, body: { ok: false, text: "The arguments are not valid JSON." } };
    }

    if (tool === CHAT_PROPOSE_TOOL) return propose(turn, args);

    let paths: string[];
    try {
      paths = chatServerPaths(tool, args);
    } catch (error) {
      if (error instanceof ChatToolArgError) return { status: 200, body: { ok: false, text: error.message } };
      throw error;
    }
    const parts: string[] = [];
    for (const path of paths) {
      const res = await fetchImpl(`${serverUrl}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${turn.serverToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
      });
      // 404 e 403 si leggono uguali: non si dice se l'oggetto esiste.
      if (res.status === 404 || res.status === 403) {
        return { status: 200, body: { ok: false, text: `Not found, or not visible to you: ${subjectOf(args)}.` } };
      }
      if (res.status === 401) {
        return { status: 200, body: { ok: false, text: "This turn can no longer read Stubwise (it ended or the conversation was closed)." } };
      }
      if (res.status === 400) {
        return { status: 200, body: { ok: false, text: "Stubwise rejected these arguments; check ids and codes." } };
      }
      if (!res.ok) {
        log(`[chat] ponte: ${tool} → ${res.status}`);
        return { status: 200, body: { ok: false, text: `Stubwise is unavailable right now (${res.status}).` } };
      }
      const json: unknown = await res.json().catch(() => null);
      parts.push(JSON.stringify(compact(projectToolResult(tool, json))));
    }
    return { status: 200, body: { ok: true, text: truncate(parts.join("\n")) } };
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req)
      .catch((error: unknown): Reply => {
        // Il messaggio di un fetch fallito non contiene il token (sta in un header).
        log(`[chat] ponte: lettura fallita: ${error instanceof Error ? error.message : String(error)}`);
        return { status: 200, body: { ok: false, text: "Stubwise could not be read; try again." } };
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
  server.on("error", (error) => log(`[chat] ponte: errore del server: ${String(error)}`));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("chat bridge: indirizzo non disponibile");

  return {
    url: `http://127.0.0.1:${address.port}`,
    grant(turn) {
      const secret = randomBytes(32).toString("hex");
      grants.set(secret, turn);
      return { secret, revoke: () => void grants.delete(secret) };
    },
    revokeSession(sessionId) {
      for (const [secret, turn] of grants) if (turn.sessionId === sessionId) grants.delete(secret);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
