import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentSessionInputs,
  agentSessions,
  claudeChatToolTokens,
  claudeConversations,
  issueChatToolToken,
  revokeChatToolToken,
  users,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { CLAUDE_CONVERSATION_CLOSED_CHANNEL } from "@stubwise/shared";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatCwd, cliProjectDirName } from "./cli-dir.js";
import { ChatScheduler, type ChatSchedulerDeps } from "./scheduler.js";
import type { ChatTurnOutcome } from "./turn.js";

// Lo scheduler della chat: un turno per conversazione, tetto d'istanza,
// archiviare o eliminare ferma il turno e chiude ciò che era in coda.

let t: TestDb;
let userId: string;
let cliTmp: string;
beforeAll(async () => {
  cliTmp = await realpath(await mkdtemp(join(tmpdir(), "chat-sched-cli-")));
  t = await startTestDb();
  const [u] = await t.db.insert(users).values({ email: "a@x.test", passwordHash: "x", role: "member" }).returning();
  userId = u!.id;
}, 120_000);
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  await t.db
    .update(agentSessionInputs)
    .set({ status: "undelivered", reason: "session_not_live" })
    .where(eq(agentSessionInputs.status, "pending"));
});

async function conversation() {
  const [s] = await t.db
    .insert(agentSessions)
    .values({ ownerKey: `free:${crypto.randomUUID()}`, kind: "free", title: "t" })
    .returning();
  await t.db.insert(claudeConversations).values({ sessionId: s!.id, ownerId: userId, title: "t" });
  return s!.id;
}
async function input(sessionId: string, text = "ciao") {
  const [r] = await t.db.insert(agentSessionInputs).values({ sessionId, text, authorUserId: userId }).returning();
  return r!.id;
}
const inputOf = async (id: string) =>
  (await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, id)))[0]!;

function controlledTurns() {
  const calls: { sessionId: string; inputId: string; signal: AbortSignal; finish: (o: ChatTurnOutcome) => void }[] = [];
  const runTurn = vi.fn(
    (i: { sessionId: string; inputId: string; signal: AbortSignal }) =>
      new Promise<ChatTurnOutcome>((resolve) => {
        const entry = { ...i, finish: resolve };
        calls.push(entry);
        i.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
      }),
  );
  return { calls, runTurn };
}

function scheduler(over: Partial<ChatSchedulerDeps> = {}) {
  const revokeSession = vi.fn();
  const s = new ChatScheduler({
    db: t.db,
    maxConcurrent: 2,
    bridge: { revokeSession },
    runTurn: async () => "completed",
    log: () => undefined,
    cliPaths: { tmp: cliTmp, configDir: join(cliTmp, "config") },
    ...over,
  });
  return { s, revokeSession };
}
const tick = () => new Promise((r) => setTimeout(r, 50));

