import { aiJobs, automationRules, comments, instanceSettings, projects, tickets, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import { checkBudgetsBeforeRun, holdForBudget, type JobOutcomeContext } from "./job-outcomes.js";
import type { PublishFn } from "./notify.js";

// I tetti di spesa al CONFINE: la spesa uguale al tetto blocca, e uno zero è
// un tetto (non «non impostato»). Nessun repo git: le funzioni di costo sono
// iniettate, e le sole righe lette dal DB sono automation_rules e
// instance_settings (seedate dalla migrazione, condivise: si ripristinano).

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.update(automationRules).set({ maxCostUsd: null });
  await testDb.db
    .update(instanceSettings)
    .set({ monthlyBudgetUsd: null })
    .where(eq(instanceSettings.id, 1));
  await testDb.db.delete(projects);
});

afterAll(async () => {
  await testDb.stop();
});

async function setCaps(db: Db, caps: { monthly?: string | null; ticket?: string | null }): Promise<void> {
  if (caps.monthly !== undefined) {
    await db.update(instanceSettings).set({ monthlyBudgetUsd: caps.monthly }).where(eq(instanceSettings.id, 1));
  }
  if (caps.ticket !== undefined) {
    await db.update(automationRules).set({ maxCostUsd: caps.ticket }).where(eq(automationRules.type, "bug"));
  }
}

function check(
  db: Db,
  spent: { monthly: number; ticket: number },
  manualTrigger = false,
) {
  const ticketCostUsdFn = vi.fn(async () => spent.ticket);
  const monthlyCostUsdFn = vi.fn(async () => spent.monthly);
  return {
    ticketCostUsdFn,
    run: () =>
      checkBudgetsBeforeRun(db, {
        ticketId: "00000000-0000-0000-0000-000000000001",
        ticketType: "bug",
        manualTrigger,
        ticketCostUsdFn,
        monthlyCostUsdFn,
      }),
  };
}

describe("checkBudgetsBeforeRun — i tetti al confine", () => {
  it("spesa mensile ESATTAMENTE uguale al tetto → held monthly", async () => {
    await setCaps(testDb.db, { monthly: "10" });
    const { run, ticketCostUsdFn } = check(testDb.db, { monthly: 10, ticket: 0 });
    expect(await run()).toEqual({ kind: "held", scope: "monthly", limitUsd: 10, spentUsd: 10 });
    // Mensile prima del ticket: il costo del ticket non viene nemmeno letto.
    expect(ticketCostUsdFn).not.toHaveBeenCalled();
  });

  it("mensile appena sotto il tetto → si valuta il tetto del ticket", async () => {
    await setCaps(testDb.db, { monthly: "10", ticket: "2" });
    const { run, ticketCostUsdFn } = check(testDb.db, { monthly: 9.99, ticket: 2 });
    expect(await run()).toEqual({ kind: "held", scope: "ticket", limitUsd: 2, spentUsd: 2 });
    expect(ticketCostUsdFn).toHaveBeenCalledTimes(1);
  });

  it("ticket ESATTAMENTE uguale al tetto → held ticket", async () => {
    await setCaps(testDb.db, { ticket: "2.5" });
    const { run } = check(testDb.db, { monthly: 0, ticket: 2.5 });
    expect(await run()).toEqual({ kind: "held", scope: "ticket", limitUsd: 2.5, spentUsd: 2.5 });
  });

  it("ticket sotto il tetto → ok, con il tetto e la spesa storica come base", async () => {
    await setCaps(testDb.db, { monthly: "10", ticket: "2.5" });
    const { run } = check(testDb.db, { monthly: 3, ticket: 2.49 });
    expect(await run()).toEqual({ kind: "ok", maxCostUsd: 2.5, ticketCostBaseline: 2.49 });
  });

  it("tetto mensile a 0 con spesa 0 → held: lo zero è un tetto, non «non impostato»", async () => {
    await setCaps(testDb.db, { monthly: "0" });
    const { run } = check(testDb.db, { monthly: 0, ticket: 0 });
    expect(await run()).toEqual({ kind: "held", scope: "monthly", limitUsd: 0, spentUsd: 0 });
  });

  it("tetto del ticket a 0 con spesa 0 → held ticket", async () => {
    await setCaps(testDb.db, { ticket: "0" });
    const { run } = check(testDb.db, { monthly: 0, ticket: 0 });
    expect(await run()).toEqual({ kind: "held", scope: "ticket", limitUsd: 0, spentUsd: 0 });
  });

  it("nessun tetto impostato → ok con maxCostUsd null", async () => {
    const { run } = check(testDb.db, { monthly: 1000, ticket: 1000 });
    expect(await run()).toEqual({ kind: "ok", maxCostUsd: null, ticketCostBaseline: 1000 });
  });

  it("manualTrigger con spesa oltre entrambi i tetti → ok con null/0, senza leggere i costi", async () => {
    await setCaps(testDb.db, { monthly: "1", ticket: "1" });
    const { run, ticketCostUsdFn } = check(testDb.db, { monthly: 50, ticket: 50 }, true);
    expect(await run()).toEqual({ kind: "ok", maxCostUsd: null, ticketCostBaseline: 0 });
    expect(ticketCostUsdFn).not.toHaveBeenCalled();
  });
});

