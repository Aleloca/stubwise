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

  it("area 8, «L'API per i siti»: la successiva è verificata SOLO se nasce con un token; da una verificata, senza token, non si continua (null)", async () => {
    const { projectId } = await seedRepository(t.db);
    const verified = await closed(projectId);
    await t.db.update(widgetConversations).set({ identityVerified: true }).where(eq(widgetConversations.id, verified.id));
    expect(await openConversationFor(t.db, verified.id)).toBeNull();
    const signedFromVerified = await openConversationFor(t.db, verified.id, { identityVerified: true });
    expect((await t.db.select().from(widgetConversations).where(eq(widgetConversations.id, signedFromVerified!)))[0]!.identityVerified).toBe(true);

    const other = await closed(projectId);
    const signed = await openConversationFor(t.db, other.id, { identityVerified: true });
    expect((await t.db.select().from(widgetConversations).where(eq(widgetConversations.id, signed!)))[0]!.identityVerified).toBe(true);
  });

  it("review finale: SENZA token la catena non entra MAI in una conversazione verificata (null), e non ne crea", async () => {
    const { projectId } = await seedRepository(t.db);
    const declared = await closed(projectId);
    const [verified] = await t.db.insert(widgetConversations).values({ projectId, externalUserId: declared.externalUserId, identityVerified: true }).returning();
    await t.db.update(widgetConversations).set({ continuedInId: verified!.id }).where(eq(widgetConversations.id, declared.id));
    expect(await openConversationFor(t.db, declared.id)).toBeNull();
    expect(await openConversationFor(t.db, declared.id, { identityVerified: true })).toBe(verified!.id);
    const rows = await t.db.select().from(widgetConversations).where(eq(widgetConversations.externalUserId, declared.externalUserId));
    expect(rows).toHaveLength(2);
  });

  it("review finale: un messaggio FIRMATO su una conversazione dichiarata aperta ne apre una verificata (le parole firmate non finiscono in una dichiarata)", async () => {
    const { projectId } = await seedRepository(t.db);
    const [open] = await t.db.insert(widgetConversations).values({ projectId, externalUserId: "anna" }).returning();
    const next = await openConversationFor(t.db, open!.id, { identityVerified: true });
    expect(next).not.toBe(open!.id);
    const [row] = await t.db.select().from(widgetConversations).where(eq(widgetConversations.id, next!));
    expect(row!.identityVerified).toBe(true);
    expect((await t.db.select().from(widgetConversations).where(eq(widgetConversations.id, open!.id)))[0]!.continuedInId).toBe(next);
    // Senza token la dichiarata aperta resta lei.
    const [plain] = await t.db.insert(widgetConversations).values({ projectId, externalUserId: "bruno" }).returning();
    expect(await openConversationFor(t.db, plain!.id)).toBe(plain!.id);
  });

  it("cinque chiamate INSIEME sulla stessa chiusa: una successiva sola", async () => {
    const { projectId } = await seedRepository(t.db);
    const c = await closed(projectId);
    // La corsa resa certa: il test tiene la riga chiusa mentre le chiamate
    // partono, così arrivano tutte prima che una abbia scritto la successiva.
    let calls: Promise<string | null>[] = [];
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
