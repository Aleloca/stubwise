import { randomUUID } from "node:crypto";
import {
  agentRuns,
  emailMessages,
  emailProposals,
  googleAccounts,
  googleWorkspaces,
  projectMembers,
  projects,
  roles,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentRunOptions, AgentRunResult, AgentRunner } from "../agent/runner.js";
import { fakeSelect } from "../providers/select-fake.js";
import type { ClassifyBatchDeps } from "./classify.js";
import { classifyNewMessagesV2, isoDateOrNull, revalidateV2, type CandidateProject } from "./classify-v2.js";

/**
 * LA CLASSIFICAZIONE NUOVA (area 6, F2, task 3): candidati dai destinatari,
 * importanza e scadenza, proposte rivalidate, UNA classificazione per
 * Message-ID, la proposta condivisa (`mail_recipients`).
 */

let testDb: TestDb;
let db: Db;
let roleId: string;
beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  roleId = (await db.select({ id: roles.id }).from(roles).where(eq(roles.scope, "project")).limit(1))[0]!.id;
}, 120_000);
afterEach(async () => {
  await db.delete(agentRuns);
  await db.delete(emailProposals);
  await db.delete(emailMessages);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
  await db.delete(projectMembers);
  await db.delete(tickets);
  await db.delete(projects);
});
afterAll(async () => {
  await testDb.stop();
});

class FakeRunner implements AgentRunner {
  calls: AgentRunOptions[] = [];
  constructor(private readonly replies: string[]) {}
  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(opts);
    return {
      output: this.replies.shift() ?? "{}",
      exitCode: 0,
      usage: {
        totalCostUsd: 0.002,
        models: [{ model: "claude-haiku", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.002 }],
      },
    };
  }
}

