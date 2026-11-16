import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailChanges, projectMemberPermissions, projectMembers, roles, sessions, userAvatars, users } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0185 (16 nov 2026, area 9, F1): i permessi personali dei membri,
 * la disattivazione, le sessioni, la foto, il cambio dell'email. Tutto
 * additivo: le righe di prima restano come erano.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function person(): Promise<string> {
  const [u] = await t.db.insert(users).values({ email: `${randomUUID()}@acme.com`, passwordHash: "h", role: "member" }).returning({ id: users.id });
  return u!.id;
}
async function member(projectId: string, userId: string) {
  const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
  await t.db.insert(projectMembers).values({ projectId, userId, roleId: role!.id });
}

describe("0185: gli accessi dell'area 9", () => {
  it("una persona nasce attiva, una sessione senza user agent né ultimo uso", async () => {
    const id = await person();
    const [u] = await t.db.select().from(users).where(eq(users.id, id));
    expect(u).toMatchObject({ deactivatedAt: null, deactivatedByUserId: null });
    await t.db.insert(sessions).values({ id: randomUUID(), userId: id, expiresAt: new Date(Date.now() + 3_600_000) });
    const [s] = await t.db.select().from(sessions).where(eq(sessions.userId, id));
    expect(s).toMatchObject({ userAgent: null, lastSeenAt: null });
  });

  it("i permessi personali stanno solo su un membro, e cadono col membro", async () => {
    const { projectId } = await seedRepository(t.db);
    const id = await person();
    await expect(t.db.insert(projectMemberPermissions).values({ projectId, userId: id, permission: "release.merge" })).rejects.toThrow();
    await member(projectId, id);
    await t.db.insert(projectMemberPermissions).values({ projectId, userId: id, permission: "release.merge" });
    await expect(t.db.insert(projectMemberPermissions).values({ projectId, userId: id, permission: "release.merge" })).rejects.toThrow();
    await t.db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, id)));
    expect(await t.db.select().from(projectMemberPermissions).where(eq(projectMemberPermissions.userId, id))).toEqual([]);
  });

  it("la foto: solo PNG, JPEG o WebP, al più 512 KB", async () => {
    const id = await person();
    await t.db.insert(userAvatars).values({ userId: id, contentType: "image/png", bytes: Buffer.alloc(524_288, 1) });
    const [a] = await t.db.select().from(userAvatars).where(eq(userAvatars.userId, id));
    expect(Buffer.isBuffer(a!.bytes)).toBe(true);
    expect(a!.bytes.length).toBe(524_288);
    const other = await person();
    await expect(t.db.insert(userAvatars).values({ userId: other, contentType: "image/png", bytes: Buffer.alloc(524_289, 1) })).rejects.toThrow();
    await expect(t.db.execute(sql`insert into user_avatars (user_id, content_type, bytes) values (${other}, 'image/svg+xml', '\\x00')`)).rejects.toThrow();
  });

  it("il cambio d'email: al più UNA richiesta pendente; una confermata o annullata non conta", async () => {
    const id = await person();
    const at = new Date(Date.now() + 86_400_000);
    const [first] = await t.db.insert(emailChanges).values({ userId: id, newEmail: "a@acme.com", tokenHash: randomUUID(), expiresAt: at }).returning();
    await expect(t.db.insert(emailChanges).values({ userId: id, newEmail: "b@acme.com", tokenHash: randomUUID(), expiresAt: at })).rejects.toThrow();
    await t.db.update(emailChanges).set({ cancelledAt: new Date() }).where(eq(emailChanges.id, first!.id));
    await t.db.insert(emailChanges).values({ userId: id, newEmail: "b@acme.com", tokenHash: randomUUID(), expiresAt: at });
  });
});
