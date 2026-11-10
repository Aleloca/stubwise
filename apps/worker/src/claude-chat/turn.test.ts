import { existsSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentSessionEvents,
  agentSessionInputs,
  agentSessions,
  claudeChatToolTokens,
  claudeConversations,
  hashChatToolToken,
  instanceSettings,
  users,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { CHAT_MCP_SERVER_NAME, CHAT_TOOL_NAMES } from "@stubwise/shared";
import type { AgentRunOptions, AgentRunResult, AgentRunner } from "../agent/runner.js";
import { fakeSelect } from "../providers/select-fake.js";
import { startChatBridge, type ChatBridge } from "./bridge.js";
import { CHAT_DENIED_BUILTIN_TOOLS, runChatTurn, type ChatTurnDeps } from "./turn.js";

// Un turno della conversazione libera (chat, fetta 1): solo i tool di lettura
// di `stubwise_chat`, cwd vuota, nessuna sorgente di settings; il token del
// turno vive SOLO per il turno e non esce dal ponte.

let t: TestDb;
let bridge: ChatBridge;
let ownerId: string;
let otherId: string;
let serverPath: string;
/** Le GET che il ponte farebbe al server: col token del turno. */
const serverCalls: { url: string; auth: string | null }[] = [];

beforeAll(async () => {
  t = await startTestDb();
  bridge = await startChatBridge({
    serverUrl: "http://server.test",
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      serverCalls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return Response.json([{ code: "AUD", name: "Audin" }]);
    }) as typeof fetch,
    log: () => undefined,
  });
  const [o] = await t.db.insert(users).values({ email: "ada@x.test", passwordHash: "x", role: "member", displayName: "Ada" }).returning();
  const [x] = await t.db.insert(users).values({ email: "bob@x.test", passwordHash: "x", role: "admin" }).returning();
  ownerId = o!.id;
  otherId = x!.id;
  // L'entry del server MCP deve esistere perché il turno lo configuri.
  const dir = await mkdtemp(join(tmpdir(), "chat-mcp-"));
  serverPath = join(dir, "index.js");
  await writeFile(serverPath, "");
}, 120_000);
afterAll(async () => {
  await bridge.close();
  await t.stop();
});

const OK: AgentRunResult = { exitCode: 0, output: "fatto", sessionId: "cli-1" };

function fakeRunner(script: Array<(o: AgentRunOptions) => Promise<AgentRunResult>>) {
  const calls: AgentRunOptions[] = [];
  const runner: AgentRunner = {
    recordsSessions: true,
    run: vi.fn(async (o: AgentRunOptions) => {
      calls.push(o);
      return (script[calls.length - 1] ?? script.at(-1)!)(o);
    }),
  };
  return { runner, calls };
}

async function echo(o: AgentRunOptions) {
  await t.db.insert(agentSessionEvents).values({
    sessionId: o.session!.sessionId,
    segmentId: "seg",
    type: "input",
    data: { inputId: o.openingInput!.inputId, text: o.openingInput!.text },
  });
}

async function seeded(opts: { cliSessionId?: string; archived?: boolean; author?: string } = {}) {
  const [s] = await t.db
    .insert(agentSessions)
    .values({ ownerKey: `free:${crypto.randomUUID()}`, kind: "free", title: "t" })
    .returning();
  await t.db.insert(claudeConversations).values({
    sessionId: s!.id,
    ownerId,
    title: "t",
    cliSessionId: opts.cliSessionId ?? null,
    archivedAt: opts.archived ? new Date() : null,
  });
  const [input] = await t.db
    .insert(agentSessionInputs)
    .values({ sessionId: s!.id, text: "Come va AUD?", authorUserId: opts.author ?? ownerId })
    .returning();
  return { sessionId: s!.id, inputId: input!.id };
}

function deps(runner: AgentRunner, over: Partial<ChatTurnDeps> = {}): ChatTurnDeps {
  return {
    db: t.db,
    runner,
    bridge,
    maxTurns: 10,
    turnTimeoutMs: 60_000,
    chatServerPath: serverPath,
    select: fakeSelect(t.db, "legacy"),
    log: () => undefined,
    ...over,
  };
}
const inputOf = async (id: string) =>
  (await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, id)))[0]!;
const tokensOf = (sessionId: string) =>
  t.db.select().from(claudeChatToolTokens).where(eq(claudeChatToolTokens.sessionId, sessionId));

