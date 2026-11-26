import { agentRuns, instanceSettings } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiBudgetState, monthlyBudgetLimitUsd } from "./ai-budget.js";

/** Il budget mensile in UN posto (area 7, F3, C-F3-1). */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(agentRuns);
  await t.db.delete(instanceSettings);
});

const budget = (usd: string | null) =>
  t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: usd }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: usd } });
const spend = (usd: string, monthsAgo = 0) =>
  t.db.insert(agentRuns).values({ operation: "chat", projectId: null, model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: usd, createdAt: sql`now() - make_interval(months => ${monthsAgo})` });

describe("aiBudgetState", () => {
  it("senza limite non è mai esaurito (e non legge la spesa)", async () => {
    await spend("1000");
    let read = false;
    expect(await aiBudgetState(t.db, async () => ((read = true), 0))).toEqual({ exhausted: false, limitUsd: null, spentUsd: 0 });
    expect(read).toBe(false);
    expect(await monthlyBudgetLimitUsd(t.db)).toBeNull();
  });

  it("col limite: la spesa del MESE (non quella dei mesi prima) lo raggiunge o no", async () => {
    await budget("10");
    await spend("6");
    await spend("50", 2);
    expect(await aiBudgetState(t.db)).toEqual({ exhausted: false, limitUsd: 10, spentUsd: 6 });
    await spend("4");
    expect(await aiBudgetState(t.db)).toEqual({ exhausted: true, limitUsd: 10, spentUsd: 10 });
  });
});
