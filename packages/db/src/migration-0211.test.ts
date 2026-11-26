import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuns, aiModelSettings, productDocJobs } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0211 (20 nov 2026, area 11, F5): l'operazione AI del lavoro di
 * Claude sulla doc di prodotto e la sosta per la coda del progetto in pausa.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0211: product_doc_update e la sosta `paused`", () => {
  it("l'operazione è ammessa nei CHECK", async () => {
    await t.db.insert(agentRuns).values({ operation: "product_doc_update", model: "sonnet" } as never);
    await t.db.insert(aiModelSettings).values({ operation: "product_doc_update", model: "sonnet" } as never);
  });

  it("un lavoro si ferma `paused`; un motivo ignoto no", async () => {
    const { projectId } = await seedRepository(t.db);
    await t.db.insert(productDocJobs).values({ projectId, sourceKind: "decision", sourceId: crypto.randomUUID(), status: "held", heldReason: "paused" });
    await expect(t.db.execute(sql`insert into product_doc_jobs (project_id, source_kind, source_id, status, held_reason) values (${projectId}, 'decision', gen_random_uuid(), 'held', 'stanco')`)).rejects.toThrow();
  });
});
