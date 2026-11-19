import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { departmentProjectPermissions, departments, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0196 (19 nov 2026, area 9, F8, F8-1 = a): i permessi di progetto
 * di un reparto, una lista per reparto (niente `project_id`).
 */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0196", () => {
  it("una riga per permesso; il reparto eliminato se le porta via; chi l'ha dato va a null", async () => {
    const [d] = await t.db.insert(departments).values({ name: `D ${randomUUID().slice(0, 6)}`, colorToken: "--dept-1" }).returning();
    const [u] = await t.db.insert(users).values({ email: `g-${randomUUID().slice(0, 6)}@x.test`, passwordHash: "x", role: "member" }).returning();
    await t.db.insert(departmentProjectPermissions).values({ departmentId: d!.id, permission: "plans.approve", grantedByUserId: u!.id });
    await expect(t.db.insert(departmentProjectPermissions).values({ departmentId: d!.id, permission: "plans.approve" })).rejects.toThrow();
    await t.db.delete(users).where(eq(users.id, u!.id));
    expect((await t.db.select().from(departmentProjectPermissions).where(eq(departmentProjectPermissions.departmentId, d!.id)))[0]!.grantedByUserId).toBeNull();
    await t.db.delete(departments).where(eq(departments.id, d!.id));
    expect(await t.db.select().from(departmentProjectPermissions).where(eq(departmentProjectPermissions.departmentId, d!.id))).toEqual([]);
  });

  it("il migratore ha applicato 0195 e 0196 in fila, e TUTTO il journal nel suo ordine", async () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0195_change_log_via_claude");
    expect(tags.slice(i, i + 2)).toEqual(["0195_change_log_via_claude", "0196_department_project_permissions"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
    const applied = (await t.db.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at`)) as unknown as { rows?: { created_at: string }[] } & { created_at: string }[];
    expect(((applied.rows ?? applied) as { created_at: string }[]).map((r) => Number(r.created_at))).toEqual(whens);
  });
});
