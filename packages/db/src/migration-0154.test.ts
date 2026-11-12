import { AI_OPERATIONS } from "@stubwise/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiModelSettings } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0154 (12 nov 2026, area 6, F3, task 6): l'operazione AI
 * `mail_draft` (la bozza di Claude nella Posta) nei due CHECK derivati da
 * `AI_OPERATIONS`.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0154", () => {
  it("`mail_draft` passa i CHECK di agent_runs e ai_model_settings, e i CHECK elencano TUTTO il catalogo", async () => {
    const defs = await t.db.execute<{ def: string }>(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname in ('agent_runs_operation_chk', 'ai_model_settings_operation_chk')`,
    );
    expect(defs).toHaveLength(2);
    for (const d of defs) for (const op of AI_OPERATIONS) expect(d.def).toContain(`'${op}'`);
    await t.db.insert(aiModelSettings).values({ operation: "mail_draft", model: "sonnet" });
  });
});
