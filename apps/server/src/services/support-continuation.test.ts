import { randomUUID } from "node:crypto";
import { backlogItems, widgetConversations } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openConversationFor } from "./support-continuation.js";

/**
 * Area 8, F3, S17: la successiva di una conversazione chiusa, sotto il lock
 * della riga chiusa. Le chiamate partono INSIEME dal pool (ognuna nella sua
 * transazione): senza il lock ognuna aprirebbe la sua successiva.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function closed(projectId: string) {
  const [c] = await t.db.insert(widgetConversations).values({ projectId, externalUserId: randomUUID() }).returning();
  await t.db.insert(backlogItems).values({ projectId, title: "R", source: "manual", supportConversationId: c!.id });
  return c!;
}

describe("openConversationFor", () => {
  it("una aperta resta lei; una chiusa dà la successiva", async () => {
    const { projectId } = await seedRepository(t.db);
    const [open] = await t.db.insert(widgetConversations).values({ projectId, externalUserId: "u" }).returning();
    expect(await openConversationFor(t.db, open!.id)).toBe(open!.id);
    const c = await closed(projectId);
    const next = await openConversationFor(t.db, c.id);
    expect(next).not.toBe(c.id);
    expect(await openConversationFor(t.db, c.id)).toBe(next);
  });

  it("cinque chiamate INSIEME sulla stessa chiusa: una successiva sola", async () => {
    const { projectId } = await seedRepository(t.db);
    const c = await closed(projectId);
    // La corsa resa certa: il test tiene la riga chiusa mentre le chiamate
    // partono, così arrivano tutte prima che una abbia scritto la successiva.
    let calls: Promise<string>[] = [];
    await t.db.transaction(async (tx) => {
      await tx.select().from(widgetConversations).where(eq(widgetConversations.id, c.id)).for("update");
      calls = Array.from({ length: 5 }, () => openConversationFor(t.db, c.id));
      await new Promise((r) => setTimeout(r, 500));
    });
    const ids = await Promise.all(calls);
    expect(new Set(ids).size).toBe(1);
    const all = await t.db.select().from(widgetConversations).where(eq(widgetConversations.projectId, projectId));
    expect(all).toHaveLength(2);
  });
});
