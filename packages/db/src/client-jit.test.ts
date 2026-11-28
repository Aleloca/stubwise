import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./testing.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);
afterAll(async () => {
  await testDb.stop();
});

it("I1: le connessioni dell'app hanno il JIT di Postgres spento (createDb)", async () => {
  // Più di una lettura: il pool apre connessioni diverse, e vale per ognuna.
  const rows = await Promise.all([1, 2, 3].map(() => testDb.db.execute<{ jit: string }>(sql`show jit`)));
  expect(rows.map((r) => r[0]!.jit)).toEqual(["off", "off", "off"]);
});
