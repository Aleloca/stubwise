import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailMessages, googleAccounts, googleWorkspaces, instanceSettings, mailOutgoing, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AgentRunner, AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import { fakeSelect } from "../providers/select-fake.js";
import { judgeWaitingThreads, type ReplyJudgeDeps } from "./reply-judge.js";

/**
 * Area 8, «Clienti in attesa» (J2): il giudizio a parte, SOLO sui thread che
 * passano il taglio e non hanno ancora un giudizio. Mai la casella di un
 * altro; idempotente; 2 tentativi; nel budget.
 */

let t: TestDb;
let db: Db;
let projectId: string;
const NOW = new Date("2026-11-15T12:00:00.000Z");
const OLD = new Date("2026-11-13T09:00:00.000Z"); // oltre le 24 ore
const RECENT = new Date("2026-11-15T10:00:00.000Z");

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
  ({ projectId } = await seedRepository(db));
}, 120_000);
afterAll(async () => {
  await t.stop();
});

class FakeRunner implements AgentRunner {
  calls: AgentRunOptions[] = [];
  constructor(private readonly replies: string[]) {}
  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(opts);
    return { output: this.replies.shift() ?? "{}", exitCode: 0 };
  }
}

async function mailbox(email = `casella-${randomUUID()}@acme.com`) {
  const [u] = await db.insert(users).values({ email: `u-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" }).returning();
  const [w] = await db.insert(googleWorkspaces).values({ name: "Acme", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "x" }).returning();
  const [a] = await db.insert(googleAccounts).values({ userId: u!.id, workspaceId: w!.id, email, googleSub: randomUUID(), refreshTokenEncrypted: "x" }).returning();
  return a!;
}

async function msg(accountId: string, threadId: string, over: Partial<typeof emailMessages.$inferInsert>) {
  const [m] = await db
    .insert(emailMessages)
    .values({ accountId, gmailMessageId: randomUUID(), threadId, fromAddress: "cliente@cliente.it", receivedAt: OLD, textExcerpt: "Mi mandate il preventivo?", status: "classified", ...over })
    .returning();
  return m!;
}

/** Un thread che passa il taglio: il cliente, ammesso, nel progetto, oltre le 24 ore. */
async function waitingThread(accountId: string, over: Partial<typeof emailMessages.$inferInsert> = {}) {
  const threadId = `th-${randomUUID()}`;
  const m = await msg(accountId, threadId, { admitted: true, projectId, ...over });
  return { threadId, message: m };
}

const yes = JSON.stringify({ needsMyReply: true, reason: "Chiede il preventivo." });
const deps = (runner: AgentRunner, over: Partial<ReplyJudgeDeps> = {}): ReplyJudgeDeps => ({
  db,
  runner,
  select: fakeSelect(db, "legacy"),
  now: () => NOW,
  monthlyCostUsdFn: async () => 0,
  ...over,
});
const judgmentOf = async (id: string) => (await db.select().from(emailMessages).where(eq(emailMessages.id, id)))[0]!;

describe("J2: cosa si giudica", () => {
  it("un thread che passa il taglio: UN run con la sua operazione, il giudizio scritto; un secondo giro non rifà niente", async () => {
    const box = await mailbox();
    const { message } = await waitingThread(box.id);
    const runner = new FakeRunner([yes]);
    expect(await judgeWaitingThreads(deps(runner), box.id)).toBe(1);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.usage).toEqual({ operation: "mail_reply_judgment", projectId, emailMessageId: message.id });
    expect(runner.calls[0]!.builtinTools).toEqual([]);
    expect((await judgmentOf(message.id)).replyJudgment).toMatchObject({ needsMyReply: true, reason: "Chiede il preventivo." });
    await judgeWaitingThreads(deps(runner), box.id);
    expect(runner.calls).toHaveLength(1);
  });

  it("NEGATIVI: l'ultimo è mio; meno di 24 ore; una risposta mandata dopo; rumore; nessun ammesso → nessun run", async () => {
    const box = await mailbox();
    const mine = await waitingThread(box.id);
    await msg(box.id, mine.threadId, { fromAddress: box.email, receivedAt: new Date(OLD.getTime() + 60_000), admitted: false, status: "ignored" });
    await waitingThread(box.id, { receivedAt: RECENT });
    const replied = await waitingThread(box.id);
    await db.insert(mailOutgoing).values({ userId: box.userId, accountId: box.id, gmailDraftId: "d", sendAt: NOW, state: "sent", gmailThreadId: replied.threadId, sentAt: new Date(OLD.getTime() + 3_600_000) });
    await waitingThread(box.id, { status: "ignored", importance: "normal" });
    await waitingThread(box.id, { admitted: false });
    const runner = new FakeRunner([]);
    await judgeWaitingThreads(deps(runner), box.id);
    expect(runner.calls).toEqual([]);
  });

  it("il rumore con importanza ALTA si giudica; la risposta di un COLLEGA (casella dell'istanza) è un candidato", async () => {
    const box = await mailbox();
    const colleague = await mailbox();
    await waitingThread(box.id, { status: "ignored", importance: "high" });
    const withColleague = await waitingThread(box.id);
    await msg(box.id, withColleague.threadId, { fromAddress: colleague.email, receivedAt: new Date(OLD.getTime() + 60_000), admitted: false, status: "new", textExcerpt: "Te lo mando io domani." });
    const runner = new FakeRunner([yes, JSON.stringify({ needsMyReply: false, reason: "Ha risposto il collega." })]);
    expect(await judgeWaitingThreads(deps(runner), box.id)).toBe(2);
    const prompt = runner.calls.map((c) => c.prompt).find((p) => p.includes("Te lo mando io domani"))!;
    expect(prompt).toContain(colleague.email);
  });
});

describe("J2: privacy, tentativi, budget, un messaggio nuovo", () => {
  it("MAI la casella di un altro: lo stesso thread nella casella di un collega non entra nel prompt", async () => {
    const box = await mailbox();
    const other = await mailbox();
    const { threadId } = await waitingThread(box.id);
    await msg(other.id, threadId, { textExcerpt: "SEGRETO della casella del collega", receivedAt: new Date(OLD.getTime() - 60_000), admitted: true, projectId });
    const runner = new FakeRunner([yes, yes]);
    await judgeWaitingThreads(deps(runner), box.id);
    expect(runner.calls.map((c) => c.prompt).join("\n")).not.toContain("SEGRETO");
  });

  it("un'uscita fuori schema non è un sì: dopo 2 tentativi `error`, e niente terzo run", async () => {
    const box = await mailbox();
    const { message } = await waitingThread(box.id);
    const runner = new FakeRunner([JSON.stringify({ needsMyReply: "yes", reason: "x" }), "non è json"]);
    await judgeWaitingThreads(deps(runner), box.id);
    expect((await judgmentOf(message.id)).replyJudgment).toBeNull();
    await judgeWaitingThreads(deps(runner), box.id);
    const row = await judgmentOf(message.id);
    expect(row.replyJudgment).toMatchObject({ error: "invalid_or_failed" });
    expect(row.replyJudgmentAttempts).toBe(2);
    await judgeWaitingThreads(deps(runner), box.id);
    expect(runner.calls).toHaveLength(2);
  });

  it("2 tentativi consumati e nessun giudizio (worker morto fra il tentativo e la scrittura): nessun altro run", async () => {
    const box = await mailbox();
    const { message } = await waitingThread(box.id);
    await db.update(emailMessages).set({ replyJudgmentAttempts: 2 }).where(eq(emailMessages.id, message.id));
    const runner = new FakeRunner([yes]);
    await judgeWaitingThreads(deps(runner), box.id);
    expect(runner.calls).toEqual([]);
  });

  it("budget esaurito: nessun run, nessun tentativo consumato", async () => {
    const box = await mailbox();
    const { message } = await waitingThread(box.id);
    await db.update(instanceSettings).set({ monthlyBudgetUsd: "1" }).where(eq(instanceSettings.id, 1));
    const runner = new FakeRunner([yes]);
    await judgeWaitingThreads(deps(runner, { monthlyCostUsdFn: async () => 5 }), box.id);
    await db.update(instanceSettings).set({ monthlyBudgetUsd: null }).where(eq(instanceSettings.id, 1));
    expect(runner.calls).toEqual([]);
    expect((await judgmentOf(message.id)).replyJudgmentAttempts).toBe(0);
  });

  it("un messaggio nuovo del cliente dopo un «no» è un ultimo messaggio senza giudizio: si rigiudica", async () => {
    const box = await mailbox();
    const { threadId } = await waitingThread(box.id);
    const runner = new FakeRunner([JSON.stringify({ needsMyReply: false, reason: "Ringrazia." }), yes]);
    await judgeWaitingThreads(deps(runner), box.id);
    const again = await msg(box.id, threadId, { receivedAt: new Date(OLD.getTime() + 3_600_000), admitted: true, projectId, textExcerpt: "Ah, e la fattura?" });
    await judgeWaitingThreads(deps(runner), box.id);
    expect(runner.calls).toHaveLength(2);
    expect((await judgmentOf(again.id)).replyJudgment).toMatchObject({ needsMyReply: true });
  });
});