describe("lo scheduler della chat", () => {
  it("un solo turno per conversazione, il più vecchio prima, e il tetto d'istanza", async () => {
    const { calls, runTurn } = controlledTurns();
    const { s } = scheduler({ runTurn, maxConcurrent: 2 });
    const [a, b, c] = [await conversation(), await conversation(), await conversation()];
    const first = await input(a, "primo");
    await input(a, "secondo");
    await input(b);
    await input(c);
    s.requestTurn(a);
    s.requestTurn(a);
    s.requestTurn(b);
    s.requestTurn(c);
    await tick();
    expect(calls.map((x) => x.sessionId)).toEqual([a, b]);
    expect(calls[0]!.inputId).toBe(first);
    for (const call of calls) call.finish("completed");
    await s.shutdown();
  });

  it("a fine turno risveglia il relay", async () => {
    const deliverPending = vi.fn(async () => undefined);
    const { s } = scheduler();
    s.attachRelay({ deliverPending });
    const a = await conversation();
    await input(a);
    s.requestTurn(a);
    await tick();
    expect(deliverPending).toHaveBeenCalled();
  });

  it("archiviata (NOTIFY del server): ponte revocato, turno annullato, coda chiusa", async () => {
    const { calls, runTurn } = controlledTurns();
    let onClosed: ((payload: string) => void) | undefined;
    const listen = vi.fn(async (channel: string, cb: (payload: string) => void) => {
      if (channel === CLAUDE_CONVERSATION_CLOSED_CHANNEL) onClosed = cb;
    });
    const { s, revokeSession } = scheduler({ runTurn, listen });
    await s.start();
    const a = await conversation();
    await input(a, "in corso");
    s.requestTurn(a);
    await tick();
    const queued = await input(a, "in coda");
    await t.db.update(claudeConversations).set({ archivedAt: new Date() }).where(eq(claudeConversations.sessionId, a));
    onClosed!(JSON.stringify({ sessionId: a }));
    await tick();
    expect(revokeSession).toHaveBeenCalledWith(a);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(await inputOf(queued)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
  });

  it("una conversazione riaperta nel frattempo non perde il messaggio in coda", async () => {
    const { s } = scheduler();
    const a = await conversation();
    const queued = await input(a);
    await s.closeSession(a);
    expect((await inputOf(queued)).status).toBe("pending");
  });

  it("la pulizia periodica toglie i token dei turni revocati o scaduti", async () => {
    const a = await conversation();
    const revoked = await issueChatToolToken(t.db, { sessionId: a, userId, ttlMs: 60_000 });
    await revokeChatToolToken(t.db, revoked);
    await issueChatToolToken(t.db, { sessionId: a, userId, ttlMs: -60_000 });
    await issueChatToolToken(t.db, { sessionId: a, userId, ttlMs: 60_000 });
    const { s } = scheduler();
    await s.sweep();
    const left = await t.db.select().from(claudeChatToolTokens).where(eq(claudeChatToolTokens.sessionId, a));
    expect(left).toHaveLength(1);
    expect(left[0]!.revokedAt).toBeNull();
  });

  it("tetto pieno: la sessione in più NON si perde, parte appena si libera un posto", async () => {
    const { calls, runTurn } = controlledTurns();
    const { s } = scheduler({ runTurn, maxConcurrent: 1 });
    const [a, b] = [await conversation(), await conversation()];
    await input(a);
    await input(b);
    s.requestTurn(a);
    s.requestTurn(b);
    await tick();
    expect(calls.map((x) => x.sessionId)).toEqual([a]);
    calls[0]!.finish("completed");
    await tick();
    expect(calls.map((x) => x.sessionId)).toEqual([a, b]);
    calls[1]!.finish("completed");
    await s.shutdown();
  });

  it("un turno che rigetta: il relay si risveglia comunque (dopo la pausa)", async () => {
    const deliverPending = vi.fn(async () => undefined);
    const { s } = scheduler({
      runTurn: async () => {
        throw new Error("db giù");
      },
      retryMs: 10,
    });
    s.attachRelay({ deliverPending });
    const a = await conversation();
    await input(a);
    s.requestTurn(a);
    await tick();
    expect(deliverPending).toHaveBeenCalled();
  });

  const cliDir = (id: string) => join(cliTmp, "config", "projects", cliProjectDirName(chatCwd(id, cliTmp)));
  async function withTranscripts(id: string) {
    await mkdir(chatCwd(id, cliTmp), { recursive: true });
    await mkdir(cliDir(id), { recursive: true });
  }

  it("eliminata (NOTIFY): via cwd e trascrizioni del CLI; archiviata no", async () => {
    const { s } = scheduler();
    const gone = await conversation();
    const kept = await conversation();
    await withTranscripts(gone);
    await withTranscripts(kept);
    await t.db.delete(agentSessions).where(eq(agentSessions.id, gone));
    await t.db.update(claudeConversations).set({ archivedAt: new Date() }).where(eq(claudeConversations.sessionId, kept));
    await s.closeSession(gone);
    await s.closeSession(kept);
    expect(existsSync(cliDir(gone))).toBe(false);
    expect(existsSync(chatCwd(gone, cliTmp))).toBe(false);
    expect(existsSync(cliDir(kept))).toBe(true);
  });

  it("la potatura: trascrizioni orfane via; una sessione del CLI oltre 14 giorni scartata", async () => {
    const { s } = scheduler();
    const orphan = "0f0f0f0f-0000-4000-8000-0000000000aa";
    await withTranscripts(orphan);
    const old = await conversation();
    await withTranscripts(old);
    await t.db
      .update(claudeConversations)
      .set({ cliSessionId: "cli-vecchio", cliSessionStartedAt: new Date(Date.now() - 15 * 86_400_000) })
      .where(eq(claudeConversations.sessionId, old));
    const fresh = await conversation();
    await withTranscripts(fresh);
    await t.db
      .update(claudeConversations)
      .set({ cliSessionId: "cli-nuovo", cliSessionStartedAt: new Date() })
      .where(eq(claudeConversations.sessionId, fresh));
    await s.sweep();
    expect(existsSync(cliDir(orphan))).toBe(false);
    expect(existsSync(cliDir(old))).toBe(false);
    expect(existsSync(cliDir(fresh))).toBe(true);
    const [row] = await t.db.select().from(claudeConversations).where(eq(claudeConversations.sessionId, old));
    expect(row).toMatchObject({ cliSessionId: null, cliSessionStartedAt: null });
  });
});
