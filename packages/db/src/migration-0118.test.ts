import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projects } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0118 (9 nov 2026, integrazione area 2, fetta 4): modello, moduli
 * e cliente di un progetto. Chi non li dice è Software con tutti e quattro i
 * moduli, interno (la decisione del maintainer per i progetti esistenti).
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0118 modello, moduli, cliente", () => {
  it("un progetto che non li dice: software, i quattro moduli, nessun cliente", async () => {
    const { projectId } = await seedRepository(t.db);
    const [p] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(p).toMatchObject({ template: "software", modules: ["docs", "releases", "support", "servers"], clientName: null });
  });

  it("modello e moduli sconosciuti, cliente vuoto: rifiutati dal DB", async () => {
    const { projectId } = await seedRepository(t.db);
    const set = (v: Record<string, unknown>) => t.db.update(projects).set(v).where(eq(projects.id, projectId));
    await expect(set({ template: "boh" })).rejects.toThrow();
    await expect(set({ modules: ["docs", "chat"] })).rejects.toThrow();
    await expect(set({ clientName: "  " })).rejects.toThrow();
    await set({ template: "client", modules: [], clientName: "Acme" });
    const [p] = await t.db.select().from(projects).where(eq(projects.id, projectId));
    expect(p).toMatchObject({ template: "client", modules: [], clientName: "Acme" });
  });
});