describe("holdForBudget — esito di holdJob", () => {
  async function fixture(status: "fixing" | "failed"): Promise<{ ctx: JobOutcomeContext; jobId: string; ticketId: string; publish: ReturnType<typeof vi.fn<PublishFn>> }> {
    const db = testDb.db;
    const [project] = await db
      .insert(projects)
      .values({ name: "Budget", slug: `budget-${status}`, ingestionKey: `ingestion-budget-${status}` })
      .returning();
    if (!project) throw new Error("progetto non inserito");
    const [ticket] = await db
      .insert(tickets)
      .values({ projectId: project.id, number: 1, title: "t", body: "b", type: "bug", priority: "high", source: "sdk_error" })
      .returning();
    if (!ticket) throw new Error("ticket non inserito");
    const [job] = await db
      .insert(aiJobs)
      .values({ ticketId: ticket.id, status, startedAt: new Date() })
      .returning();
    if (!job) throw new Error("job non inserito");
    const publish = vi.fn<PublishFn>(async () => ({ published: 0, notificationIds: [] }));
    const ctx: JobOutcomeContext = {
      db,
      jobId: job.id,
      ticket: { id: ticket.id, number: ticket.number, title: ticket.title },
      projectName: project.name,
      lang: "en",
      url: `/tickets/${ticket.id}`,
      notifyDeps: { projectName: project.name, publish },
      notifyRefs: { projectId: project.id, ticketId: ticket.id, jobId: job.id },
      runner: new FakeAgentRunner(),
      summaryTimeoutMs: 1000,
      logPrefix: "[fix]",
    };
    return { ctx, jobId: job.id, ticketId: ticket.id, publish };
  }

  it("job attivo → true, job held con reason budget", async () => {
    const { ctx, jobId, ticketId, publish } = await fixture("fixing");
    expect(await holdForBudget(ctx, "ticket", 2, 3)).toBe(true);
    const [job] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("held");
    expect(job?.heldReason).toBe("budget");
    expect(await testDb.db.select().from(comments).where(eq(comments.ticketId, ticketId))).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("ownership persa (job non più attivo) → false; commento e notifica partono comunque, come prima", async () => {
    const { ctx, jobId, ticketId, publish } = await fixture("failed");
    expect(await holdForBudget(ctx, "monthly", 2, 3)).toBe(false);
    const [job] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
    expect(job?.status).toBe("failed");
    expect(job?.log).toContain("[fix] ownership persa dopo il hold per budget");
    expect(await testDb.db.select().from(comments).where(eq(comments.ticketId, ticketId))).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
