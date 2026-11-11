import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storageOrphans } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0144 (11 nov 2026, review della fetta 2 dell'area 5): gli oggetti
 * dello storage rimasti senza riga (un caricamento interrotto, un insert
 * fallito) e che lo storage non ha tolto subito. La pulizia oraria li ritenta.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0144 gli orfani dello storage", () => {
  it("una chiave sola volta (un secondo tentativo non duplica), con la data e il motivo", async () => {
    await t.db.insert(storageOrphans).values({ storageKey: "drive/p/1/a.pdf", reason: "upload_failed" });
    await t.db.insert(storageOrphans).values({ storageKey: "drive/p/1/a.pdf", reason: "upload_failed" }).onConflictDoNothing();
    const rows = await t.db.select().from(storageOrphans);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
    await expect(t.db.execute(sql`insert into storage_orphans (storage_key, reason) values ('k', '')`)).rejects.toThrow();
  });
});
