import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0146 (11 nov 2026, area 5, fetta 3): dopo una lettura di
 * contenuto NON fidato (un file del Drive, una pagina Docs) ogni proposta è
 * almeno B. La conversazione ricorda la lettura, la proposta il fatto.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0146 il contenuto non fidato nel turno", () => {
  it("la conversazione ha `untrusted_read_at` (null di default), la proposta `untrusted_input` (false di default, non nullo)", async () => {
    const cols = await t.db.execute<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(sql`
      select table_name, column_name, is_nullable, column_default from information_schema.columns
      where (table_name, column_name) in (('claude_conversations', 'untrusted_read_at'), ('claude_proposals', 'untrusted_input'))
      order by table_name`);
    expect(cols.map((c) => [c.table_name, c.column_name, c.is_nullable, c.column_default])).toEqual([
      ["claude_conversations", "untrusted_read_at", "YES", null],
      ["claude_proposals", "untrusted_input", "NO", "false"],
    ]);
  });
});
