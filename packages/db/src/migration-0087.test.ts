import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { seedBacklogItem, startTestDb, type TestDb } from "./testing.js";
import { agentSessions, backlogItemRevisions, backlogItems, backlogRefineSessions } from "./schema.js";

async function failureMessage(p: PromiseLike<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as { cause?: { message?: string } }).cause?.message ?? String(e); }
  return "";
}

let t: TestDb;
beforeAll(async () => { t = await startTestDb(); }, 120_000);
afterAll(async () => t.stop());

async function refineSession(itemId: string) {
  const [s] = await t.db.insert(agentSessions)
    .values({ ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId })
    .returning();
  const [r] = await t.db.insert(backlogRefineSessions)
    .values({ itemId, agentSessionId: s!.id }).returning();
  return { agentSessionId: s!.id, row: r! };
}

describe("0087 backlog_refine_sessions", () => {
  it("il kind backlog_refine passa il CHECK allargato", async () => {
    const { itemId } = await seedBacklogItem(t.db);
    const { row } = await refineSession(itemId);
    expect(row.status).toBe("active");
    expect(row.closedAt).toBeNull();
  });

  it("una sola sessione per voce", async () => {
    const { itemId } = await seedBacklogItem(t.db);
    await refineSession(itemId);
    expect(await failureMessage(refineSession(itemId))).toMatch(/unique|duplicate/i);
  });

  it("CHECK di coerenza: chiusa vuole closed_at e closed_reason, attiva nessuno dei due", async () => {
    const { itemId } = await seedBacklogItem(t.db);
    const { row } = await refineSession(itemId);
    expect(await failureMessage(
      t.db.update(backlogRefineSessions).set({ status: "closed" }).where(eq(backlogRefineSessions.id, row.id)),
    )).toMatch(/backlog_refine_sessions_closed_chk/);
    expect(await failureMessage(
      t.db.update(backlogRefineSessions).set({ closedReason: "nope" as never, status: "closed", closedAt: new Date() })
        .where(eq(backlogRefineSessions.id, row.id)),
    )).toMatch(/backlog_refine_sessions_closed_reason_chk/);
  });

  it("cancellare la voce cancella sessione di refinement e revisioni; la sessione dell'agente porta via la riga", async () => {
    const { itemId } = await seedBacklogItem(t.db);
    const { agentSessionId } = await refineSession(itemId);
    await t.db.insert(backlogItemRevisions).values({ itemId, field: "document", previous: { document: "x" }, agentSessionId });
    await t.db.delete(agentSessions).where(eq(agentSessions.id, agentSessionId));
    expect(await t.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.itemId, itemId))).toHaveLength(0);
    const [rev] = await t.db.select().from(backlogItemRevisions).where(eq(backlogItemRevisions.itemId, itemId));
    expect(rev!.agentSessionId).toBeNull(); // SET NULL: la revisione sopravvive alla potatura della sessione
    await t.db.delete(backlogItems).where(eq(backlogItems.id, itemId));
    expect(await t.db.select().from(backlogItemRevisions).where(eq(backlogItemRevisions.itemId, itemId))).toHaveLength(0);
  });

  it("revisioni: CHECK su field", async () => {
    const { itemId } = await seedBacklogItem(t.db);
    expect(await failureMessage(
      t.db.insert(backlogItemRevisions).values({ itemId, field: "title" as never, previous: {} }),
    )).toMatch(/backlog_item_revisions_field_chk/);
  });
});
