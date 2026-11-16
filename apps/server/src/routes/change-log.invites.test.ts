import { randomUUID } from "node:crypto";
import { changeLog, invites, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { inviteIdOf } from "../services/admin-people.js";
import { seedUsers } from "../test/fixtures.js";

/** Area 9, F2, Task 5: il registro su inviti e primo avvio. Mai il token in una voce. */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

const build = (onDb: Db) => buildApp({ db: onDb, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 8).toString("base64") });

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = build(db);
  ({ adminCookie } = await seedUsers(app));
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const ofType = (type: string) => db.select().from(changeLog).where(eq(changeLog.type, type)).orderBy(desc(changeLog.at));
let ip = 0;
const fromNewIp = () => `10.7.${Math.floor(++ip / 250)}.${ip % 250}`;

describe("il registro: gli inviti", () => {
  it("creato (con i progetti e i ruoli per nome), revocato dalle due rotte, accettato; mai il token", async () => {
    const { projectId } = await seedRepository(db);
    const [dev] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
    const email = `inv-${randomUUID().slice(0, 6)}@acme.com`;
    const created = await app.inject({ method: "POST", url: "/api/auth/invites", headers: { cookie: adminCookie }, payload: { email, projects: [{ projectId, roleId: dev!.id }] } });
    expect(created.statusCode).toBe(201);
    const token = (created.json() as { token: string }).token;
    const [c] = await ofType("invite.created");
    expect(c).toMatchObject({ actorUserId: adminId, subjectKind: "invite", subjectId: inviteIdOf(token) });
    expect(c!.data).toMatchObject({ object: { type: "invite", label: email }, params: { instanceRole: "User", projects: [expect.stringMatching(/ · Developer$/)] } });
    // Revocato dalla rotta vecchia.
    expect((await app.inject({ method: "DELETE", url: `/api/auth/invites/${token}`, headers: { cookie: adminCookie } })).statusCode).toBe(204);
    const [r1] = await ofType("invite.revoked");
    expect(r1).toMatchObject({ subjectId: inviteIdOf(token) });
    // Revocato dalla rotta nuova, con l'id opaco.
    const second = (await app.inject({ method: "POST", url: "/api/auth/invites", headers: { cookie: adminCookie }, payload: { email: `two-${randomUUID().slice(0, 6)}@acme.com` } })).json() as { token: string };
    expect((await app.inject({ method: "DELETE", url: `/api/admin/invites/${inviteIdOf(second.token)}`, headers: { cookie: adminCookie } })).statusCode).toBe(204);
    expect((await ofType("invite.revoked")).map((e) => e.subjectId)).toContain(inviteIdOf(second.token));
    // Accettato: l'attore è chi entra.
    const third = (await app.inject({ method: "POST", url: "/api/auth/invites", headers: { cookie: adminCookie }, payload: { email: `three-${randomUUID().slice(0, 6)}@acme.com` } })).json() as { token: string };
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { token: third.token, password: "una-password-lunga-123" }, remoteAddress: fromNewIp() });
    expect(reg.statusCode).toBe(201);
    const [a] = await ofType("invite.accepted");
    expect(a).toMatchObject({ actorUserId: (reg.json() as { user: { id: string } }).user.id, subjectId: inviteIdOf(third.token) });
    const all = JSON.stringify(await db.select().from(changeLog));
    for (const t of [token, second.token, third.token]) expect(all).not.toContain(t);
  });

  it("una creazione rifiutata (escalation) non lascia la voce", async () => {
    const [mgr] = await db.insert(roles).values({ name: `Inv ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["users.invite"] }).returning({ id: roles.id });
    const [admin] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "admin"));
    const [u] = await db.insert(users).values({ email: `m-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    await db.update(users).set({ instanceRoleId: mgr!.id }).where(eq(users.id, u!.id));
    const { fullSessionCookie } = await import("../test/fixtures.js");
    const cookie = await fullSessionCookie(app, u!.id);
    const before = (await ofType("invite.created")).length;
    const res = await app.inject({ method: "POST", url: "/api/auth/invites", headers: { cookie }, payload: { email: `x-${randomUUID().slice(0, 6)}@acme.com`, instanceRoleId: admin!.id } });
    expect(res.statusCode).toBe(403);
    expect(await ofType("invite.created")).toHaveLength(before);
    expect(await db.select().from(invites).where(eq(invites.invitedByUserId, u!.id))).toHaveLength(0);
  });
});

describe("il registro: il primo avvio", () => {
  it("instance.first_admin_created, con l'attore di sistema", async () => {
    const fresh = await startTestDb();
    const freshApp = build(fresh.db);
    try {
      const res = await freshApp.inject({ method: "POST", url: "/api/auth/setup", payload: { email: "first@acme.com", password: "una-password-lunga-123" }, remoteAddress: fromNewIp() });
      expect(res.statusCode).toBe(201);
      const [e] = await fresh.db.select().from(changeLog).where(eq(changeLog.type, "instance.first_admin_created"));
      expect(e).toMatchObject({ actorKind: "system", actorUserId: null });
      expect(e!.data).toMatchObject({ object: { type: "person", label: "first@acme.com" } });
    } finally {
      await freshApp.close();
      await fresh.stop();
    }
  }, 120_000);
});