async function seedUser(email: string): Promise<string> {
  return (await db.insert(users).values({ email, passwordHash: "x", role: "member" } as typeof users.$inferInsert).returning())[0]!.id;
}
async function seedProject(name: string, memberIds: string[]): Promise<string> {
  const [row] = await db.insert(projects).values({ name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning({ id: projects.id });
  for (const userId of memberIds) await db.insert(projectMembers).values({ projectId: row!.id, userId, roleId });
  return row!.id;
}
async function seedAccount(userId: string, email: string, overrides: Partial<typeof googleAccounts.$inferInsert> = {}) {
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  return (await db.insert(googleAccounts).values({ userId, workspaceId: ws!.id, email, googleSub: randomUUID(), refreshTokenEncrypted: "r", ...overrides }).returning())[0]!;
}
async function seedMessage(accountId: string, overrides: Partial<typeof emailMessages.$inferInsert> = {}) {
  return (
    await db
      .insert(emailMessages)
      .values({
        accountId,
        gmailMessageId: `g-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: "cliente@cliente.com",
        toAddresses: [],
        subject: "Export entro venerdì",
        receivedAt: new Date(),
        textExcerpt: "Ci serve l'export CSV entro venerdì.",
        ...overrides,
      })
      .returning()
  )[0]!;
}
function deps(runner: AgentRunner, overrides: Partial<ClassifyBatchDeps> = {}): ClassifyBatchDeps {
  return {
    db,
    runner,
    lang: "it",
    select: fakeSelect(db, "legacy"),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    maxPerTick: 10,
    threadCooldownMinutes: 0,
    ...overrides,
  };
}

describe("revalidateV2", () => {
  const candidate: CandidateProject = {
    id: "p1",
    code: "AUD",
    name: "Audin",
    description: null,
    openTickets: [{ id: "t-12", number: 12, title: "Export" }],
    members: [{ id: "u1", name: "Ada" }],
  };

  it("tiene solo i candidati, solo i membri come incaricato, solo le task aperte date", () => {
    const out = revalidateV2(
      {
        importance: "high",
        dueDate: "2026-11-20",
        summary: "s",
        projects: [
          { projectId: "p1", proposals: [
            { type: "create_task", title: "Export CSV", assigneeId: "u1", dueDate: "2026-11-20" },
            { type: "create_task", title: "Altro", assigneeId: "estraneo" },
            { type: "comment_ticket", ticketNumber: 12, body: "Visto" },
            { type: "comment_ticket", ticketNumber: 99, body: "Inventata" },
            { type: "send_email", title: "no" },
          ] },
          { projectId: "inventato", proposals: [{ type: "create_task", title: "X" }] },
        ],
        uncertainProjectIds: [],
      },
      [candidate],
      5,
    );
    expect(out.projects).toEqual([
      {
        projectId: "p1",
        actions: [
          { type: "create_task", args: { title: "Export CSV", description: "", assigneeId: "u1", dueDate: "2026-11-20" } },
          { type: "comment_ticket", args: { ticketId: "t-12", body: "Visto" } },
        ],
      },
    ]);
    expect(out.dueDate).toBe("2026-11-20");
  });

  it("incerti solo se almeno due candidati e nessun progetto certo", () => {
    const two = [candidate, { ...candidate, id: "p2" }];
    expect(revalidateV2({ importance: "normal", summary: "", projects: [], uncertainProjectIds: ["p1", "p2", "x"] }, two, 5).uncertainProjectIds).toEqual(["p1", "p2"]);
    expect(revalidateV2({ importance: "normal", summary: "", projects: [], uncertainProjectIds: ["p1"] }, two, 5).uncertainProjectIds).toEqual([]);
  });

  it("isoDateOrNull: una data vera o null", () => {
    expect(isoDateOrNull("2026-02-30")).toBeNull();
    expect(isoDateOrNull("domani")).toBeNull();
    expect(isoDateOrNull("2026-11-20T10:00:00Z")).toBe("2026-11-20");
  });
});

describe("classifyNewMessagesV2", () => {
  it("candidati dai destinatari membri: solo i loro progetti nel prompt; scrive importanza, scadenza e la proposta condivisa", async () => {
    const ada = await seedUser(`ada-${randomUUID()}@acme.com`);
    const audin = await seedProject("Audin", [ada]);
    // Un progetto con membri, ma nessuno di loro è fra i destinatari.
    await seedProject("Estraneo", [await seedUser(`carla-${randomUUID()}@acme.com`)]);
    const account = await seedAccount(ada, `ada-box-${randomUUID()}@acme.com`);
    const message = await seedMessage(account.id, { rfcMessageId: "<x1@cliente.com>" });
    const runner = new FakeRunner([
      JSON.stringify({ importance: "high", dueDate: "2026-11-20", summary: "Export", projects: [{ projectId: audin, proposals: [{ type: "create_task", title: "Export CSV", assigneeId: ada }] }] }),
    ]);

    const stats = await classifyNewMessagesV2(deps(runner), account.id);

    expect(stats.classified).toBe(1);
    expect(runner.calls[0]!.prompt).toContain("Audin");
    expect(runner.calls[0]!.prompt).not.toContain("Estraneo");
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, message.id));
    expect(row).toMatchObject({ classificationState: "done", importance: "high", dueDate: "2026-11-20", scopeProjectIds: [audin], projectId: audin, status: "classified" });
    const [proposal] = await db.select().from(emailProposals);
    expect(proposal).toMatchObject({ projectId: audin, rfcMessageId: "<x1@cliente.com>", audience: "mail_recipients", status: "classified" });
    expect((proposal!.classification as { version: number; actions: unknown[] }).actions).toEqual([
      { type: "create_task", args: { title: "Export CSV", description: "", assigneeId: ada, dueDate: null } },
    ]);
  });

  it("la STESSA email in un'altra casella non si paga due volte: copia la classificazione, una proposta sola", async () => {
    const ada = await seedUser(`ada-${randomUUID()}@acme.com`);
    const bruno = await seedUser(`bruno-${randomUUID()}@acme.com`);
    const audin = await seedProject("Audin", [ada, bruno]);
    const a = await seedAccount(ada, `a-${randomUUID()}@acme.com`);
    const b = await seedAccount(bruno, `b-${randomUUID()}@acme.com`);
    await seedMessage(a.id, { rfcMessageId: "<shared@cliente.com>" });
    const twin = await seedMessage(b.id, { rfcMessageId: "<shared@cliente.com>" });
    const runner = new FakeRunner([
      JSON.stringify({ importance: "normal", projects: [{ projectId: audin, proposals: [{ type: "create_task", title: "Export" }] }] }),
    ]);

    await classifyNewMessagesV2(deps(runner), a.id);
    await classifyNewMessagesV2(deps(runner), b.id);

    expect(runner.calls).toHaveLength(1);
    const [copied] = await db.select().from(emailMessages).where(eq(emailMessages.id, twin.id));
    expect(copied).toMatchObject({ classificationState: "done", importance: "normal", scopeProjectIds: [audin] });
    expect(await db.select().from(emailProposals)).toHaveLength(1);
  });

  it("review F2, punto 8: due copie in attesa nello stesso momento (dopo «Quale progetto?», o due caselle nello stesso giro): si classifica UNA volta", async () => {
    const ada = await seedUser(`ada-${randomUUID()}@acme.com`);
    const bruno = await seedUser(`bruno-${randomUUID()}@acme.com`);
    const audin = await seedProject("Audin", [ada, bruno]);
    const a = await seedAccount(ada, `a-${randomUUID()}@acme.com`);
    const b = await seedAccount(bruno, `b-${randomUUID()}@acme.com`);
    const first = await seedMessage(a.id, { rfcMessageId: "<due@cliente.com>" });
    const second = await seedMessage(b.id, { rfcMessageId: "<due@cliente.com>" });
    const [leader, follower] = first.id < second.id ? [a, b] : [b, a];
    const runner = new FakeRunner([
      JSON.stringify({ importance: "normal", projects: [{ projectId: audin, proposals: [{ type: "create_task", title: "Export" }] }] }),
      JSON.stringify({ importance: "normal", projects: [{ projectId: audin, proposals: [{ type: "create_task", title: "Export" }] }] }),
    ]);
    // La casella che NON guida passa per prima: aspetta, non paga.
    await classifyNewMessagesV2(deps(runner), follower.id);
    expect(runner.calls).toHaveLength(0);
    await classifyNewMessagesV2(deps(runner), leader.id);
    await classifyNewMessagesV2(deps(runner), follower.id);
    expect(runner.calls).toHaveLength(1);
    const rows = await db.select().from(emailMessages);
    expect(rows.every((r) => r.classificationState === "done")).toBe(true);
  });

  it("review F2, punto 8: se la copia che guida non si classifica (fallita), l'altra non resta ferma", async () => {
    const ada = await seedUser(`ada-${randomUUID()}@acme.com`);
    const bruno = await seedUser(`bruno-${randomUUID()}@acme.com`);
    await seedProject("Audin", [ada, bruno]);
    const a = await seedAccount(ada, `a-${randomUUID()}@acme.com`);
    const b = await seedAccount(bruno, `b-${randomUUID()}@acme.com`);
    const first = await seedMessage(a.id, { rfcMessageId: "<tre@cliente.com>" });
    const second = await seedMessage(b.id, { rfcMessageId: "<tre@cliente.com>" });
    const [leaderMsg, follower] = first.id < second.id ? [first, b] : [second, a];
    await db.update(emailMessages).set({ classificationState: "failed", status: "failed" }).where(eq(emailMessages.id, leaderMsg.id));
    const runner = new FakeRunner([JSON.stringify({ importance: "low", projects: [] })]);
    await classifyNewMessagesV2(deps(runner), follower.id);
    expect(runner.calls).toHaveLength(1);
  });

  it("nessun progetto candidato: si classifica lo stesso (l'importanza serve), nessuna proposta", async () => {
    const ada = await seedUser(`ada-${randomUUID()}@acme.com`);
    const account = await seedAccount(ada, `a-${randomUUID()}@acme.com`);
    const message = await seedMessage(account.id);
    const runner = new FakeRunner([JSON.stringify({ importance: "low" })]);
    const stats = await classifyNewMessagesV2(deps(runner), account.id);
    expect(stats.ignored).toBe(1);
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, message.id));
    expect(row).toMatchObject({ classificationState: "done", importance: "low", status: "ignored" });
    expect(await db.select().from(emailProposals)).toEqual([]);
  });

  it("incerto fra due candidati: una proposta «Quale progetto?»", async () => {
    const ada = await seedUser(`ada-${randomUUID()}@acme.com`);
    const p1 = await seedProject("Uno", [ada]);
    const p2 = await seedProject("Due", [ada]);
    const account = await seedAccount(ada, `a-${randomUUID()}@acme.com`);
    await seedMessage(account.id, { rfcMessageId: "<u@x>" });
    const runner = new FakeRunner([JSON.stringify({ importance: "normal", projects: [], uncertainProjectIds: [p1, p2] })]);
    await classifyNewMessagesV2(deps(runner), account.id);
    const [proposal] = await db.select().from(emailProposals);
    expect((proposal!.classification as { choose?: { projectIds: string[] } }).choose?.projectIds.sort()).toEqual([p1, p2].sort());
  });

  it("output fuori schema: `failed`, e nessuna proposta", async () => {
    const ada = await seedUser(`ada-${randomUUID()}@acme.com`);
    const account = await seedAccount(ada, `a-${randomUUID()}@acme.com`);
    const message = await seedMessage(account.id);
    await classifyNewMessagesV2(deps(new FakeRunner(["non è json"])), account.id);
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, message.id));
    expect(row).toMatchObject({ classificationState: "failed", status: "failed" });
  });

  it("il run è senza tool e conta per il tetto giornaliero (operation e phase di prima)", async () => {
    const ada = await seedUser(`ada-${randomUUID()}@acme.com`);
    const account = await seedAccount(ada, `a-${randomUUID()}@acme.com`);
    await seedMessage(account.id);
    const runner = new FakeRunner([JSON.stringify({ importance: "low" })]);
    await classifyNewMessagesV2(deps(runner), account.id);
    expect(runner.calls[0]!.builtinTools).toEqual([]);
    expect(runner.calls[0]!.usage).toMatchObject({ operation: "mail_classify", phase: "email_classify", record: false });
    expect(await db.select().from(agentRuns)).toHaveLength(1);
  });

  it("caselle con le proposte spente o posta prima del taglio: nessun run", async () => {
    const ada = await seedUser(`ada-${randomUUID()}@acme.com`);
    const off = await seedAccount(ada, `off-${randomUUID()}@acme.com`, { proposalsEnabled: false });
    await seedMessage(off.id);
    const cut = await seedAccount(ada, `cut-${randomUUID()}@acme.com`, { proposalsSince: new Date() });
    await seedMessage(cut.id, { createdAt: new Date(Date.now() - 60_000) });
    const runner = new FakeRunner([]);
    await classifyNewMessagesV2(deps(runner), off.id);
    await classifyNewMessagesV2(deps(runner), cut.id);
    expect(runner.calls).toEqual([]);
  });
});
