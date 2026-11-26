import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentRuns,
  agentSessionEvents,
  agentSessionInputs,
  agentSessions,
  chatChannels,
  chatClaudeQuestions,
  chatMessages,
  claudeConversations,
  instanceSettings,
  users,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { CHAT_MENTION_TOOL_NAMES, CHAT_TOOL_NAMES } from "@stubwise/shared";
import type { AgentRunOptions, AgentRunResult, AgentRunner } from "../agent/runner.js";
import { fakeSelect } from "../providers/select-fake.js";
import { startChatBridge, type ChatBridge } from "./bridge.js";
import { askChatQuestion, closeOrphanReplies, syncReplyText } from "./mention.js";
import { AgentRunCancelledError } from "../agent/runner.js";
import { runChatTurn, type ChatTurnDeps } from "./turn.js";

// @Claude nella Chat, lato worker (area 4, fetta 3): il turno di una chiamata
// col contratto della Chat e `ask_question`, il testo dell'assistente scritto
// sul messaggio, lo stato a fine turno; la domanda scritta dal ponte.

let t: TestDb;
let bridge: ChatBridge;
let callerId: string;
let channelId: string;
let serverPath: string;
let cliTmp: string;

beforeAll(async () => {
  t = await startTestDb();
  bridge = await startChatBridge({
    serverUrl: "http://server.test",
    fetchImpl: (async () => Response.json([])) as unknown as typeof fetch,
    log: () => undefined,
    askQuestion: (sessionId, args) => askChatQuestion(t.db, sessionId, args),
  });
  const [caller] = await t.db.insert(users).values({ email: "ada@x.test", passwordHash: "x", role: "member", displayName: "Ada" }).returning();
  callerId = caller!.id;
  const { projectId } = await seedRepository(t.db);
  const [g] = await t.db.select({ id: chatChannels.id }).from(chatChannels).where(eq(chatChannels.projectId, projectId));
  channelId = g!.id;
  const dir = await mkdtemp(join(tmpdir(), "chat-mcp-"));
  serverPath = join(dir, "index.js");
  cliTmp = await mkdtemp(join(tmpdir(), "chat-mention-cli-"));
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

/** Il CLI prende l'input e scrive del testo, come il runner in streaming. */
async function speak(o: AgentRunOptions, text: string) {
  await t.db.insert(agentSessionEvents).values([
    { sessionId: o.session!.sessionId, segmentId: "seg", type: "input", data: { inputId: o.openingInput!.inputId, text: o.openingInput!.text } },
    { sessionId: o.session!.sessionId, segmentId: "seg", type: "assistant_text", data: { text } },
  ]);
}

/** Una chiamata come la crea il server: sessione `chat_mention`, conversazione, input, risposta «working». */
async function call(opts: { cliSessionId?: string; text?: string } = {}) {
  const [s] = await t.db
    .insert(agentSessions)
    .values({ ownerKey: `chat_mention:${crypto.randomUUID()}`, kind: "chat_mention", title: "" })
    .returning();
  await t.db.insert(claudeConversations).values({ sessionId: s!.id, ownerId: callerId, title: "", cliSessionId: opts.cliSessionId ?? null });
  const [input] = await t.db
    .insert(agentSessionInputs)
    .values({ sessionId: s!.id, text: opts.text ?? "riassumi\n\n--- The thread so far ---\nLuca: venerdì no", authorUserId: callerId })
    .returning();
  const [root] = await t.db.insert(chatMessages).values({ channelId, authorId: callerId, body: "@Claude riassumi" }).returning();
  const [reply] = await t.db
    .insert(chatMessages)
    .values({ channelId, kind: "claude", calledById: callerId, threadRootId: root!.id, body: "", agentSessionId: s!.id, claudeState: "working" })
    .returning();
  return { sessionId: s!.id, inputId: input!.id, replyId: reply!.id };
}

function deps(runner: AgentRunner): ChatTurnDeps {
  return {
    db: t.db,
    runner,
    bridge,
    maxTurns: 10,
    turnTimeoutMs: 60_000,
    chatServerPath: serverPath,
    cliPaths: { tmp: cliTmp, configDir: join(cliTmp, "config") },
    select: fakeSelect(t.db, "legacy"),
    log: () => undefined,
  };
}
const replyRow = async (id: string) => (await t.db.select().from(chatMessages).where(eq(chatMessages.id, id)))[0]!;

describe("il turno di una chiamata", () => {
  it("contratto della Chat e `ask_question`; il testo arriva sul messaggio e la risposta finisce «done»", async () => {
    const c = await call();
    const { runner, calls } = fakeRunner([
      async (o) => {
        await speak(o, "Venerdì manca Luca.");
        return OK;
      },
    ]);
    expect(await runChatTurn(deps(runner), { sessionId: c.sessionId, inputId: c.inputId, signal: new AbortController().signal })).toBe("completed");
    const o = calls[0]!;
    expect(o.prompt).toContain("HOW THIS CALL WORKS");
    expect(o.prompt).toContain("Ada called you in a chat thread");
    expect(o.prompt).toContain("Luca: venerdì no");
    expect(o.prompt).not.toContain("HOW THIS CONVERSATION WORKS");
    expect(o.allowedTools).toEqual([...CHAT_MENTION_TOOL_NAMES]);
    expect(JSON.stringify(o.mcpConfig)).toContain("CHAT_ASK_QUESTION");
    expect(await replyRow(c.replyId)).toMatchObject({ body: "Venerdì manca Luca.", claudeState: "done", searchFolded: "venerdi manca luca." });
  });

  it("un turno fallito lascia la risposta «failed» (other), col testo arrivato", async () => {
    const c = await call();
    const { runner } = fakeRunner([
      async (o) => {
        await speak(o, "Inizio…");
        return { exitCode: 1, output: "boom" };
      },
    ]);
    expect(await runChatTurn(deps(runner), { sessionId: c.sessionId, inputId: c.inputId, signal: new AbortController().signal })).toBe("failed");
    expect(await replyRow(c.replyId)).toMatchObject({ claudeState: "failed", claudeError: "other", body: "Inizio…" });
  });

  it("la ripresa dopo la risposta alla domanda: il prompt dice la risposta, e il testo continua la stessa risposta", async () => {
    const c = await call({ cliSessionId: "cli-1", text: "Marco" });
    await t.db.insert(agentSessionEvents).values({ sessionId: c.sessionId, segmentId: "old", type: "assistant_text", data: { text: "A chi la assegno?" } });
    const { runner, calls } = fakeRunner([
      async (o) => {
        await speak(o, "Assegnata a Marco, da confermare.");
        return OK;
      },
    ]);
    await runChatTurn(deps(runner), { sessionId: c.sessionId, inputId: c.inputId, signal: new AbortController().signal });
    expect(calls[0]!.prompt).toContain("ADA ANSWERED YOUR QUESTION");
    expect(calls[0]!.resumeSessionId).toBe("cli-1");
    expect((await replyRow(c.replyId)).body).toBe("A chi la assegno?\n\nAssegnata a Marco, da confermare.");
  });

  it("a budget finito niente turno, e la risposta è «failed» col motivo budget", async () => {
    const c = await call();
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    const [run] = await t.db
      .insert(agentRuns)
      .values({ phase: "triage", operation: "triage", model: "claude-sonnet-5-5", costUsd: "2" } as typeof agentRuns.$inferInsert)
      .returning({ id: agentRuns.id });
    try {
      const { runner, calls } = fakeRunner([async () => OK]);
      expect(await runChatTurn(deps(runner), { sessionId: c.sessionId, inputId: c.inputId, signal: new AbortController().signal })).toBe("skipped");
      expect(calls).toHaveLength(0);
      expect(await replyRow(c.replyId)).toMatchObject({ claudeState: "failed", claudeError: "budget" });
    } finally {
      await t.db.update(instanceSettings).set({ monthlyBudgetUsd: null });
      await t.db.delete(agentRuns).where(eq(agentRuns.id, run!.id));
    }
  });
});

describe("ask_question, dal ponte", () => {
  const ask = (secret: string, body: unknown) =>
    fetch(`${bridge.url}/tools/ask_question`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as { ok: boolean; text?: string } }));

  it("una domanda sola, valida, solo in un turno di chiamata; la risposta va in «waiting»", async () => {
    const c = await call();
    const free = bridge.grant({ sessionId: c.sessionId, serverToken: "x" });
    expect((await ask(free.secret, { question: "?", options: [{ label: "a" }, { label: "b" }] })).status).toBe(404);
    free.revoke();
    const grant = bridge.grant({ sessionId: c.sessionId, serverToken: "x", ask: true });
    expect((await ask(grant.secret, { question: "A chi?", options: [{ label: "solo una" }] })).body).toMatchObject({ ok: false });
    const first = await ask(grant.secret, { question: "A chi la assegno?", options: [{ label: "Marco" }, { label: "Luca", description: "dev" }] });
    expect(first.body).toMatchObject({ ok: true });
    expect(await replyRow(c.replyId)).toMatchObject({ claudeState: "waiting" });
    const [q] = await t.db.select().from(chatClaudeQuestions).where(eq(chatClaudeQuestions.replyMessageId, c.replyId));
    expect(q).toMatchObject({ text: "A chi la assegno?", options: [{ label: "Marco" }, { label: "Luca", description: "dev" }] });
    const second = await ask(grant.secret, { question: "E poi?", options: [{ label: "a" }, { label: "b" }] });
    expect(second.body).toMatchObject({ ok: false });
    expect(await t.db.select().from(chatClaudeQuestions).where(eq(chatClaudeQuestions.replyMessageId, c.replyId))).toHaveLength(1);
    grant.revoke();
  });

  it("una risposta fermata non chiede più", async () => {
    const c = await call();
    await t.db.update(chatMessages).set({ claudeState: "stopped" }).where(and(eq(chatMessages.id, c.replyId)));
    const grant = bridge.grant({ sessionId: c.sessionId, serverToken: "x", ask: true });
    expect((await ask(grant.secret, { question: "A chi?", options: [{ label: "a" }, { label: "b" }] })).body).toMatchObject({ ok: false });
    grant.revoke();
  });

  it("una conversazione libera non ha `ask_question` fra i tool", () => {
    expect(CHAT_TOOL_NAMES.some((n) => n.endsWith("__ask_question"))).toBe(false);
    expect(CHAT_MENTION_TOOL_NAMES.some((n) => n.endsWith("__ask_question"))).toBe(true);
  });
});

