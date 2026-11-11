import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0147 (12 nov 2026, review della F3): un indice parziale per la
 * semina della coda del contenuto (`content_status = 'pending'` sui file vivi),
 * che il worker interroga a ogni giro.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0147 l'indice dei file in attesa del contenuto", () => {
  it("esiste, parziale sui file vivi in `pending`", async () => {
    const [idx] = await t.db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where indexname = 'drive_files_content_pending_idx'`);
    expect(idx?.indexdef).toMatch(/WHERE \(\(content_status = 'pending'::text\) AND \(deleted_at IS NULL\)\)/);
  });
});
