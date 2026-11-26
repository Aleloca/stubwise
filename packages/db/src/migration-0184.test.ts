import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { widgetConversations, widgets } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0184 (16 nov 2026, area 8, «L'API per i siti»): il segreto
 * d'identità del widget e la conversazione verificata. Tutto con default:
 * i widget e le conversazioni di prima restano come erano.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0184: l'identità dei clienti del widget", () => {
  it("un widget nasce senza segreto e senza l'obbligo; una conversazione nasce dichiarata", async () => {
    const { projectId } = await seedRepository(t.db);
    const [w] = await t.db.insert(widgets).values({ projectId, name: "Sito", key: `k-${randomUUID()}` }).returning();
    expect(w).toMatchObject({ identitySecretEncrypted: null, identitySecretRotatedAt: null, identityRequired: false });
    const [c] = await t.db.insert(widgetConversations).values({ projectId, widgetId: w!.id, externalUserId: "u1" }).returning();
    expect(c!.identityVerified).toBe(false);
    await t.db.update(widgetConversations).set({ identityVerified: true }).where(eq(widgetConversations.id, c!.id));
    const [after] = await t.db.select().from(widgetConversations).where(eq(widgetConversations.id, c!.id));
    expect(after!.identityVerified).toBe(true);
  });
});
