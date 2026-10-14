import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { backlogItems, backlogRefineSessions, type Db } from "@stubwise/db";
import { setBacklogItemDesign, setBacklogItemPlan, updateBacklogItemMetadata } from "@stubwise/notifications";
import {
  AGENT_SESSION_EVENTS_CHANNEL,
  REFINE_DOC_MAX_CHARS,
  REFINE_MCP_SERVER_NAME,
  REFINE_TOOL_NAMES,
  refineSetDocInputSchema,
  refineUpdateItemInputSchema,
  type RefineToolName,
  type RefineUpdateItemInput,
} from "@stubwise/shared";
import type { ZodError } from "zod";
import type { AgentMcpConfig } from "../../agent/runner.js";

/**
 * PONTE dei tool di refinement (design 2026-10-14 §4.3): un endpoint HTTP SOLO
 * su loopback, nel processo del worker, a cui il server MCP `stubwise_refine`
 * (figlio del CLI) inoltra le chiamate. Il server MCP non vede né il DB né
 * credenziali: riceve via env solo l'URL e un SEGRETO CASUALE PER TURNO, che
 * vale per una sola sessione e una sola voce e che il worker revoca a fine
 * turno (`grant().revoke()`) o alla chiusura (`revokeSession`). Il segreto
 * finisce nel file temporaneo della config MCP del run, come ogni env di un
 * server MCP.
 *
 * Ogni scrittura: segreto valido → sessione `active` e voce aperta (nella
 * STESSA transazione della scrittura, con in lock la voce e poi la sessione) →
 * regole condivise con le rotte (`@stubwise/notifications`) con revisione →
 * `last_activity_at` → NOTIFY degli eventi della sessione (pagina della voce e
 * riquadro della sessione si rileggono). Risponde SUBITO all'agente, ok o
 * errore preciso, così si corregge nello stesso turno.
 */

/** Tetto del body: il documento più lungo ammesso, nel caso peggiore UTF-8, più l'involucro JSON. */
const MAX_BODY_BYTES = REFINE_DOC_MAX_CHARS * 4 + 16_384;
const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface RefineTurnGrant {
  secret: string;
  revoke(): void;
}
export interface RefineBridge {
  readonly url: string;
  grant(turn: { agentSessionId: string; itemId: string }): RefineTurnGrant;
  revokeSession(agentSessionId: string): void;
  close(): Promise<void>;
}

/** `dist/backlog/refine/bridge.js` → `dist/refine-mcp/index.js` (vedi `askUserServerPath`). */
export function refineServerPath(): string {
  return join(moduleDir, "..", "..", "refine-mcp", "index.js");
}

/**
 * Config MCP del turno. `null` se l'entry compilato non esiste (sviluppo con
 * `tsx`): meglio un turno senza tool, e il chiamante lo logga, che un server
 * MCP fantasma che il CLI non riesce ad avviare. L'env porta SOLO URL e
 * segreto del ponte.
 */
export function buildRefineMcpConfig(
  bridge: RefineBridge,
  grant: RefineTurnGrant,
  serverPath: string,
): { mcpConfig: AgentMcpConfig; tools: readonly string[] } | null {
  if (!existsSync(serverPath)) return null;
  return {
    mcpConfig: {
      servers: {
        [REFINE_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: [serverPath],
          env: { REFINE_BRIDGE_URL: bridge.url, REFINE_BRIDGE_SECRET: grant.secret },
        },
      },
    },
    tools: REFINE_TOOL_NAMES,
  };
}

type Reply = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, message?: string): Reply => ({
  status,
  body: { ok: false, error, ...(message !== undefined ? { message } : {}) },
});
const zodMessage = (e: ZodError) =>
  e.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");

const SESSION_CLOSED = (): Reply =>
  fail(409, "session_closed", "This refinement session is closed: nothing was saved.");
const ITEM_CLOSED = (): Reply =>
  fail(409, "item_closed", "The backlog item is converted or archived: nothing was saved.");

/**
 * Legge il body senza mai accumulare oltre il tetto: superato, scarta il resto
 * (lo drena, così la risposta 413 arriva su un socket ancora vivo).
 */
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

