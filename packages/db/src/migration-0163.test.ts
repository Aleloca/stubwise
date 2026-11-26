import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0163 (review F3b): l'indice della potatura del calendario, sulla fine dell'evento. */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0163", () => {
  it("c'è l'indice su coalesce(ends_at, starts_at)", async () => {
    const rows = await t.db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where indexname = 'calendar_events_ends_idx'`);
    expect(rows[0]?.indexdef).toMatch(/COALESCE\(ends_at, starts_at\)/);
  });
});
