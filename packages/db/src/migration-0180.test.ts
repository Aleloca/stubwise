import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roles, serverEpisodes, servers } from "./schema.js";
import { expectSqlState, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0180 (14 nov 2026, area 8, fetta 4a): il codice dei server
 * (`SRV-<n>`, d'istanza, mai riusato), gli episodi, `monitor.view` fuori dal
 * SOLO preset `User`.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const server = async (name: string, number?: number) =>
  (await t.db.insert(servers).values({ name, keyHash: `h-${Math.random()}`, ...(number !== undefined ? { number } : {}) }).returning())[0]!;

describe("0180", () => {
  it("ogni server nuovo prende il numero dopo, mai riusato; unico", async () => {
    const a = await server("a");
    const b = await server("b");
    expect(b.number).toBe(a.number + 1);
    await t.db.delete(servers).where(eq(servers.id, b.id));
    const c = await server("c");
    expect(c.number).toBe(b.number + 1);
    await expectSqlState(t.db.update(servers).set({ number: a.number }).where(eq(servers.id, c.id)), "23505");
  });

  it("un episodio aperto per server; la gravità solo trouble/down; via col server", async () => {
    const s = await server("e");
    await t.db.insert(serverEpisodes).values({ serverId: s.id, severity: "trouble", reasons: [{ kind: "cpu", valuePct: 97 }] });
    await expectSqlState(t.db.insert(serverEpisodes).values({ serverId: s.id, severity: "down" }), "23505");
    await t.db.update(serverEpisodes).set({ recoveredAt: new Date() }).where(eq(serverEpisodes.serverId, s.id));
    await t.db.insert(serverEpisodes).values({ serverId: s.id, severity: "down" });
    await expectSqlState(t.db.insert(serverEpisodes).values({ serverId: s.id, severity: "forse" as never, recoveredAt: new Date() }), "23514");
    await t.db.delete(servers).where(eq(servers.id, s.id));
    expect(await t.db.select().from(serverEpisodes).where(eq(serverEpisodes.serverId, s.id))).toEqual([]);
  });

  it("il preset User non ha più monitor.view; Admin e i ruoli personalizzati non si toccano", async () => {
    const [user] = await t.db.select({ permissions: roles.permissions }).from(roles).where(eq(roles.presetKey, "user"));
    expect(user!.permissions).not.toContain("monitor.view");
    expect(user!.permissions).toContain("users.view_all");
    // Un ruolo personalizzato con monitor.view, creato «prima»: rilanciare lo statement della 0180 non lo tocca.
    const [custom] = await t.db
      .insert(roles)
      .values({ name: `custom-${Math.random()}`, scope: "instance", permissions: [...user!.permissions, "monitor.view"] })
      .returning();
    await t.db.execute(sql`UPDATE "roles" SET "permissions" = array_remove("permissions", 'monitor.view') WHERE "preset_key" = 'user'`);
    const [after] = await t.db.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, custom!.id));
    expect(after!.permissions).toContain("monitor.view");
    const rows = await t.db.select({ n: servers.number }).from(servers).orderBy(asc(servers.number));
    expect(rows.length).toBeGreaterThan(0);
  });
});