describe("review della fetta 3 (11 nov 2026)", () => {
  const signal = () => new AbortController().signal;

  it("1. una conversazione non più viva chiude la risposta «failed», uno stop resta «stopped»", async () => {
    const c = await call();
    await t.db.update(claudeConversations).set({ archivedAt: new Date() }).where(eq(claudeConversations.sessionId, c.sessionId));
    const { runner } = fakeRunner([async () => OK]);
    expect(await runChatTurn(deps(runner), { sessionId: c.sessionId, inputId: c.inputId, signal: signal() })).toBe("skipped");
    expect(await replyRow(c.replyId)).toMatchObject({ claudeState: "failed", claudeError: "other" });
    const stopped = await call();
    await t.db.update(chatMessages).set({ claudeState: "stopped" }).where(eq(chatMessages.id, stopped.replyId));
    await t.db.update(claudeConversations).set({ archivedAt: new Date() }).where(eq(claudeConversations.sessionId, stopped.sessionId));
    await runChatTurn(deps(runner), { sessionId: stopped.sessionId, inputId: stopped.inputId, signal: signal() });
    expect((await replyRow(stopped.replyId)).claudeState).toBe("stopped");
  });

  it("1. un turno annullato con l'input già preso (il worker si spegne) chiude la risposta «failed»", async () => {
    const c = await call();
    const controller = new AbortController();
    const { runner } = fakeRunner([
      async (o) => {
        await speak(o, "A metà…");
        controller.abort();
        throw new AgentRunCancelledError(null, "", 0);
      },
    ]);
    expect(await runChatTurn(deps(runner), { sessionId: c.sessionId, inputId: c.inputId, signal: controller.signal })).toBe("cancelled");
    expect(await replyRow(c.replyId)).toMatchObject({ claudeState: "failed", claudeError: "other", body: "A metà…" });
  });

  it("1. annullato PRIMA di prendere l'input: l'input torna in coda e la risposta resta «working»", async () => {
    const c = await call();
    const controller = new AbortController();
    const { runner } = fakeRunner([
      async () => {
        controller.abort();
        throw new AgentRunCancelledError(null, "", 0);
      },
    ]);
    expect(await runChatTurn(deps(runner), { sessionId: c.sessionId, inputId: c.inputId, signal: controller.signal })).toBe("cancelled");
    expect((await replyRow(c.replyId)).claudeState).toBe("working");
  });

  it("1. all'avvio: le risposte «working» senza un input in coda si chiudono, le altre no", async () => {
    const orphan = await call();
    await t.db.update(agentSessionInputs).set({ status: "delivered" }).where(eq(agentSessionInputs.id, orphan.inputId));
    const queued = await call();
    const waiting = await call();
    await t.db.update(agentSessionInputs).set({ status: "delivered" }).where(eq(agentSessionInputs.id, waiting.inputId));
    await t.db.update(chatMessages).set({ claudeState: "waiting" }).where(eq(chatMessages.id, waiting.replyId));
    await closeOrphanReplies(t.db);
    expect(await replyRow(orphan.replyId)).toMatchObject({ claudeState: "failed", claudeError: "other" });
    expect((await replyRow(queued.replyId)).claudeState).toBe("working");
    expect((await replyRow(waiting.replyId)).claudeState).toBe("waiting");
  });

  it("11. una risposta alla domanda in coda a fine turno: la risposta non diventa «done»", async () => {
    const c = await call();
    const { runner } = fakeRunner([
      async (o) => {
        await speak(o, "Ti chiedo una cosa.");
        // La risposta di chi chiama arriva mentre il turno finisce.
        await t.db.insert(agentSessionInputs).values({ sessionId: c.sessionId, text: "Marco", authorUserId: callerId });
        return OK;
      },
    ]);
    expect(await runChatTurn(deps(runner), { sessionId: c.sessionId, inputId: c.inputId, signal: signal() })).toBe("completed");
    expect((await replyRow(c.replyId)).claudeState).toBe("working");
  });

  it("10. --resume rifiutato nella ripresa: il prompt nuovo ha il contesto della chiamata e la risposta; il testo del tentativo scartato non si ripete", async () => {
    const c = await call({ cliSessionId: "cli-perso", text: "riassumi\n\n--- The thread so far ---\nLuca: venerdì no" });
    // Il primo turno è andato: input consegnato, la domanda nel testo.
    await t.db.update(agentSessionInputs).set({ status: "delivered" }).where(eq(agentSessionInputs.id, c.inputId));
    await t.db.insert(agentSessionEvents).values({ sessionId: c.sessionId, segmentId: "old", type: "assistant_text", data: { text: "A chi la assegno?" } });
    const [answer] = await t.db.insert(agentSessionInputs).values({ sessionId: c.sessionId, text: "Marco", authorUserId: callerId }).returning();
    const { runner, calls } = fakeRunner([
      async (o) => {
        // Il --resume rifiutato scrive un pezzo di testo senza prendere l'input.
        await t.db.insert(agentSessionEvents).values({ sessionId: o.session!.sessionId, segmentId: "seg", type: "assistant_text", data: { text: "parziale" } });
        return { exitCode: 1, output: "No conversation found" };
      },
      async (o) => {
        await speak(o, "Assegnata a Marco.");
        return OK;
      },
    ]);
    expect(await runChatTurn(deps(runner), { sessionId: c.sessionId, inputId: answer!.id, signal: signal() })).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.resumeSessionId).toBeUndefined();
    expect(calls[1]!.prompt).toContain("Luca: venerdì no");
    expect(calls[1]!.prompt).toContain("ADA ANSWERED YOUR QUESTION");
    expect(calls[1]!.prompt).toContain("Marco");
    expect((await replyRow(c.replyId)).body).toBe("A chi la assegno?\n\nAssegnata a Marco.");
  });

  it("13. un errore del CLI (limite, errore API) non finisce nella risposta pubblica, e la risposta è «failed»", async () => {
    const c = await call();
    const { runner } = fakeRunner([
      async (o) => {
        await t.db.insert(agentSessionEvents).values([
          { sessionId: o.session!.sessionId, segmentId: "seg", type: "input", data: { inputId: o.openingInput!.inputId, text: o.openingInput!.text } },
          { sessionId: o.session!.sessionId, segmentId: "seg", type: "assistant_text", data: { text: "API Error: 500 Internal server error", apiError: true } },
        ]);
        return OK;
      },
    ]);
    await runChatTurn(deps(runner), { sessionId: c.sessionId, inputId: c.inputId, signal: signal() });
    const row = await replyRow(c.replyId);
    expect(row.body).not.toContain("API Error");
    expect(row).toMatchObject({ claudeState: "failed", claudeError: "other" });
    await syncReplyText(t.db, c.sessionId);
    expect((await replyRow(c.replyId)).body).toBe("");
  });
});
