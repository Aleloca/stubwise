import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentSessions, backlogItemRevisions, backlogItems, type Db } from "@stubwise/db";
import { seedBacklogItem, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  removeBacklogItemDesign,
  setBacklogItemDesign,
  setBacklogItemPlan,
  updateBacklogItemMetadata,
} from "./backlog-item-writes.js";

let testDb: TestDb;
let db: Db;
beforeAll(async () => { testDb = await startTestDb(); db = testDb.db; });
afterAll(async () => { await testDb.stop(); });

const itemOf = async (id: string) => (await db.select().from(backlogItems).where(eq(backlogItems.id, id)))[0]!;
const revisionsOf = (id: string) => db.select().from(backlogItemRevisions).where(eq(backlogItemRevisions.itemId, id));
async function agentSession(itemId: string) {
  const [s] = await db.insert(agentSessions)
    .values({ ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId }).returning();
  return s!.id;
}

describe("design", () => {
  it("il primo design preserva il testo originale UNA volta sola", async () => {
    const { itemId } = await seedBacklogItem(db);
    await db.update(backlogItems).set({ document: "originale" }).where(eq(backlogItems.id, itemId));
    expect(await setBacklogItemDesign(db, itemId, "design 1")).toBe("ok");
    expect(await setBacklogItemDesign(db, itemId, "design 2")).toBe("ok");
    const item = await itemOf(itemId);
    expect([item.document, item.originContent]).toEqual(["design 2", "originale"]);
  });

  it("rimozione: ripristina l'origine; senza design attivo è no_design", async () => {
    const { itemId } = await seedBacklogItem(db);
    await db.update(backlogItems).set({ document: "originale" }).where(eq(backlogItems.id, itemId));
    expect(await removeBacklogItemDesign(db, itemId)).toBe("no_design");
    await setBacklogItemDesign(db, itemId, "design");
    expect(await removeBacklogItemDesign(db, itemId)).toBe("ok");
    const item = await itemOf(itemId);
    expect([item.document, item.originContent]).toEqual(["originale", null]);
  });

  it("con revision: salva {document, originContent} PRECEDENTI nella stessa transazione", async () => {
    const { itemId } = await seedBacklogItem(db);
    await db.update(backlogItems).set({ document: "originale" }).where(eq(backlogItems.id, itemId));
    const agentSessionId = await agentSession(itemId);
    await setBacklogItemDesign(db, itemId, "design", { agentSessionId });
    const [rev] = await revisionsOf(itemId);
    expect(rev).toMatchObject({ field: "document", agentSessionId, previous: { document: "originale", originContent: null } });
  });

  it("senza revision (le rotte): nessuna riga di revisione", async () => {
    const { itemId } = await seedBacklogItem(db);
    await setBacklogItemDesign(db, itemId, "design");
    expect(await revisionsOf(itemId)).toHaveLength(0);
  });

  it("voce inesistente: not_found, niente scritto", async () => {
    expect(await setBacklogItemDesign(db, "7f1c2a1e-0000-4000-8000-0000000000ff", "x")).toBe("not_found");
  });
});

describe("piano", () => {
  it("sostituisce, null azzera, revision col piano precedente", async () => {
    const { itemId } = await seedBacklogItem(db);
    const agentSessionId = await agentSession(itemId);
    await setBacklogItemPlan(db, itemId, "piano 1");
    await setBacklogItemPlan(db, itemId, "piano 2", { agentSessionId });
    expect((await itemOf(itemId)).implementationPlan).toBe("piano 2");
    expect((await revisionsOf(itemId))[0]).toMatchObject({ field: "implementation_plan", previous: { implementationPlan: "piano 1" } });
    await setBacklogItemPlan(db, itemId, null);
    expect((await itemOf(itemId)).implementationPlan).toBeNull();
  });
});

describe("metadati", () => {
  it("aggiorna i soli campi definiti e toglie da suggested quelli decisi", async () => {
    const { itemId } = await seedBacklogItem(db);
    await db.update(backlogItems)
      .set({ suggested: { effort: 3, risk: "high", reason: "perché" } })
      .where(eq(backlogItems.id, itemId));
    await updateBacklogItemMetadata(db, itemId, { effort: 2 });
    const item = await itemOf(itemId);
    expect(item.effort).toBe(2);
    expect(item.suggested).toEqual({ risk: "high", reason: "perché" });
    await updateBacklogItemMetadata(db, itemId, { risk: "low" });
    expect((await itemOf(itemId)).suggested).toBeNull(); // il solo reason non lo tiene vivo
  });

  it("revision: i SOLI campi cambiati, coi valori precedenti", async () => {
    const { itemId } = await seedBacklogItem(db, { title: "Prima" });
    const agentSessionId = await agentSession(itemId);
    await updateBacklogItemMetadata(db, itemId, { title: "Dopo", urgency: "high" }, { revision: { agentSessionId } });
    expect((await revisionsOf(itemId))[0]).toMatchObject({ field: "metadata", previous: { title: "Prima", urgency: null } });
  });

  it("status archived chiama onArchive dentro la transazione", async () => {
    const { itemId } = await seedBacklogItem(db);
    let called = 0;
    await updateBacklogItemMetadata(db, itemId, {}, { status: "archived", onArchive: async () => { called++; } });
    expect(called).toBe(1);
    expect((await itemOf(itemId)).status).toBe("archived");
  });
});
