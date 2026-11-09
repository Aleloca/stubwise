import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backlogItems, projects } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0121 (10 nov 2026, integrazione area 2, fetta 4): il numero di
 * catalogo delle richieste, `<PROGETTO>-R<n>`. Un contatore per progetto
 * (`projects.next_request_number`), dato dal trigger a OGNI voce nuova (anche
 * a quelle dell'intake del worker), mai riusato; le voci di prima numerate
 * per data di creazione, fuse e archiviate comprese — gli stessi numeri che
 * `/api/requests/to-convert` ricavava prima.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function item(projectId: string, status: "new" | "archived" = "new") {
  const [row] = await t.db
    .insert(backlogItems)
    .values({ projectId, title: "R", source: "manual", status })
    .returning({ id: backlogItems.id, number: backlogItems.number });
  return row!;
}

describe("0121 numeri delle richieste", () => {
  it("ogni voce nuova prende il numero dopo, per progetto; anche archiviate; mai riusato", async () => {
    const { projectId } = await seedRepository(t.db);
    const { projectId: other } = await seedRepository(t.db);
    const a = await item(projectId);
    const b = await item(projectId, "archived");
    const x = await item(other);
    expect([a.number, b.number, x.number]).toEqual([1, 2, 1]);
    await t.db.delete(backlogItems).where(eq(backlogItems.id, b.id));
    const c = await item(projectId);
    expect(c.number).toBe(3);
    const [p] = await t.db.select({ next: projects.nextRequestNumber }).from(projects).where(eq(projects.id, projectId));
    expect(p!.next).toBe(4);
  });

  it("un numero è unico nel progetto", async () => {
    const { projectId } = await seedRepository(t.db);
    const a = await item(projectId);
    await expect(t.db.insert(backlogItems).values({ projectId, title: "dup", source: "manual", number: a.number })).rejects.toThrow();
  });

  it("una voce che cambia progetto prende il numero dopo nel nuovo", async () => {
    const { projectId } = await seedRepository(t.db);
    const { projectId: dest } = await seedRepository(t.db);
    await item(dest);
    const moving = await item(projectId);
    const [moved] = await t.db
      .update(backlogItems)
      .set({ projectId: dest })
      .where(eq(backlogItems.id, moving.id))
      .returning({ number: backlogItems.number });
    expect(moved!.number).toBe(2);
    const rows = await t.db.select({ n: backlogItems.number }).from(backlogItems).where(eq(backlogItems.projectId, dest)).orderBy(asc(backlogItems.number));
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
  });
});
