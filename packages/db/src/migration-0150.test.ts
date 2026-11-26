import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0150 (area 6, decisione del maintainer del 12 nov 2026): con le
 * proposte spente una casella si legge comunque. L'indice del claim non
 * guarda più `proposals_enabled`; `proposals_since` è il taglio di quando le
 * proposte vengono riaccese.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0150 una casella si legge anche senza proposte", () => {
  it("l'indice del claim filtra solo le caselle vive", async () => {
    const [idx] = await t.db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where indexname = 'google_accounts_due_idx'`);
    expect(idx!.indexdef).toContain("disabled_at IS NULL");
    expect(idx!.indexdef).not.toContain("proposals_enabled");
  });

  it("proposals_since è null di default", async () => {
    const [col] = await t.db.execute<{ is_nullable: string; column_default: string | null }>(
      sql`select is_nullable, column_default from information_schema.columns where table_name = 'google_accounts' and column_name = 'proposals_since'`,
    );
    expect(col).toEqual({ is_nullable: "YES", column_default: null });
  });
});
