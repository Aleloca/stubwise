import { AI_MODEL_CHOICES } from "@stubwise/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { monthlyCostUsd } from "./cost.js";
import { agentRuns, aiJobs, aiModelSettings, prReviews } from "./schema.js";
import { expectSqlState, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Schema dei consumi di ogni operazione AI (migrazione 0096, 21 ott 2026):
 * `agent_runs` ammette run SENZA owner (chat, Docs...), porta `operation`
 * obbligatoria e CHECK sul catalogo; `ai_model_settings` rifiuta modelli e
 * operazioni fuori catalogo. Il backfill delle righe storiche sta in
 * `migration-0096.test.ts`.
 */
describe("schema: agent_runs senza owner e ai_model_settings", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  }, 180_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("(a) un run senza owner, operation='chat' e phase null si inserisce", async () => {
    const [row] = await db
      .insert(agentRuns)
      .values({ operation: "chat", phase: null, model: "claude-sonnet-5-5", costUsd: "0.5" })
      .returning();
    expect(row?.operation).toBe("chat");
    expect(row?.phase).toBeNull();
    expect(row?.cacheCreationTokens).toBe(0);
    expect(row?.projectId).toBeNull();
  });

  it("(b) due owner insieme violano agent_runs_owner_check", async () => {
    const { ticketId, repositoryId } = await seedTicket(db, { number: 1 });
    const [job] = await db.insert(aiJobs).values({ ticketId }).returning();
    const [review] = await db
      .insert(prReviews)
      .values({
        repositoryId,
        prNumber: 1,
        prUrl: "https://example.com/pr/1",
        prTitle: "t",
        headSha: "abc",
      })
      .returning();
    await expectSqlState(
      db.insert(agentRuns).values({
        jobId: job!.id,
        prReviewId: review!.id,
        operation: "fix_execute",
        phase: "fix",
        model: "m",
      }),
      "23514",
    );
  });

  it("(c) un run di un job senza fase viola agent_runs_job_phase_check", async () => {
    const { ticketId } = await seedTicket(db, { number: 2 });
    const [job] = await db.insert(aiJobs).values({ ticketId }).returning();
    await expectSqlState(
      db.insert(agentRuns).values({
        jobId: job!.id,
        operation: "fix_execute",
        phase: null,
        model: "m",
      }),
      "23514",
    );
    // Con la fase lo stesso run passa: il check non blocca altro.
    await db
      .insert(agentRuns)
      .values({ jobId: job!.id, operation: "fix_execute", phase: "fix", model: "m" });
  });

  it("(d) un'operazione fuori catalogo viola il CHECK", async () => {
    await expectSqlState(
      db.insert(agentRuns).values({ operation: "xxx", model: "m" }),
      "23514",
    );
  });

  it("(e) ai_model_settings rifiuta un modello o un'operazione fuori catalogo", async () => {
    await expectSqlState(
      db.insert(aiModelSettings).values({ operation: "chat", model: "opsu" }),
      "23514",
    );
    await expectSqlState(
      db.insert(aiModelSettings).values({ operation: "xxx", model: "opus" }),
      "23514",
    );
    // Ogni voce del catalogo dei modelli è accettata.
    for (const [i, model] of AI_MODEL_CHOICES.entries()) {
      const operation = i === 0 ? "chat" : "triage";
      await db
        .insert(aiModelSettings)
        .values({ operation, model })
        .onConflictDoUpdate({ target: aiModelSettings.operation, set: { model } });
    }
    const rows = await db.select().from(aiModelSettings);
    expect(rows.map((r) => r.operation).sort()).toEqual(["chat", "triage"]);
  });

  it("(g) monthlyCostUsd somma anche un run senza owner", async () => {
    await db.execute(sql`delete from agent_runs`);
    await db
      .insert(agentRuns)
      .values({ operation: "chat", phase: null, model: "m", costUsd: "1.250000" });
    expect(await monthlyCostUsd(db)).toBeCloseTo(1.25, 6);
  });
});
