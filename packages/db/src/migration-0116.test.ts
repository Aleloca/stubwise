import { randomUUID } from "node:crypto";
import { asc, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pinnedTaskFilters, taskFilters, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0116 (9 nov 2026, integrazione area 2, fetta 3): i filtri
 * salvati dell'app nuova in una tabella NUOVA (`saved_views` del web vecchio
 * resta intatta), i fissati per persona, e i cinque filtri pubblici di
 * esempio del prototipo, di nessuno.
 */

let t: TestDb;

beforeAll(async () => {
  t = await startTestDb();
}, 120_000);

afterAll(async () => {
  await t?.stop();
});

async function user(): Promise<string> {
  const [u] = await t.db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, passwordHash: "h", role: "member" })
    .returning({ id: users.id });
  return u!.id;
}

const base = { visibility: "private" as const, criteria: {}, view: "list" as const, groupBy: "none" as const };

describe("0116 filtri salvati", () => {
  it("i cinque filtri di esempio: pubblici, di nessuno, coi criteri del prototipo", async () => {
    const rows = await t.db
      .select()
      .from(taskFilters)
      .where(isNotNull(taskFilters.seedKey))
      .orderBy(asc(taskFilters.seedKey));
    expect(
      rows.map((r) => [r.seedKey, r.name, r.ownerId, r.visibility, r.criteria, r.view, r.groupBy]),
    ).toEqual([
      ["closed-month", "Closed this month", null, "public", { families: ["closed"], period: { field: "closed", kind: "relative", preset: "thisMonth" } }, "list", "none"],
      ["no-estimate", "No estimate", null, "public", { families: ["todo", "active"], sizes: ["none"] }, "list", "none"],
      ["open", "Open", null, "public", { families: ["todo", "active"] }, "list", "status"],
      ["stalled", "Stalled", null, "public", { stalled: true }, "list", "assignee"],
      ["unassigned", "Unassigned", null, "public", { families: ["todo", "active"], assigneeIds: ["none"] }, "board", "status"],
    ]);
  });

  it("nome 1..80, visibilità, vista e raggruppamento noti; un seed_key una volta sola", async () => {
    const ownerId = await user();
    await expect(t.db.insert(taskFilters).values({ ...base, ownerId, name: "" })).rejects.toThrow();
    await expect(t.db.insert(taskFilters).values({ ...base, ownerId, name: "x".repeat(81) })).rejects.toThrow();
    await expect(
      t.db.insert(taskFilters).values({ ...base, ownerId, name: "A", visibility: "team" as never }),
    ).rejects.toThrow();
    await expect(t.db.insert(taskFilters).values({ ...base, ownerId, name: "A", view: "grid" as never })).rejects.toThrow();
    await expect(
      t.db.insert(taskFilters).values({ ...base, ownerId, name: "A", groupBy: "boh" as never }),
    ).rejects.toThrow();
    await expect(t.db.insert(taskFilters).values({ ...base, name: "A", seedKey: "open" })).rejects.toThrow();
  });

  it("eliminare un filtro lo toglie dai fissati di tutti; eliminare l'autore lascia il filtro senza autore", async () => {
    const a = await user();
    const b = await user();
    const [f] = await t.db
      .insert(taskFilters)
      .values({ ...base, ownerId: a, name: "Mio", visibility: "public" })
      .returning({ id: taskFilters.id });
    await t.db.insert(pinnedTaskFilters).values([
      { userId: a, filterId: f!.id, position: 0 },
      { userId: b, filterId: f!.id, position: 0 },
    ]);
    // Un filtro fissato due volte dalla stessa persona: no.
    await expect(t.db.insert(pinnedTaskFilters).values({ userId: b, filterId: f!.id, position: 1 })).rejects.toThrow();
    await t.db.delete(users).where(eq(users.id, a));
    const [after] = await t.db.select().from(taskFilters).where(eq(taskFilters.id, f!.id));
    expect(after!.ownerId).toBeNull();
    // I fissati di chi è stato eliminato se ne vanno con lui.
    expect(await t.db.select().from(pinnedTaskFilters).where(eq(pinnedTaskFilters.filterId, f!.id))).toHaveLength(1);
    await t.db.delete(taskFilters).where(eq(taskFilters.id, f!.id));
    expect(await t.db.select().from(pinnedTaskFilters).where(eq(pinnedTaskFilters.userId, b))).toHaveLength(0);
  });
});
