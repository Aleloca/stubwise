import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { departmentHomes, departmentRoles, departments, personalHomeSeen, personalHomes, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0117 (9 nov 2026, integrazione area 2, fetta 3): la Home a
 * blocchi — quella di ogni reparto, la personale, le viste delle Home di
 * reparto — e i ruoli di reparto (`department.home.manage`).
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

describe("0117 Home e ruoli di reparto", () => {
  it("ogni reparto esistente ha la Home d'apertura con i blocchi dell'area 2", async () => {
    const [general] = await t.db.select().from(departments).where(eq(departments.isDefault, true));
    const [home] = await t.db.select().from(departmentHomes).where(eq(departmentHomes.departmentId, general!.id));
    expect(home!.blocks).toEqual([
      { kind: "decide" },
      { kind: "myWeek" },
      { kind: "myTasks" },
      { kind: "claudeForMe" },
      { kind: "stalledInMyProjects" },
    ]);
    expect(home!.updatedById).toBeNull();
  });

  it("ruoli di reparto: una riga per persona e reparto; vanno via col reparto e con la persona", async () => {
    const u = await user();
    const [d] = await t.db.insert(departments).values({ name: `R-${randomUUID()}`, colorToken: "--dept-1" }).returning();
    await t.db.insert(departmentRoles).values({ departmentId: d!.id, userId: u, permissions: ["department.home.manage"] });
    await expect(
      t.db.insert(departmentRoles).values({ departmentId: d!.id, userId: u, permissions: [] }),
    ).rejects.toThrow();
    await t.db.insert(departmentHomes).values({ departmentId: d!.id, blocks: [{ kind: "myTasks" }], updatedById: u });
    await t.db.delete(users).where(eq(users.id, u));
    expect(await t.db.select().from(departmentRoles).where(eq(departmentRoles.departmentId, d!.id))).toHaveLength(0);
    // Chi ha scritto la Home se ne va: la Home resta, senza autore.
    const [home] = await t.db.select().from(departmentHomes).where(eq(departmentHomes.departmentId, d!.id));
    expect(home!.updatedById).toBeNull();
    await t.db.delete(departments).where(eq(departments.id, d!.id));
    expect(await t.db.select().from(departmentHomes).where(eq(departmentHomes.departmentId, d!.id))).toHaveLength(0);
  });

  it("Home personale e viste: una per persona, una vista per reparto, in cascata", async () => {
    const u = await user();
    const [d] = await t.db.insert(departments).values({ name: `V-${randomUUID()}`, colorToken: "--dept-2" }).returning();
    await t.db.insert(personalHomes).values({ userId: u, blocks: [{ kind: "decide" }] });
    await expect(t.db.insert(personalHomes).values({ userId: u, blocks: [] })).rejects.toThrow();
    await t.db.insert(personalHomeSeen).values({ userId: u, departmentId: d!.id, seenAt: new Date() });
    await expect(
      t.db.insert(personalHomeSeen).values({ userId: u, departmentId: d!.id, seenAt: new Date() }),
    ).rejects.toThrow();
    await t.db.delete(departments).where(eq(departments.id, d!.id));
    expect(await t.db.select().from(personalHomeSeen).where(eq(personalHomeSeen.userId, u))).toHaveLength(0);
    await t.db.delete(users).where(eq(users.id, u));
    expect(await t.db.select().from(personalHomes).where(eq(personalHomes.userId, u))).toHaveLength(0);
  });
});
