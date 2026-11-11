import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backlogItems } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0148 (12 nov 2026, review della F3, decisione del maintainer):
 * una richiesta nata da FUORI (un'email in entrata) lo ricorda, perché leggerla
 * nella chat con Claude conta come contenuto non fidato.
 */

let t: TestDb;
let projectId: string;
beforeAll(async () => {
  t = await startTestDb();
  ({ projectId } = await seedRepository(t.db));
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0148 l'origine esterna di una richiesta", () => {
  it("null di default; `email` ammesso; un altro valore no", async () => {
    const [plain] = await t.db.insert(backlogItems).values({ projectId, title: "x", body: "y", source: "manual" } as typeof backlogItems.$inferInsert).returning();
    expect(plain!.externalOrigin).toBeNull();
    const [mail] = await t.db.insert(backlogItems).values({ projectId, title: "x2", body: "y", source: "manual", externalOrigin: "email" } as typeof backlogItems.$inferInsert).returning();
    expect(mail!.externalOrigin).toBe("email");
    await expect(t.db.execute(sql`update backlog_items set external_origin = 'boh' where id = ${plain!.id}`)).rejects.toThrow();
  });
});
