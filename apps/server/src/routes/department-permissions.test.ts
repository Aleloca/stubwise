import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { departmentMembers, departmentProjectPermissions, departments, projectMembers, roles, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { projectPermissionsOfUser } from "@stubwise/notifications";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F8, Task 1 (0196, F8-1 = a): un reparto dà i suoi permessi di
 * PROGETTO ai suoi membri, in ogni progetto di cui sono GIÀ membri. Il calcolo
 * è UNO (`memberPermissionsSql`): gate, `/api/auth/me`, conteggio dei gestori,
 * routing delle notifiche lo seguono da soli. Un reparto non rende membri di
 * niente, e Claude non riceve mai permessi.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let dev: U;
let inProject: string;
let outside: string;
let departmentId: string;
const GIVEN = "project.members.manage";

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), publicUrl: "https://stubwise.example" });
  await seedUsers(app);
  ({ projectId: inProject } = await seedRepository(t.db));
  ({ projectId: outside } = await seedRepository(t.db));
  dev = await createUserWithSession(app, "dev-f8@example.com");
  await addMember(app, inProject, dev.id, "developer");
  const [d] = await t.db.insert(departments).values({ name: "Design F8", colorToken: "--dept-2" }).returning();
  departmentId = d!.id;
  await t.db.insert(departmentProjectPermissions).values({ departmentId, permission: GIVEN });
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const me = async (u: U) => (await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: u.headers.cookie } })).json() as { projectPermissions: Record<string, string[]> };
const canManage = async (u: U) =>
  ((await app.inject({ method: "GET", url: `/api/projects/${inProject}/members/view`, headers: { cookie: u.headers.cookie } })).json() as { canManage: boolean }).canManage;

describe("area 9, F8: i permessi di progetto di un reparto", () => {
  it("il Developer, senza il reparto, non gestisce i membri (il ruolo non lo dà)", async () => {
    const [devRole] = await t.db.select({ permissions: roles.permissions }).from(roles).where(eq(roles.presetKey, "developer"));
    expect(devRole!.permissions).not.toContain(GIVEN);
    expect((await me(dev)).projectPermissions[inProject]).not.toContain(GIVEN);
    expect(await canManage(dev)).toBe(false);
  });

  it("entrato nel reparto lo riceve nel progetto di cui è membro (gate, /me, routing), e uscendo lo perde", async () => {
    await t.db.insert(departmentMembers).values({ departmentId, userId: dev.id });
    expect((await me(dev)).projectPermissions[inProject]).toContain(GIVEN);
    expect(await canManage(dev)).toBe(true);
    expect([...((await projectPermissionsOfUser(t.db, dev.id, inProject)) ?? [])]).toContain(GIVEN);
    await t.db.delete(departmentMembers).where(and(eq(departmentMembers.departmentId, departmentId), eq(departmentMembers.userId, dev.id)));
    expect((await me(dev)).projectPermissions[inProject]).not.toContain(GIVEN);
    expect(await canManage(dev)).toBe(false);
  });

  it("un reparto non rende membri: nel progetto di cui non è membro non vede niente", async () => {
    await t.db.insert(departmentMembers).values({ departmentId, userId: dev.id }).onConflictDoNothing();
    expect((await me(dev)).projectPermissions[outside]).toBeUndefined();
    expect(await projectPermissionsOfUser(t.db, dev.id, outside)).toBeNull();
    const res = await app.inject({ method: "GET", url: `/api/projects/${outside}/members/view`, headers: { cookie: dev.headers.cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("NEGATIVO Claude: l'utente di sistema in un reparto non ne riceve i permessi (R-L9)", async () => {
    const [agent] = await t.db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    const [devRole] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
    await t.db.insert(projectMembers).values({ projectId: inProject, userId: agent!.id, roleId: devRole!.id }).onConflictDoNothing();
    await t.db.insert(departmentMembers).values({ departmentId, userId: agent!.id }).onConflictDoNothing();
    expect([...((await projectPermissionsOfUser(t.db, agent!.id, inProject)) ?? [])]).not.toContain(GIVEN);
  });
});
