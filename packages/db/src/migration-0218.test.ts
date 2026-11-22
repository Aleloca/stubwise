import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productComments, productPages, users } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0218 (22 nov 2026, area 11, registro dei rimandi): la chiave del client di un commento della doc. */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0218: la chiave del client di un commento", () => {
  it("una per autore: la stessa chiave due volte dallo stesso autore no, da un altro sì; senza chiave quante se ne vuole", async () => {
    const { projectId } = await seedRepository(t.db);
    const [page] = await t.db.insert(productPages).values({ projectId, title: "Phases", blocks: [] }).returning();
    const [ada, bea] = await t.db
      .insert(users)
      .values([
        { email: `${randomUUID()}@x.it`, passwordHash: "x", role: "member" },
        { email: `${randomUUID()}@x.it`, passwordHash: "x", role: "member" },
      ])
      .returning();
    const clientId = randomUUID();
    const base = { pageId: page!.id, anchorId: "blk", quote: "", body: "ciao" };
    await t.db.insert(productComments).values({ ...base, authorId: ada!.id, clientId });
    await expect(t.db.insert(productComments).values({ ...base, authorId: ada!.id, clientId })).rejects.toThrow();
    await t.db.insert(productComments).values({ ...base, authorId: bea!.id, clientId });
    await t.db.insert(productComments).values({ ...base, authorId: ada!.id });
    await t.db.insert(productComments).values({ ...base, authorId: ada!.id });
    const [row] = await t.db.insert(productComments).values({ ...base, authorId: ada!.id }).returning();
    expect(row!.clientId).toBeNull();
  });
});