describe("il turno della chat", () => {
  it("solo i tool di lettura, cwd vuota, nessuna sorgente di settings, UsageTag claude_chat, segmento chat", async () => {
    const s = await seeded();
    let cwdEmpty: boolean | undefined;
    const { runner, calls } = fakeRunner([
      async (o) => {
        cwdEmpty = (await readdir(o.cwd)).length === 0;
        await echo(o);
        return OK;
      },
    ]);
    const out = await runChatTurn(deps(runner), { ...s, signal: new AbortController().signal });
    expect(out).toBe("completed");
    const o = calls[0]!;
    expect(o.allowedTools).toEqual([...CHAT_TOOL_NAMES]);
    for (const tool of CHAT_DENIED_BUILTIN_TOOLS) expect(o.disallowedTools).toContain(tool);
    expect(o.settingSources).toBe("");
    expect(o.builtinTools).toBe("");
    expect(o.pluginDirs).toBeUndefined();
    expect(Object.keys(o.mcpConfig!.servers)).toEqual([CHAT_MCP_SERVER_NAME]);
    expect(o.usage).toEqual({ operation: "claude_chat", projectId: null });
    expect(o.session).toMatchObject({ sessionId: s.sessionId, label: "chat" });
    expect(o.resumeSessionId).toBeUndefined();
    expect(o.prompt).toContain("You do NOT do anything");
    expect(o.prompt).toContain("Ada");
    expect(cwdEmpty).toBe(true);
    expect(existsSync(o.cwd)).toBe(false);
    const [conv] = await t.db.select().from(claudeConversations).where(eq(claudeConversations.sessionId, s.sessionId));
    expect(conv!.cliSessionId).toBe("cli-1");
    expect((await inputOf(s.inputId)).status).toBe("delivered");
  });

  it("il token del turno: valido durante il run, dell'autore, mai nel prompt né nell'env MCP; revocato a fine turno", async () => {
    const s = await seeded();
    let during: (typeof claudeChatToolTokens.$inferSelect)[] = [];
    let mcpEnv = "";
    const { runner, calls } = fakeRunner([
      async (o) => {
        during = await tokensOf(s.sessionId);
        mcpEnv = JSON.stringify(o.mcpConfig);
        // Il server MCP chiama il ponte col segreto del turno: il ponte usa il token.
        const env = o.mcpConfig!.servers[CHAT_MCP_SERVER_NAME]!.env!;
        await fetch(`${env["CHAT_BRIDGE_URL"]}/tools/list_projects`, {
          method: "POST",
          headers: { authorization: `Bearer ${env["CHAT_BRIDGE_SECRET"]}` },
          body: "{}",
        });
        await echo(o);
        return OK;
      },
    ]);
    await runChatTurn(deps(runner), { ...s, signal: new AbortController().signal });
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ userId: ownerId, revokedAt: null });
    expect(during[0]!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000 + 60_000);
    const used = serverCalls.at(-1)!.auth!.replace("Bearer ", "");
    expect(hashChatToolToken(used)).toBe(during[0]!.tokenHash);
    expect(calls[0]!.prompt).not.toContain(used);
    expect(mcpEnv).not.toContain(used);
    expect(mcpEnv).not.toContain("stw_chat_");
    const after = await tokensOf(s.sessionId);
    expect(after[0]!.revokedAt).not.toBeNull();
    // Il ponte non accetta più il segreto del turno.
    const env = calls[0]!.mcpConfig!.servers[CHAT_MCP_SERVER_NAME]!.env!;
    const late = await fetch(`${env["CHAT_BRIDGE_URL"]}/tools/list_projects`, {
      method: "POST",
      headers: { authorization: `Bearer ${env["CHAT_BRIDGE_SECRET"]}` },
      body: "{}",
    });
    expect(late.status).toBe(401);
  });

  it("riprende con --resume quando la conversazione CLI c'è", async () => {
    const s = await seeded({ cliSessionId: "cli-old" });
    const { runner, calls } = fakeRunner([async (o) => (await echo(o), { ...OK, sessionId: "cli-old" })]);
    await runChatTurn(deps(runner), { ...s, signal: new AbortController().signal });
    expect(calls[0]!.resumeSessionId).toBe("cli-old");
    expect(calls[0]!.prompt).toBe("Come va AUD?");
  });

  it("ripreso con un contesto di pagina: il prompt lo ripete come tipo: id", async () => {
    const s = await seeded({ cliSessionId: "cli-old" });
    await t.db
      .update(claudeConversations)
      .set({ contextRef: { kind: "task", id: "AUD-12" } })
      .where(eq(claudeConversations.sessionId, s.sessionId));
    const { runner, calls } = fakeRunner([async (o) => (await echo(o), { ...OK, sessionId: "cli-old" })]);
    await runChatTurn(deps(runner), { ...s, signal: new AbortController().signal });
    expect(calls[0]!.prompt).toContain("task: AUD-12");
    expect(calls[0]!.prompt).toMatch(/--- MESSAGE ---\nCome va AUD\?$/);
  });

  it("conversazione archiviata, o messaggio di un altro: nessun run, session_not_live, nessun token", async () => {
    for (const s of [await seeded({ archived: true }), await seeded({ author: otherId })]) {
      const { runner } = fakeRunner([async () => OK]);
      expect(await runChatTurn(deps(runner), { ...s, signal: new AbortController().signal })).toBe("skipped");
      expect(runner.run).not.toHaveBeenCalled();
      expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
      expect(await tokensOf(s.sessionId)).toEqual([]);
    }
  });

  it("budget del mese finito: budget_exceeded, nessun run", async () => {
    const s = await seeded();
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({
      target: instanceSettings.id,
      set: { monthlyBudgetUsd: "1" },
    });
    try {
      const { runner } = fakeRunner([async () => OK]);
      const out = await runChatTurn(deps(runner, { monthlyCostUsdFn: async () => 5 }), {
        ...s,
        signal: new AbortController().signal,
      });
      expect(out).toBe("skipped");
      expect(runner.run).not.toHaveBeenCalled();
      expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "budget_exceeded" });
    } finally {
      await t.db.update(instanceSettings).set({ monthlyBudgetUsd: null });
    }
  });

  it("run fallito senza eco: turn_failed, e il token è revocato comunque", async () => {
    const s = await seeded();
    const { runner } = fakeRunner([async () => ({ exitCode: 1, output: "boom", sessionId: undefined })]);
    expect(await runChatTurn(deps(runner), { ...s, signal: new AbortController().signal })).toBe("failed");
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
    const tokens = await tokensOf(s.sessionId);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.revokedAt).not.toBeNull();
  });
});
