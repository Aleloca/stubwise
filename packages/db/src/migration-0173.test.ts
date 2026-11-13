import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuns, automationRuns, automations, projects } from "./schema.js";
import { expectSqlState, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0173 (13 nov 2026, area 7, fetta 3): l'operazione AI
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

describe("migrazione 0173", () => {
  it("un passo (automazione + esecuzione) e una prova (solo automazione) si registrano; due owner no", async () => {
    const { projectId } = await seedRepository(t.db);
    const [a] = await t.db.insert(automations).values({ code: `C${randomUUID().slice(0, 5)}-A1`, seq: 1, name: "A", projectId }).returning();
    const [run] = await t.db.insert(automationRuns).values({ automationId: a!.id, n: 1, version: 1, title: "R", origin: "manual" }).returning();
    const row = { operation: "automation_step" as const, projectId, model: "claude-sonnet-4-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
    await t.db.insert(agentRuns).values({ ...row, automationId: a!.id, automationRunId: run!.id });
    await t.db.insert(agentRuns).values({ ...row, automationId: a!.id });
    // Due owner: il CHECK (valutato prima delle FK) lo rifiuta.
    await expectSqlState(t.db.insert(agentRuns).values({ ...row, automationId: a!.id, jobId: randomUUID(), phase: "fix" }), "23514");
  });

  it("review F3, M11: eliminare il progetto (a cascata automazione ed esecuzione) non rompe i CHECK: la riga di consumo resta, senza owner", async () => {
    const { projectId } = await seedRepository(t.db);
    const [a] = await t.db.insert(automations).values({ code: `D${randomUUID().slice(0, 5)}-A1`, seq: 1, name: "A", projectId }).returning();
    const [run] = await t.db.insert(automationRuns).values({ automationId: a!.id, n: 1, version: 1, title: "R", origin: "manual" }).returning();
    const [row] = await t.db.insert(agentRuns).values({ operation: "automation_step", projectId, model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, automationId: a!.id, automationRunId: run!.id }).returning();
    await t.db.delete(projects).where(eq(projects.id, projectId));
    const [after] = await t.db.select().from(agentRuns).where(eq(agentRuns.id, row!.id));
    expect(after).toMatchObject({ automationId: null, automationRunId: null });
  });
});