export async function startRefineBridge(deps: { db: Db; log?: (m: string) => void }): Promise<RefineBridge> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const grants = new Map<string, { agentSessionId: string; itemId: string }>();

  /** Confronto a tempo costante contro OGNI segreto vivo. */
  const turnOf = (header: string | undefined) => {
    const given = header?.startsWith("Bearer ") ? Buffer.from(header.slice(7)) : null;
    if (given === null) return undefined;
    let found: { agentSessionId: string; itemId: string } | undefined;
    for (const [secret, turn] of grants) {
      const expected = Buffer.from(secret);
      if (expected.length === given.length && timingSafeEqual(expected, given)) found = turn;
    }
    return found;
  };

  async function handle(req: IncomingMessage): Promise<Reply> {
    const match = /^\/tools\/(set_design|set_plan|update_item)$/.exec(req.url ?? "");
    if (req.method !== "POST" || match === null) return fail(404, "not_found");
    const turn = turnOf(req.headers.authorization);
    if (turn === undefined) return fail(401, "unauthorized");
    const raw = await readBody(req);
    if (raw === "too_large") {
      return fail(413, "too_large", `The document exceeds ${REFINE_DOC_MAX_CHARS} characters.`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return fail(400, "invalid_input", "The body is not valid JSON.");
    }
    const tool = match[1] as RefineToolName;
    const parsed =
      tool === "update_item" ? refineUpdateItemInputSchema.safeParse(json) : refineSetDocInputSchema.safeParse(json);
    if (!parsed.success) return fail(400, "invalid_input", zodMessage(parsed.error));

    return deps.db.transaction(async (tx) => {
      // ORDINE DEI LOCK: prima la VOCE, poi la SESSIONE — lo stesso dei percorsi
      // che chiudono la sessione (conversione, archiviazione, merge: lockano la
      // voce e poi aggiornano la sessione). L'ordine inverso qui può andare in
      // deadlock con loro. Una chiusura in corso ci fa ATTENDERE sul lock della
      // voce, e dopo il suo commit rileggiamo lo stato nuovo (→ 409).
      const [item] = await tx
        .select({ status: backlogItems.status })
        .from(backlogItems)
        .where(eq(backlogItems.id, turn.itemId))
        .for("update");
      // La voce sparita si è portata via la sessione (cascade).
      if (!item) return SESSION_CLOSED();
      if (item.status === "converted" || item.status === "archived") return ITEM_CLOSED();
      const [session] = await tx
        .select({ status: backlogRefineSessions.status })
        .from(backlogRefineSessions)
        .where(
          and(
            eq(backlogRefineSessions.agentSessionId, turn.agentSessionId),
            eq(backlogRefineSessions.itemId, turn.itemId),
          ),
        )
        .for("update");
      if (!session || session.status !== "active") return SESSION_CLOSED();

      const revision = { agentSessionId: turn.agentSessionId };
      let message: string;
      let result: "ok" | "not_found";
      if (tool === "update_item") {
        const patch = parsed.data as RefineUpdateItemInput;
        result = await updateBacklogItemMetadata(tx, turn.itemId, patch, { revision });
        const fields = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
        message = `Item updated: ${fields.join(", ")}.`;
      } else {
        const { markdown } = parsed.data as { markdown: string };
        if (tool === "set_design") {
          result = await setBacklogItemDesign(tx, turn.itemId, markdown, revision);
          message = "Design saved on the backlog item.";
        } else {
          result = await setBacklogItemPlan(tx, turn.itemId, markdown, revision);
          message = "Plan saved on the backlog item.";
        }
      }
      // La voce sparita nel frattempo si è portata via la sessione (cascade).
      if (result === "not_found") return SESSION_CLOSED();

      await tx
        .update(backlogRefineSessions)
        .set({ lastActivityAt: sql`now()` })
        .where(eq(backlogRefineSessions.agentSessionId, turn.agentSessionId));
      // Dentro la transazione: parte al commit, mai prima che la scrittura si veda.
      await tx.execute(
        sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId: turn.agentSessionId })})`,
      );
      return { status: 200, body: { ok: true, message } };
    });
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req)
      .catch((error: unknown): Reply => {
        log(`refine bridge: scrittura fallita: ${error instanceof Error ? error.message : String(error)}`);
        return fail(500, "internal", "Stubwise could not save it; try again.");
      })
      .then((reply) => {
        if (res.headersSent) return;
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
  });
  // Un `listen` fallito (loopback indisponibile) RIGETTA invece di restare appeso:
  // il chiamante decide (index.ts spegne il refinement, il worker parte).
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("refine bridge: indirizzo non disponibile");

  return {
    url: `http://127.0.0.1:${address.port}`,
    grant(turn) {
      const secret = randomBytes(32).toString("hex");
      grants.set(secret, turn);
      return { secret, revoke: () => void grants.delete(secret) };
    },
    revokeSession(agentSessionId) {
      for (const [secret, turn] of grants) if (turn.agentSessionId === agentSessionId) grants.delete(secret);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Le connessioni keep-alive dei client terrebbero aperto `close` all'infinito.
        server.closeAllConnections();
      }),
  };
}
