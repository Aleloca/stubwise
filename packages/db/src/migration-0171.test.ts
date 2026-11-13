import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { agentRuns, automationRuns, automations } from "./schema.js";
import { expectSqlState, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0171 (13 nov 2026, area 7, fetta 3): l'operazione AI
 * `automation_step` e l'owner `automation_id` (con `automation_run_id`, NULL per
 * una prova) di `agent_runs`. Il CHECK «al più un owner» resta vero.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0171", () => {
  it("un passo (automazione + esecuzione) e una prova (solo automazione) si registrano; la run senza automazione no; due owner no", async () => {
    const { projectId } = await seedRepository(t.db);
    const [a] = await t.db.insert(automations).values({ code: `C${randomUUID().slice(0, 5)}-A1`, seq: 1, name: "A", projectId }).returning();
    const [run] = await t.db.insert(automationRuns).values({ automationId: a!.id, n: 1, version: 1, title: "R", origin: "manual" }).returning();
    const row = { operation: "automation_step" as const, projectId, model: "claude-sonnet-4-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
    await t.db.insert(agentRuns).values({ ...row, automationId: a!.id, automationRunId: run!.id });
    await t.db.insert(agentRuns).values({ ...row, automationId: a!.id });
    await expectSqlState(t.db.insert(agentRuns).values({ ...row, automationRunId: run!.id }), "23514");
    // Due owner: il CHECK (valutato prima delle FK) lo rifiuta.
    await expectSqlState(t.db.insert(agentRuns).values({ ...row, automationId: a!.id, jobId: randomUUID(), phase: "fix" }), "23514");
  });
});
